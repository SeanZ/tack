#!/usr/bin/env bun
import { cac } from "cac";
import lockfile from "proper-lockfile";
import { join, dirname, basename } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";

// Code/assets travel with the script (bin/.. = repo root); data + config live
// under ~/.tack so the tool can be shared without dragging personal data along.
const CODE_ROOT = join(import.meta.dir, "..");
const TACK_HOME = process.env.TACK_HOME ?? `${process.env.HOME}/.tack`;
const CONFIG_FILE = join(TACK_HOME, "config.json");
// DATA_ROOT resolved at startup: TACK_DATA_DIR env > config.data_dir > ~/.tack/data
const DATA_ROOT = resolveDataRoot();
const TASKS_FILE = join(DATA_ROOT, "tasks.jsonl");
const TASKS_DIR = join(DATA_ROOT, "tasks");

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p;
}

function resolveDataRoot(): string {
  if (process.env.TACK_DATA_DIR) return process.env.TACK_DATA_DIR;
  try {
    if (existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      if (cfg?.data_dir) return expandHome(cfg.data_dir);
    }
  } catch {
    /* malformed config: fall through to default */
  }
  return join(TACK_HOME, "data");
}

type Box = "inbox" | "processing" | "backlog" | "archived";
// Agent / Target are free-form strings. `cc` and `self` are built-in concepts
// (cc has native session hooks; self = the user). Any other agent (a relay AI,
// another IDE, …) is declared per-machine in config.agents — the tool stays
// agent-agnostic; the list of agents you collaborate with is private context.
type Agent = string;
type Target = string;

const BOXES: Box[] = ["inbox", "processing", "backlog", "archived"];
const BUILTIN_AGENTS = ["cc"];
const BUILTIN_TARGETS = ["cc", "self"];

// Known agents/targets = built-ins ∪ config.agents. Only WRITE paths
// (add --target / set target= / link --agent) validate against these; reads
// and derivation never validate, so existing data with any value is safe.
function knownAgents(cfg: any): string[] {
  return [...BUILTIN_AGENTS, ...(Array.isArray(cfg?.agents) ? cfg.agents : [])];
}
function knownTargets(cfg: any): string[] {
  return [...BUILTIN_TARGETS, ...(Array.isArray(cfg?.agents) ? cfg.agents : [])];
}

interface SessionLink {
  uuid: string;
  agent: Agent;
  started_at: string;
  transcript_path?: string;
}

interface Task {
  id: string;
  title: string;
  state: Box;
  tags: string[];
  repo?: string;
  contribution_target?: Target;
  ref?: string;
  handoff_path?: string;
  notes: { at: string; text: string }[];
  sessions: SessionLink[];
  created_at: string;
  updated_at: string;
}

// ---- Helpers ----

function die(msg: string, code = 1): never {
  console.error(`tack: ${msg}`);
  process.exit(code);
}

function isoNow(): string {
  return new Date().toISOString();
}

function todayYYMMDD(): string {
  const d = new Date();
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// Local-date key (YYYY-MM-DD) — lexicographic order matches chronological order.
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dayKeyOf(iso: string): string {
  return ymd(new Date(iso));
}
// Monday of the week containing d, at local midnight.
function mondayKeyOf(iso: string): string {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return ymd(d);
}

async function loadTasks(): Promise<Task[]> {
  if (!existsSync(TASKS_FILE)) return [];
  const file = Bun.file(TASKS_FILE);
  const text = await file.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .map((l, i) => {
      try {
        return JSON.parse(l) as Task;
      } catch (e) {
        die(`corrupt tasks.jsonl at line ${i + 1}: ${e}`);
      }
    });
}

async function saveTasks(tasks: Task[]): Promise<void> {
  if (!existsSync(TASKS_FILE)) {
    mkdirSync(dirname(TASKS_FILE), { recursive: true });
    await Bun.write(TASKS_FILE, "");
  }
  const release = await lockfile.lock(TASKS_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 300 },
  });
  try {
    const content = tasks.map((t) => JSON.stringify(t)).join("\n");
    await Bun.write(TASKS_FILE, content + (content ? "\n" : ""));
  } finally {
    await release();
  }
}

async function loadConfig(): Promise<any> {
  if (!existsSync(CONFIG_FILE)) return {};
  return await Bun.file(CONFIG_FILE).json();
}

// Effective contribution target (agent-agnostic; no agent name hardcoded):
//   1. explicit contribution_target wins
//   2. else first `awaiting:<agent>` tag where agent != "review" → that agent
//      (awaiting:review is a status, not an agent, so it never derives)
//   3. else if the task carries a handoff signal (handoff_path set, or the
//      generic `ai-handoff` tag) → config.default_handoff_target, if configured
// Remove the signal and the derived target disappears. The agent a bare handoff
// defaults to is private config, not a literal in the engine.
function effectiveTarget(t: Task, cfg?: any): { value?: Target; derived: boolean } {
  if (t.contribution_target) return { value: t.contribution_target, derived: false };
  const awaiting = t.tags.find((g) => g.startsWith("awaiting:"));
  if (awaiting) {
    const who = awaiting.slice("awaiting:".length);
    if (who && who !== "review") return { value: who, derived: true };
  }
  const hasHandoffSignal = !!t.handoff_path || t.tags.includes("ai-handoff");
  if (hasHandoffSignal && cfg?.default_handoff_target)
    return { value: cfg.default_handoff_target, derived: true };
  return { value: undefined, derived: false };
}

async function nextTaskId(tasks: Task[]): Promise<string> {
  const prefix = `T${todayYYMMDD()}-`;
  const nums = tasks
    .filter((t) => t.id.startsWith(prefix))
    .map((t) => parseInt(t.id.slice(prefix.length), 10))
    .filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(2, "0")}`;
}

function findTask(idOrPrefix: string, tasks: Task[]): Task {
  const exact = tasks.find((t) => t.id === idOrPrefix);
  if (exact) return exact;
  const lower = idOrPrefix.toLowerCase();
  const matches = tasks.filter((t) => t.id.toLowerCase().includes(lower));
  if (matches.length === 0) die(`no task matching: ${idOrPrefix}`);
  if (matches.length > 1)
    die(`ambiguous ${idOrPrefix}: ${matches.map((m) => m.id).join(", ")}`);
  return matches[0];
}

function ensureBox(box: string): Box {
  if (!BOXES.includes(box as Box)) die(`invalid box: ${box} (valid: ${BOXES.join("/")})`);
  return box as Box;
}

function ensureAgent(s: string, cfg: any): Agent {
  const known = knownAgents(cfg);
  if (!known.includes(s)) die(`unknown agent: ${s} (valid: ${known.join("/")}; add more to config.agents)`);
  return s;
}

function shortTags(tags: string[]): string {
  return tags.length ? " " + tags.map((t) => `#${t}`).join(" ") : "";
}

function resolveRepo(repoArg: string | undefined, cfg: any): string | undefined {
  if (!repoArg) return undefined;
  const aliased = cfg?.repos?.[repoArg];
  if (aliased) return aliased;
  // 不是别名,当绝对路径
  return repoArg;
}

function shellQuote(s: string): string {
  // safe-char shortcut
  if (/^[a-zA-Z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function shortUuid(uuid: string): string {
  return uuid.length > 12 ? uuid.slice(0, 8) : uuid;
}

const PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;

// CC encodes a project cwd into a dir name by replacing "/" with "-".
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/\//g, "-");
}

// Build reverse map: encoded-project-dir -> repo alias (from config.repos).
function repoAliasForProjectDir(dirName: string, cfg: any): string {
  const repos = cfg?.repos ?? {};
  for (const [alias, path] of Object.entries(repos)) {
    if (encodeProjectDir(path as string) === dirName) return alias;
  }
  return dirName; // unknown -> raw encoded path
}

// In-session, CC exposes its session uuid to subprocesses via CLAUDE_CODE_SESSION_ID.
// Derive the transcript path from the uuid + cwd using CC's project-dir encoding.
function resolveCurrentSession(): { uuid: string; transcriptPath?: string } | null {
  const uuid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!uuid) return null;
  const p = join(PROJECTS_DIR, encodeProjectDir(process.cwd()), `${uuid}.jsonl`);
  return { uuid, transcriptPath: existsSync(p) ? p : undefined };
}

// Idempotently attach a session to a task (in memory; caller saves). Returns
// true if it was a new link, false if already present (transcript path refreshed).
function linkSession(task: Task, uuid: string, agent: Agent, transcriptPath?: string): boolean {
  const existing = task.sessions.find((s) => s.uuid === uuid);
  if (existing) {
    if (transcriptPath) existing.transcript_path = transcriptPath;
    return false;
  }
  task.sessions.push({ uuid, agent, started_at: isoNow(), transcript_path: transcriptPath });
  return true;
}

// Read first ~64KB of a transcript and pull the first real user prompt.
async function firstPromptOf(path: string): Promise<string> {
  try {
    const slice = Bun.file(path).slice(0, 65536);
    const text = await slice.text();
    for (const line of text.split("\n").slice(0, 20)) {
      if (!line.trim()) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.type !== "user") continue;
      const c = d.message?.content;
      let t = "";
      if (typeof c === "string") t = c;
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "text" && b.text) {
            t = b.text;
            break;
          }
        }
      }
      t = t.trim();
      if (t && !t.startsWith("<") && !t.startsWith("Caveat")) {
        return t.replace(/\s+/g, " ").slice(0, 120);
      }
    }
  } catch {
    /* ignore */
  }
  return "(no prompt)";
}

// ---- Commands ----

const cli = cac("tack");

cli.command("init", "Initialize ~/.tack home + data dir (idempotent)").action(async () => {
  mkdirSync(TACK_HOME, { recursive: true });
  mkdirSync(DATA_ROOT, { recursive: true });
  mkdirSync(TASKS_DIR, { recursive: true });
  if (!existsSync(TASKS_FILE)) await Bun.write(TASKS_FILE, "");
  if (!existsSync(CONFIG_FILE)) {
    await Bun.write(
      CONFIG_FILE,
      JSON.stringify(
        {
          data_dir: DATA_ROOT,
          default_target: "cc",
          repos: {},
        },
        null,
        2
      ) + "\n"
    );
  }
  // make the data dir its own git repo so task history is versioned independently
  // of the tool's source — add a private remote and push to back it up.
  if (!existsSync(join(DATA_ROOT, ".git"))) {
    try {
      await Bun.$`git -C ${DATA_ROOT} init -q`.quiet();
    } catch {
      /* git optional */
    }
  }
  console.log(`tack home ready at ${TACK_HOME}`);
  console.log(`  config: ${CONFIG_FILE}`);
  console.log(`  data:   ${DATA_ROOT} (git-managed; add a private remote + push to back up)`);
});

cli
  .command("add <title>", "Add a new task")
  .option("--tag <tags>", "Comma-separated tags")
  .option("--repo <repo>", "Repo alias or path")
  .option("--target <target>", "Contribution target (cc/self built-in; others from config.agents)")
  .option("--ref <url>", "External reference URL")
  .option("--box <box>", "Initial box (default: inbox)")
  .option("--json", "Output JSON")
  .action(async (title: string, opts: any) => {
    const tasks = await loadTasks();
    const cfg = await loadConfig();
    const box: Box = opts.box ? ensureBox(opts.box) : "inbox";
    if (opts.target && !knownTargets(cfg).includes(opts.target))
      die(`unknown target: ${opts.target} (valid: ${knownTargets(cfg).join("/")}; add more to config.agents)`);
    const tags = opts.tag
      ? opts.tag
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : [];
    const id = await nextTaskId(tasks);
    const now = isoNow();
    const task: Task = {
      id,
      title,
      state: box,
      tags,
      repo: opts.repo,
      contribution_target: opts.target,
      ref: opts.ref,
      notes: [],
      sessions: [],
      created_at: now,
      updated_at: now,
    };
    tasks.push(task);
    await saveTasks(tasks);
    if (opts.json) console.log(JSON.stringify(task));
    else
      console.log(
        `+ ${id} [${box}] ${title}${shortTags(tags)}${opts.repo ? " @" + opts.repo : ""}`
      );
  });

cli
  .command("ls [box]", "List tasks (default: inbox+processing)")
  .option("--tag <tag>", "Filter by tag")
  .option("--repo <repo>", "Filter by repo")
  .option("--target <target>", "Filter by contribution target")
  .option("--all", "Include all boxes")
  .option("--json", "Output JSON")
  .action(async (box: string | undefined, opts: any) => {
    let tasks = await loadTasks();
    const cfg = await loadConfig();
    if (opts.all) {
      // no filter
    } else if (box === "active" || (!box && !opts.all)) {
      tasks = tasks.filter((t) => t.state === "inbox" || t.state === "processing");
    } else if (box) {
      ensureBox(box);
      tasks = tasks.filter((t) => t.state === box);
    }
    if (opts.tag) tasks = tasks.filter((t) => t.tags.includes(opts.tag));
    if (opts.repo) tasks = tasks.filter((t) => t.repo === opts.repo);
    if (opts.target) tasks = tasks.filter((t) => effectiveTarget(t, cfg).value === opts.target);
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    if (opts.json) {
      console.log(JSON.stringify(tasks));
      return;
    }
    if (tasks.length === 0) {
      console.log("(no tasks)");
      return;
    }
    for (const t of tasks) {
      const sessionStr = t.sessions.length ? ` (${t.sessions.length}s)` : "";
      const repoStr = t.repo ? ` @${t.repo}` : "";
      console.log(
        `${t.id}  [${t.state.padEnd(10)}]  ${t.title}${repoStr}${shortTags(t.tags)}${sessionStr}`
      );
    }
  });

cli
  .command("show <id>", "Show task details")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: any) => {
    const tasks = await loadTasks();
    const cfg = await loadConfig();
    const task = findTask(id, tasks);
    if (opts.json) {
      console.log(JSON.stringify(task));
      return;
    }
    console.log(`# ${task.id}: ${task.title}`);
    console.log(`State:    ${task.state}`);
    if (task.repo) console.log(`Repo:     ${task.repo}`);
    {
      const et = effectiveTarget(task, cfg);
      if (et.value) console.log(`Target:   ${et.value}${et.derived ? " (derived from handoff signal)" : ""}`);
    }
    if (task.ref) console.log(`Ref:      ${task.ref}`);
    if (task.handoff_path) console.log(`Handoff:  ${task.handoff_path}`);
    if (task.tags.length) console.log(`Tags:     ${task.tags.map((t) => "#" + t).join(" ")}`);
    console.log(`Created:  ${task.created_at}`);
    console.log(`Updated:  ${task.updated_at}`);
    if (task.sessions.length) {
      console.log(`\nSessions (${task.sessions.length}):`);
      for (const s of task.sessions) {
        // lazy digest: generate on read when missing and transcript still on disk
        if (!existsSync(digestPathOf(task, s.uuid)) && s.transcript_path && existsSync(s.transcript_path)) {
          await buildDigest(task, s.uuid, s.transcript_path).catch(() => {});
        }
        const dg = existsSync(digestPathOf(task, s.uuid)) ? "  ✓digest" : "";
        console.log(`  - [${s.agent}] ${s.uuid}  ${s.started_at}${dg}`);
      }
    }
    if (task.notes.length) {
      console.log(`\nNotes (${task.notes.length}):`);
      for (const n of task.notes) {
        console.log(`  [${n.at}] ${n.text}`);
      }
    }
  });

cli.command("mv <id> <box>", "Move task to box").action(async (id: string, box: string) => {
  const target = ensureBox(box);
  const tasks = await loadTasks();
  const task = findTask(id, tasks);
  const prev = task.state;
  task.state = target;
  task.updated_at = isoNow();
  await saveTasks(tasks);
  let extra = "";
  if (target === "archived" && prev !== "archived") {
    const n = await digestMissingSessions(task); // closing snapshot into the data repo
    if (n) extra = ` · digested ${n} session(s)`;
  }
  console.log(`${task.id}: ${prev} → ${target}${extra}`);
});

cli
  .command("tag <id> [...tags]", "Add tags (no args: list current tags)")
  .action(async (id: string, tags: string[]) => {
    const tasks = await loadTasks();
    const task = findTask(id, tasks);
    if (!tags.length) {
      console.log(`${task.id} tags:${shortTags(task.tags)}`);
      return;
    }
    for (const t of tags) {
      if (!t) die(`empty tag`);
      if (!task.tags.includes(t)) task.tags.push(t);
    }
    task.updated_at = isoNow();
    await saveTasks(tasks);
    console.log(`${task.id} tags:${shortTags(task.tags)}`);
  });

cli
  .command("untag <id> [...tags]", "Remove tags")
  .action(async (id: string, tags: string[]) => {
    if (!tags.length) die(`no tags to remove`);
    const tasks = await loadTasks();
    const task = findTask(id, tasks);
    for (const t of tags) {
      task.tags = task.tags.filter((x) => x !== t);
    }
    task.updated_at = isoNow();
    await saveTasks(tasks);
    console.log(`${task.id} tags:${shortTags(task.tags)}`);
  });

cli.command("note <id> <text>", "Append a progress note").action(async (id: string, text: string) => {
  const tasks = await loadTasks();
  const task = findTask(id, tasks);
  const at = isoNow();
  task.notes.push({ at, text });
  // a note means "I'm working on this" → auto-link the current CC session to the task
  const cur = resolveCurrentSession();
  const linked = cur ? linkSession(task, cur.uuid, "cc", cur.transcriptPath) : false;
  task.updated_at = at;
  await saveTasks(tasks);
  console.log(
    `${task.id}: note added (${task.notes.length} total)` +
      (linked ? ` · linked session ${shortUuid(cur!.uuid)}` : "")
  );
});

const ALLOWED_SET_KEYS = new Set([
  "repo",
  "contribution_target",
  "ref",
  "handoff_path",
  "title",
  "state",
]);

cli.command("set <id> [...kvs]", "Set fields (e.g. repo=tq target=self state=processing)").action(
  async (id: string, kvs: string[]) => {
    if (!kvs.length) die(`no key=value pairs given`);
    const tasks = await loadTasks();
    const cfg = await loadConfig();
    const task = findTask(id, tasks);
    const prevState = task.state;
    for (const kv of kvs) {
      const eq = kv.indexOf("=");
      if (eq === -1) die(`need key=value: ${kv}`);
      let k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (k === "target") k = "contribution_target";
      if (!ALLOWED_SET_KEYS.has(k)) die(`unsupported field: ${k}`);
      if (k === "state") ensureBox(v);
      if (k === "contribution_target" && !knownTargets(cfg).includes(v))
        die(`unknown target: ${v} (valid: ${knownTargets(cfg).join("/")}; add more to config.agents)`);
      (task as any)[k] = v;
    }
    task.updated_at = isoNow();
    await saveTasks(tasks);
    let extra = "";
    if (task.state === "archived" && prevState !== "archived") {
      const n = await digestMissingSessions(task);
      if (n) extra = ` · digested ${n} session(s)`;
    }
    console.log(`${task.id}: updated${extra}`);
  }
);

cli
  .command("link", "Link a session to a task (idempotent; used by hooks)")
  .option("--task <id>", "Task ID")
  .option("--session <uuid>", "Session UUID")
  .option("--agent <agent>", "Agent (cc built-in; others from config.agents)", { default: "cc" })
  .option("--transcript-path <path>", "Transcript file path")
  .action(async (opts: any) => {
    if (!opts.task) die(`--task required`);
    const cur = resolveCurrentSession();
    const uuid = opts.session ?? cur?.uuid;
    if (!uuid) die(`--session required (or run inside a CC session)`);
    const transcriptPath =
      opts.transcriptPath ?? (uuid === cur?.uuid ? cur?.transcriptPath : undefined);
    const cfg = await loadConfig();
    const agent = ensureAgent(opts.agent, cfg);
    const tasks = await loadTasks();
    const task = findTask(opts.task, tasks);
    const isNew = linkSession(task, uuid, agent, transcriptPath);
    task.updated_at = isoNow();
    await saveTasks(tasks);
    console.log(
      `${task.id}: session ${shortUuid(uuid)} ${isNew ? "linked" : "already linked (updated)"} (${agent})`
    );
  });

function digestPathOf(task: Task, uuid: string): string {
  return join(TASKS_DIR, task.id, "digests", `${uuid}.md`);
}

// Parse a transcript and write a digest card. Pure: writes the file and returns
// stats; does NOT touch tasks.jsonl (callers decide whether to note/save).
async function buildDigest(
  task: Task,
  uuid: string,
  transcript: string
): Promise<{ path: string; filesEdited: number; commands: number } | null> {
  if (!existsSync(transcript)) return null;
  const text = await Bun.file(transcript).text();
  const lines = text.trim().split("\n");
  let firstPrompt = "";
  let lastAssistant = "";
  const filesEdited = new Set<string>();
  const commandsRun: string[] = [];

  for (const line of lines) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    // user message: capture first non-meta text
    if (d.type === "user" && !firstPrompt) {
      const content = d.message?.content;
      let t = "";
      if (typeof content === "string") t = content;
      else if (Array.isArray(content)) {
        for (const blk of content) {
          if (blk.type === "text" && blk.text) {
            t = blk.text;
            break;
          }
        }
      }
      // skip system reminders / tool results
      if (t && !t.startsWith("<") && !t.startsWith("[")) firstPrompt = t.slice(0, 500);
    }
    // assistant message
    if (d.type === "assistant" && d.message?.content) {
      const content = d.message.content;
      if (Array.isArray(content)) {
        for (const blk of content) {
          if (blk.type === "text" && blk.text) lastAssistant = blk.text;
          if (blk.type === "tool_use") {
            const name = blk.name;
            const input = blk.input ?? {};
            if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
              if (input.file_path) filesEdited.add(input.file_path);
            }
            if (name === "Bash" && input.command) {
              commandsRun.push(String(input.command).slice(0, 120));
            }
          }
        }
      }
    }
  }

  const digestPath = digestPathOf(task, uuid);
  mkdirSync(dirname(digestPath), { recursive: true });

  const truncatedAssistant = lastAssistant
    ? lastAssistant.slice(0, 1500) + (lastAssistant.length > 1500 ? "\n\n...(truncated)" : "")
    : "(none)";

  const md = [
    `# Session digest — ${shortUuid(uuid)}`,
    ``,
    `- **Task**: ${task.id} — ${task.title}`,
    `- **UUID**: ${uuid}`,
    `- **Generated**: ${isoNow()}`,
    `- **Transcript**: ${transcript}`,
    ``,
    `## First user prompt`,
    ``,
    firstPrompt ? `> ${firstPrompt.replace(/\n/g, "\n> ")}` : `_(none detected)_`,
    ``,
    `## Last assistant text`,
    ``,
    truncatedAssistant,
    ``,
    `## Files edited (${filesEdited.size})`,
    ``,
    filesEdited.size ? [...filesEdited].map((f) => `- ${f}`).join("\n") : `_(none)_`,
    ``,
    `## Bash commands (${commandsRun.length}, first 15)`,
    ``,
    commandsRun.length ? commandsRun.slice(0, 15).map((c) => `- \`${c}\``).join("\n") : `_(none)_`,
    ``,
  ].join("\n");

  await Bun.write(digestPath, md);
  return { path: digestPath, filesEdited: filesEdited.size, commands: commandsRun.length };
}

// Generate digests for a task's sessions that don't have one yet (transcript
// still on disk). Used by `show` (lazy) and archive (closing snapshot).
async function digestMissingSessions(task: Task): Promise<number> {
  let n = 0;
  for (const s of task.sessions) {
    if (existsSync(digestPathOf(task, s.uuid))) continue;
    if (!s.transcript_path || !existsSync(s.transcript_path)) continue;
    const r = await buildDigest(task, s.uuid, s.transcript_path).catch(() => null);
    if (r) n++;
  }
  return n;
}

cli
  .command("digest", "Generate a session digest (used by SessionEnd hook)")
  .option("--task <id>", "Task ID")
  .option("--session <uuid>", "Session UUID")
  .option("--transcript <path>", "Transcript jsonl path")
  .action(async (opts: any) => {
    if (!opts.task) die(`--task required`);
    const cur = resolveCurrentSession();
    const uuid = opts.session ?? cur?.uuid;
    if (!uuid) die(`--session required`);
    const tasks = await loadTasks();
    const task = findTask(opts.task, tasks);
    const linked = task.sessions.find((s) => s.uuid === uuid);
    const transcript =
      opts.transcript ??
      (uuid === cur?.uuid ? cur?.transcriptPath : undefined) ??
      linked?.transcript_path;
    if (!transcript) die(`--transcript required (no known transcript for ${shortUuid(uuid)})`);
    const res = await buildDigest(task, uuid, transcript);
    if (!res) die(`transcript not found: ${transcript}`);
    task.notes.push({
      at: isoNow(),
      text: `[digest] session ${shortUuid(uuid)}: edited ${res.filesEdited} files, ${res.commands} bash commands`,
    });
    task.updated_at = isoNow();
    await saveTasks(tasks);
    console.log(`${task.id}: digest → ${res.path}`);
  });

cli
  .command("brief <id>", "Print a compact task brief for context injection (used by SessionStart hook)")
  .action(async (id: string) => {
    const tasks = await loadTasks();
    const cfg = await loadConfig();
    const task = findTask(id, tasks);
    const lines: string[] = [];
    lines.push(`# tack task ${task.id} — ${task.title}`);
    const et = effectiveTarget(task, cfg);
    lines.push(`state: ${task.state}` + (task.repo ? ` · repo: ${task.repo}` : "") +
      (et.value ? ` · target: ${et.value}` : ""));
    if (task.tags.length) lines.push(`tags: ${task.tags.map((t) => "#" + t).join(" ")}`);
    if (task.ref) lines.push(`ref: ${task.ref}`);
    if (task.handoff_path) lines.push(`handoff: ${task.handoff_path}`);
    if (task.sessions.length > 1) {
      lines.push(`prior sessions: ${task.sessions.length}`);
    }
    const recent = task.notes.slice(-5);
    if (recent.length) {
      lines.push(`recent notes:`);
      for (const n of recent) lines.push(`  - ${n.text}`);
    }
    lines.push(`(管理本任务用 tack 命令; 收尾时说"归档当前会话"即可记录进度)`);
    console.log(lines.join("\n"));
  });

cli
  .command("which <uuid>", "Print the task id that owns a session uuid (prefix match), or nothing")
  .option("--json", "Output JSON")
  .action(async (uuid: string, opts: any) => {
    const tasks = await loadTasks();
    const owners = tasks.filter((t) => t.sessions.some((s) => s.uuid.startsWith(uuid)));
    if (opts.json) {
      console.log(JSON.stringify(owners.map((t) => ({ id: t.id, title: t.title, state: t.state }))));
      return;
    }
    for (const t of owners) console.log(`${t.id}\t${t.state}\t${t.title}`);
  });

cli
  .command("scan", "List CC sessions not yet linked to any task")
  .option("--repo <repo>", "Filter by repo alias")
  .option("--limit <n>", "Max sessions to show (default 30)")
  .option("--json", "Output JSON")
  .action(async (opts: any) => {
    const cfg = await loadConfig();
    const tasks = await loadTasks();
    const linked = new Set<string>();
    for (const t of tasks) for (const s of t.sessions) linked.add(s.uuid);

    if (!existsSync(PROJECTS_DIR)) die(`no projects dir: ${PROJECTS_DIR}`);

    type Orphan = { uuid: string; repo: string; mtime: number; mtimeStr: string; path: string };
    const orphans: Orphan[] = [];
    for (const dirName of readdirSync(PROJECTS_DIR)) {
      const dirPath = join(PROJECTS_DIR, dirName);
      let isDir = false;
      try {
        isDir = statSync(dirPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const repo = repoAliasForProjectDir(dirName, cfg);
      if (opts.repo && repo !== opts.repo) continue;
      for (const f of readdirSync(dirPath)) {
        if (!f.endsWith(".jsonl")) continue;
        const uuid = f.slice(0, -6);
        if (linked.has(uuid)) continue;
        const p = join(dirPath, f);
        let mtime = 0;
        try {
          mtime = statSync(p).mtimeMs;
        } catch {
          continue;
        }
        orphans.push({
          uuid,
          repo,
          mtime,
          mtimeStr: new Date(mtime).toISOString().slice(0, 16).replace("T", " "),
          path: p,
        });
      }
    }

    orphans.sort((a, b) => b.mtime - a.mtime);
    const limit = opts.limit ? parseInt(opts.limit, 10) : 30;
    const shown = orphans.slice(0, limit);

    const enriched = [];
    for (const o of shown) {
      enriched.push({ ...o, prompt: await firstPromptOf(o.path) });
    }

    if (opts.json) {
      console.log(JSON.stringify(enriched.map(({ mtime, ...rest }) => rest)));
      return;
    }
    if (enriched.length === 0) {
      console.log("(no unlinked sessions)");
      return;
    }
    console.log(`${orphans.length} unlinked session(s), showing ${enriched.length}:\n`);
    for (const o of enriched) {
      console.log(`${shortUuid(o.uuid)}  ${o.repo.padEnd(10)}  ${o.mtimeStr}`);
      console.log(`   ${o.prompt}`);
    }
  });

cli
  .command("setup <target>", "Install hooks for an agent (target: cc)")
  .action(async (target: string) => {
    if (target === "cc") {
      await setupCc();
    } else {
      die(`unknown setup target: ${target} (only 'cc' supported)`);
    }
  });

async function setupCc(): Promise<void> {
  const SETTINGS = `${process.env.HOME}/.claude/settings.json`;
  const HOOK_DIR = join(CODE_ROOT, "hooks");
  const startHook = join(HOOK_DIR, "cc-session-start.sh");
  const endHook = join(HOOK_DIR, "cc-session-end.sh");
  if (!existsSync(startHook)) die(`missing ${startHook}`);
  if (!existsSync(endHook)) die(`missing ${endHook}`);

  let settings: any = {};
  if (existsSync(SETTINGS)) {
    const text = await Bun.file(SETTINGS).text();
    try {
      settings = JSON.parse(text);
    } catch (e) {
      die(`~/.claude/settings.json is not valid JSON: ${e}`);
    }
    // backup
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${SETTINGS}.bak-${ts}`;
    await Bun.write(backup, text);
    console.log(`backup → ${backup}`);
  }

  if (typeof settings.hooks !== "object" || settings.hooks === null) settings.hooks = {};
  const hooks = settings.hooks;

  const ensureHook = (event: string, command: string, label: string): boolean => {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const arr = hooks[event] as any[];
    // idempotency: if any entry has a hook whose command points at our script, skip
    const already = arr.some(
      (group) =>
        Array.isArray(group?.hooks) &&
        group.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(command))
    );
    if (already) {
      console.log(`${event}: tack hook already present, skipped`);
      return false;
    }
    arr.push({
      matcher: "",
      hooks: [{ type: "command", command, timeout: 10 }],
    });
    console.log(`${event}: + tack ${label}`);
    return true;
  };

  let changed = false;
  changed = ensureHook("SessionStart", startHook, "SessionStart") || changed;
  changed = ensureHook("SessionEnd", endHook, "SessionEnd") || changed;

  if (!changed) {
    console.log("nothing to do (all tack hooks already installed)");
    return;
  }

  await Bun.write(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log(`updated ${SETTINGS}`);
  console.log(`\nNext: inside a CC session, 'tack note <id> ...' auto-links the session;`);
  console.log(`SessionEnd then writes a best-effort digest, and resuming injects the task brief.`);
}

// Compute dashboard aggregates from the task list (server-side for /api/data).
function computeStats(tasks: Task[], cfg?: any) {
  const box: Record<string, number> = { inbox: 0, processing: 0, backlog: 0, archived: 0 };
  const repo: Record<string, number> = {};
  const lane: Record<string, number> = {};
  const target: Record<string, number> = {};
  let sessions = 0,
    notes = 0,
    multiSession = 0;
  const sessionDates: string[] = [];
  for (const t of tasks) {
    box[t.state] = (box[t.state] ?? 0) + 1;
    repo[t.repo || "(none)"] = (repo[t.repo || "(none)"] ?? 0) + 1;
    for (const g of t.tags) if (g.startsWith("lane:")) lane[g] = (lane[g] ?? 0) + 1;
    const et = effectiveTarget(t, cfg).value ?? "none";
    target[et] = (target[et] ?? 0) + 1;
    sessions += t.sessions.length;
    notes += t.notes.length;
    if (t.sessions.length > 1) multiSession++;
    for (const s of t.sessions) if (s.started_at) sessionDates.push(s.started_at);
  }
  sessionDates.sort();
  return {
    total: tasks.length,
    box,
    repo,
    lane,
    target,
    sessions,
    notes,
    multiSession,
    active: (box.inbox ?? 0) + (box.processing ?? 0),
    laneCount: Object.keys(lane).length,
    sessionSpan:
      sessionDates.length > 0
        ? { from: sessionDates[0], to: sessionDates[sessionDates.length - 1] }
        : null,
  };
}

// Throughput / burndown series for the dashboard chart.
// Buckets created (created_at) vs archived (archived state, by updated_at) per
// period, plus `open` = running count of not-yet-archived tasks (the burndown
// line). Returns daily (last 30d) and weekly (last 12w) windows.
function computeThroughput(tasks: Task[]) {
  type Ev = { created: number; archived: number };

  // Build a continuous, zero-filled series over `buckets` (sorted keys).
  // baseline open count = tasks opened before the window and not archived before it.
  const build = (keyOf: (iso: string) => string, buckets: string[]) => {
    const startKey = buckets[0];
    const map = new Map<string, Ev>();
    let baseOpen = 0;
    for (const t of tasks) {
      const ck = t.created_at ? keyOf(t.created_at) : null;
      const ak = t.state === "archived" && t.updated_at ? keyOf(t.updated_at) : null;
      if (ck) {
        if (ck < startKey) baseOpen++;
        else {
          const e = map.get(ck) ?? { created: 0, archived: 0 };
          e.created++;
          map.set(ck, e);
        }
      }
      if (ak) {
        if (ak < startKey) baseOpen--;
        else {
          const e = map.get(ak) ?? { created: 0, archived: 0 };
          e.archived++;
          map.set(ak, e);
        }
      }
    }
    let open = baseOpen;
    return buckets.map((key) => {
      const e = map.get(key) ?? { created: 0, archived: 0 };
      open += e.created - e.archived;
      return { key, created: e.created, archived: e.archived, open };
    });
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayBuckets: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dayBuckets.push(ymd(d));
  }

  const weekBuckets: string[] = [];
  const thisMonday = new Date(today);
  thisMonday.setDate(thisMonday.getDate() - ((thisMonday.getDay() + 6) % 7));
  for (let i = 11; i >= 0; i--) {
    const d = new Date(thisMonday);
    d.setDate(d.getDate() - i * 7);
    weekBuckets.push(ymd(d));
  }

  return {
    day: build(dayKeyOf, dayBuckets),
    week: build(mondayKeyOf, weekBuckets),
  };
}

cli
  .command("web", "Start a local dashboard server (foreground; Ctrl+C to stop)")
  .option("--port <n>", "Port to listen on")
  .option("--no-open", "Do not auto-open the browser")
  .action(async (opts: any) => {
    const cfg = await loadConfig();
    const port = opts.port ? parseInt(opts.port, 10) : cfg.web_port ?? 7420;
    const WEB_DIR = join(CODE_ROOT, "web");
    if (!existsSync(join(WEB_DIR, "index.html")))
      die(`web assets missing at ${WEB_DIR} (expected index.html / style.css / app.js)`);

    const staticFile = (name: string, type: string) => {
      const p = join(WEB_DIR, name);
      if (!existsSync(p)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(p), { headers: { "content-type": type } });
    };

    let server: any;
    try {
      server = Bun.serve({
        port,
        async fetch(req) {
          const url = new URL(req.url);
          switch (url.pathname) {
            case "/":
            case "/index.html":
              return staticFile("index.html", "text/html; charset=utf-8");
            case "/style.css":
              return staticFile("style.css", "text/css; charset=utf-8");
            case "/app.js":
              return staticFile("app.js", "text/javascript; charset=utf-8");
            case "/api/data": {
              const tasks = await loadTasks();
              const enriched = tasks.map((t) => ({
                ...t,
                effective_target: effectiveTarget(t, cfg),
                repo_path: resolveRepo(t.repo, cfg) ?? null,
              }));
              // throughput overall + broken down per lane (主线), so the chart can drill in
              const laneSet = new Set<string>();
              for (const t of tasks) for (const g of t.tags) if (g.startsWith("lane:")) laneSet.add(g);
              const lanes = [...laneSet].sort();
              const byLane: Record<string, ReturnType<typeof computeThroughput>> = {};
              for (const lane of lanes)
                byLane[lane] = computeThroughput(tasks.filter((t) => t.tags.includes(lane)));
              const throughput = { ...computeThroughput(tasks), lanes, byLane };
              const body = JSON.stringify({
                generated_at: new Date().toISOString(),
                stats: { ...computeStats(tasks, cfg), throughput },
                tasks: enriched,
              });
              return new Response(body, {
                headers: { "content-type": "application/json", "cache-control": "no-store" },
              });
            }
            default:
              return new Response("not found", { status: 404 });
          }
        },
      });
    } catch (e: any) {
      die(`failed to listen on :${port} — ${e?.message ?? e} (try tack web --port <other>)`);
    }

    const urlStr = `http://localhost:${port}`;
    console.log(`tack dashboard → ${urlStr}  (Ctrl+C to stop)`);
    if (opts.open !== false) {
      try {
        Bun.spawn(["open", urlStr], { stdout: "ignore", stderr: "ignore" });
      } catch {
        /* non-mac or no opener: ignore */
      }
    }
    process.on("SIGINT", () => {
      console.log("\ntack dashboard stopped.");
      server?.stop?.();
      process.exit(0);
    });
    // keep process alive
    await new Promise(() => {});
  });

cli.command("config [key] [value]", "Read or write config").action(
  async (key: string | undefined, value: string | undefined) => {
    const cfg = await loadConfig();
    if (!key) {
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    const keys = key.split(".");
    if (value === undefined) {
      let v: any = cfg;
      for (const k of keys) v = v?.[k];
      if (v === undefined) {
        process.exit(1);
      }
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
      return;
    }
    let obj: any = cfg;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof obj[keys[i]] !== "object" || obj[keys[i]] === null) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    await Bun.write(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`${key} = ${value}`);
  }
);

cli.help();
cli.version("0.1.0");

try {
  // `tack task <verb> ...` is a pure alias for `tack <verb> ...` — agents reach
  // for a `task` namespace, so accept it and forward to the flat command.
  const argv = process.argv.slice();
  if (argv[2] === "task") argv.splice(2, 1);
  cli.parse(argv);
} catch (e: any) {
  die(e?.message ?? String(e));
}
