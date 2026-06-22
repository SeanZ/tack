/* tack dashboard — vanilla JS, polls /api/data every 5s */

/* ── theme: follow system by default, manual override persists ── */
(function initTheme() {
  const KEY = "tack-theme";
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const systemTheme = () => (mq.matches ? "light" : "dark");
  const apply = (t) => document.documentElement.setAttribute("data-theme", t);

  // saved explicit choice wins; otherwise follow system
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  apply(saved || systemTheme());

  // when following system (no saved choice), react to OS theme changes
  mq.addEventListener("change", () => {
    let s = null;
    try { s = localStorage.getItem(KEY); } catch {}
    if (!s) apply(systemTheme());
  });

  window.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const next = cur === "light" ? "dark" : "light";
      apply(next);
      try { localStorage.setItem(KEY, next); } catch {}
    });
  });
})();

const BOXES = [
  { key: "inbox", name: "INBOX", color: "var(--inbox)" },
  { key: "processing", name: "PROCESSING", color: "var(--processing)" },
  { key: "backlog", name: "BACKLOG", color: "var(--backlog)" },
  { key: "archived", name: "ARCHIVED", color: "var(--archived)" },
];

let LAST = null; // last payload, for drawer lookups
let lastFetchTs = 0;
let lastSig = null; // signature of last rendered data (skip re-render if unchanged)
let openTaskId = null; // currently open drawer task, to re-sync on data change
let actMode = "day"; // activity heatmap granularity: "day" | "week" | "month"
let actSelected = null; // selected interval id (e.g. "d:2026-06-22"), or null
let actMap = new Map(); // current per-day activity, for the hover tooltip
let hotAnchor = null; // cell whose interval is currently highlighted (hover de-dupe)
let lastDetailKey = null; // last opened interval, to animate the detail card only on open
let hmTip = null; // floating tooltip element (lazily created on <body>)

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const esc = (s) => String(s == null ? "" : s);

function shortUuid(u) {
  return u && u.length > 8 ? u.slice(0, 8) : u;
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

// cheap signature: everything except the always-changing generated_at
function signatureOf(data) {
  return JSON.stringify({ stats: data.stats, tasks: data.tasks, meta: data.meta });
}

async function load() {
  try {
    const r = await fetch("/api/data", { cache: "no-store" });
    const data = await r.json();
    LAST = data;
    lastFetchTs = Date.now();
    const sig = signatureOf(data);
    if (sig === lastSig) return; // no change → no flash, just keep the page
    lastSig = sig;
    render(data);
    // if a drawer was open, re-sync its content with fresh data
    if (openTaskId && data.tasks.some((t) => t.id === openTaskId)) {
      fillDrawer(openTaskId);
    }
  } catch (e) {
    $("brandSub").textContent = "连接断开 — tack web 是否还在运行?";
  }
}

function render(data) {
  const { stats, tasks } = data;

  $("brandSub").textContent =
    `${stats.total} tasks · ${stats.sessions} sessions · ${stats.laneCount} lanes`;
  if (stats.sessionSpan) {
    $("spanRange").textContent =
      `${stats.sessionSpan.from.slice(5, 10)} → ${stats.sessionSpan.to.slice(5, 10)}`;
  }

  renderTiles(stats);
  renderBoard(tasks, stats);
  renderHeatmap();
  renderBars("laneBars", stats.lane, { strip: "lane:", color: "var(--accent)" });
  renderBars("repoBars", stats.repo, { color: "var(--inbox)" });
  renderBars(
    "targetBars",
    stats.target,
    { color: "var(--target)", colorMap: { none: "var(--backlog)" } }
  );
}

function renderTiles(stats) {
  const host = $("tiles");
  host.innerHTML = "";
  const defs = [
    { key: "inbox", label: "Inbox", color: "var(--inbox)", foot: "待决定" },
    { key: "processing", label: "Processing", color: "var(--processing)", foot: "进行中", accent: true },
    { key: "backlog", label: "Backlog", color: "var(--backlog)", foot: "暂存" },
    { key: "archived", label: "Archived", color: "var(--archived)", foot: "已归档" },
  ];
  for (const d of defs) {
    const t = el("div", "tile" + (d.accent ? " is-accent" : ""));
    t.style.setProperty("--tcol", d.color);
    t.appendChild(el("div", "t-label", d.label));
    t.appendChild(el("div", "t-num", String(stats.box[d.key] ?? 0)));
    t.appendChild(el("div", "t-foot", d.foot));
    host.appendChild(t);
  }
}

function renderBoard(tasks, stats) {
  const host = $("board");
  host.innerHTML = "";
  for (const box of BOXES) {
    const col = el("div", "col");
    col.style.setProperty("--ccol", box.color);

    const head = el("div", "col-head");
    const name = el("div", "c-name", box.name);
    head.appendChild(name);
    head.appendChild(el("div", "c-count", String(stats.box[box.key] ?? 0)));
    col.appendChild(head);

    const items = tasks
      .filter((t) => t.state === box.key)
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

    if (items.length === 0) {
      col.appendChild(el("div", "cards empty", "—"));
    } else {
      const cards = el("div", "cards");
      for (const t of items) cards.appendChild(taskCard(t));
      col.appendChild(cards);
    }
    host.appendChild(col);
  }
}

function taskCard(t) {
  const c = el("div", "card");
  c.onclick = () => openDrawer(t.id);

  const top = el("div", "c-top");
  top.appendChild(el("span", "c-id", t.id));
  if (t.sessions.length) top.appendChild(el("span", "c-sess", `${t.sessions.length}s`));
  c.appendChild(top);

  c.appendChild(el("div", "c-title", t.title));

  const meta = el("div", "c-meta");
  if (t.repo) meta.appendChild(el("span", "chip repo", t.repo));
  const lanes = t.tags.filter((g) => g.startsWith("lane:"));
  for (const l of lanes.slice(0, 2)) meta.appendChild(el("span", "chip lane", l.replace("lane:", "")));
  const et = t.effective_target;
  if (et && et.value) {
    meta.appendChild(el("span", "chip target", et.derived ? et.value + "~" : et.value));
  }
  c.appendChild(meta);
  return c;
}

function renderBars(hostId, obj, opts = {}) {
  const host = $(hostId);
  host.innerHTML = "";
  const entries = Object.entries(obj)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  for (const [k, v] of entries) {
    const label = opts.strip ? k.replace(opts.strip, "") : k;
    const row = el("div", "bar-row");
    row.appendChild(el("div", "bar-label", label));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${(v / max) * 100}%`;
    const color = (opts.colorMap && opts.colorMap[k]) || opts.color || "var(--accent)";
    fill.style.background = color;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("div", "bar-val", String(v)));
    host.appendChild(row);
  }
  if (entries.length === 0) host.appendChild(el("div", "empty-note", "—"));
}

/* ── activity heatmap (GitHub-style calendar grid) ────────── */
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]; // rows, Mon..Sun
const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const WEEKS_BACK = 52; // columns of weeks shown (≈ one year)

// local YYYY-MM-DD from an ISO/date string (null if unparseable)
function localKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return keyOfDate(d);
}
// YYYY-MM-DD for a Date in local time
function keyOfDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// per-day activity from the live task list: created / archived / sessions / notes.
// returns Map<"YYYY-MM-DD", {created, archived, sessions, notes, total}>
function computeActivity(tasks) {
  const map = new Map();
  const bump = (iso, field) => {
    const k = localKey(iso);
    if (!k) return;
    let e = map.get(k);
    if (!e) { e = { created: 0, archived: 0, sessions: 0, notes: 0, total: 0 }; map.set(k, e); }
    e[field]++; e.total++;
  };
  for (const t of tasks) {
    bump(t.created_at, "created");
    if (t.state === "archived") bump(t.updated_at, "archived");
    for (const s of t.sessions || []) bump(s.started_at, "sessions");
    for (const n of t.notes || []) bump(n.at, "notes");
  }
  return map;
}

// a day's total touches → intensity level 0..4 (fixed buckets)
function actLevel(total) {
  if (!total) return 0;
  if (total <= 1) return 1;
  if (total <= 3) return 2;
  if (total <= 6) return 3;
  return 4;
}

function renderHeatmap() {
  const host = $("heatmap");
  if (!host) return;
  const map = computeActivity(LAST?.tasks || []);
  actMap = map; // expose to the hover tooltip
  hotAnchor = null; // grid is about to be rebuilt; drop any stale hover anchor

  // window: from the Monday WEEKS_BACK weeks ago, one column of 7 days per week.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // this Monday
  start.setDate(start.getDate() - WEEKS_BACK * 7);
  const startKey = keyOfDate(start);

  const cols = []; // each = array of 7 Dates (or null for future days)
  for (let cur = new Date(start); cur <= today; cur.setDate(cur.getDate() + 7)) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const d = new Date(cur); d.setDate(d.getDate() + r);
      col.push(d <= today ? d : null);
    }
    cols.push(col);
  }

  host.innerHTML = "";

  // month labels, placed at the column where each month first appears
  const months = el("div", "hm-months");
  months.style.setProperty("--cols", cols.length);
  let lastMonth = -1;
  cols.forEach((col, ci) => {
    const top = col.find(Boolean);
    if (!top) return;
    if (top.getMonth() !== lastMonth) {
      lastMonth = top.getMonth();
      const lbl = el("span", "hm-month", MONTHS[lastMonth]);
      lbl.style.gridColumn = String(ci + 1); // anchor to the month's first week, let text overflow right
      months.appendChild(lbl);
    }
  });

  // weekday labels (left rail) — show 一/三/五 like GitHub
  const days = el("div", "hm-days");
  WEEKDAYS.forEach((w, i) => days.appendChild(el("div", "hm-day", i % 2 === 0 ? w : "")));

  // the cell grid
  const grid = el("div", "hm-grid");
  grid.style.setProperty("--cols", cols.length);
  cols.forEach((col, ci) => {
    col.forEach((d) => {
      if (!d) { grid.appendChild(el("div", "hm-cell is-void")); return; }
      const k = keyOfDate(d);
      const total = map.get(k)?.total || 0;
      const cell = el("div", `hm-cell l${actLevel(total)}`);
      cell.dataset.date = k;
      cell.dataset.col = String(ci);
      cell.dataset.ym = k.slice(0, 7);
      cell.title = `${k} · ${total} 次活动`;
      grid.appendChild(cell);
    });
  });

  const main = el("div", "hm-main");
  main.appendChild(months);
  main.appendChild(grid);
  const board = el("div", "hm-board");
  board.appendChild(days);
  board.appendChild(main);
  host.appendChild(board);

  grid.addEventListener("mousemove", onHmMove);
  grid.addEventListener("mouseleave", onHmLeave);
  grid.addEventListener("click", onHmClick);

  renderActSummary(map, startKey);
  markSelected();
  renderActDetail();
}

// the cells sharing the hovered cell's interval, per the current mode
function intervalCells(cell) {
  const grid = cell.parentElement;
  if (actMode === "day") return [cell];
  if (actMode === "week") return [...grid.querySelectorAll(`.hm-cell[data-col="${cell.dataset.col}"]`)];
  return [...grid.querySelectorAll(`.hm-cell[data-ym="${cell.dataset.ym}"]`)];
}
function sumDates(dates) {
  const o = { created: 0, archived: 0, sessions: 0, notes: 0, total: 0 };
  for (const k of dates) {
    const e = actMap.get(k);
    if (e) { o.created += e.created; o.archived += e.archived; o.sessions += e.sessions; o.notes += e.notes; o.total += e.total; }
  }
  return o;
}
function clearHmHot() {
  for (const c of document.querySelectorAll(".hm-cell.hm-hot")) c.classList.remove("hm-hot");
}

// hover: highlight the interval (only when the anchor cell changes) + follow with tooltip
function onHmMove(e) {
  const cell = e.target.closest(".hm-cell");
  if (!cell || cell.classList.contains("is-void")) { onHmLeave(); return; }
  if (cell !== hotAnchor) {
    hotAnchor = cell;
    clearHmHot();
    const cells = intervalCells(cell);
    for (const c of cells) c.classList.add("hm-hot");
    showTip(cells.map((c) => c.dataset.date).filter(Boolean).sort());
  }
  moveTip(e.clientX, e.clientY);
}
function onHmLeave() {
  hotAnchor = null;
  clearHmHot();
  hideTip();
}

// floating tooltip — created once, lives on <body>
function ensureTip() {
  if (!hmTip) { hmTip = el("div", "hm-tip"); document.body.appendChild(hmTip); }
  return hmTip;
}
function showTip(dates) {
  const tip = ensureTip();
  const from = dates[0], to = dates[dates.length - 1];
  const label = actMode === "day" ? from : actMode === "month" ? from?.slice(0, 7) : `${from} → ${to}`;
  const s = sumDates(dates);
  tip.innerHTML =
    `<div class="tip-d">${label || ""}</div>` +
    (s.total
      ? `<div class="tip-b"><b>${s.total}</b> 次活动 · 创建 ${s.created} · 归档 ${s.archived} · 会话 ${s.sessions} · 笔记 ${s.notes}</div>`
      : `<div class="tip-b tip-empty">无活动</div>`);
  tip.classList.add("show");
}
function moveTip(x, y) {
  const tip = ensureTip();
  const pad = 8, half = tip.offsetWidth / 2;
  tip.style.left = Math.max(pad + half, Math.min(window.innerWidth - pad - half, x)) + "px";
  tip.style.top = (y - 12) + "px";
}
function hideTip() { if (hmTip) hmTip.classList.remove("show"); }

function intervalId(cell) {
  if (actMode === "day") return "d:" + cell.dataset.date;
  if (actMode === "week") return "w:" + cell.dataset.col;
  return "m:" + cell.dataset.ym;
}
function onHmClick(e) {
  const cell = e.target.closest(".hm-cell");
  if (!cell || cell.classList.contains("is-void")) return;
  const id = intervalId(cell);
  actSelected = actSelected === id ? null : id;
  markSelected();
  renderActDetail();
}

// outline the cells of the currently selected interval
function markSelected() {
  for (const c of document.querySelectorAll(".hm-cell.is-sel")) c.classList.remove("is-sel");
  const grid = $("heatmap")?.querySelector(".hm-grid");
  if (!actSelected || !grid) return;
  const kind = actSelected[0], val = actSelected.slice(2);
  const sel =
    kind === "d" ? `.hm-cell[data-date="${val}"]`
    : kind === "w" ? `.hm-cell[data-col="${val}"]`
    : `.hm-cell[data-ym="${val}"]`;
  for (const c of grid.querySelectorAll(sel)) c.classList.add("is-sel");
}

// window totals next to the title + the "近一年" footer count
function renderActSummary(map, startKey) {
  let c = 0, a = 0, s = 0, nn = 0;
  for (const [k, e] of map) {
    if (k < startKey) continue;
    c += e.created; a += e.archived; s += e.sessions; nn += e.notes;
  }
  const sumEl = $("actSummary");
  if (sumEl) {
    sumEl.innerHTML =
      `<span class="su su-c">创建 <b>${c}</b></span>` +
      `<span class="su su-a">归档 <b>${a}</b></span>` +
      `<span class="su su-p">会话 <b>${s}</b></span>` +
      `<span class="su su-o">笔记 <b>${nn}</b></span>`;
  }
  const totEl = $("hmTotal");
  if (totEl) totEl.textContent = `近一年 ${c + a + s + nn} 次活动`;
}

// inline detail card for the selected day / week / month
function renderActDetail() {
  const host = $("actDetail");
  if (!host) return;
  const grid = $("heatmap")?.querySelector(".hm-grid");
  const cells = grid ? [...grid.querySelectorAll(".hm-cell.is-sel")].filter((c) => c.dataset.date) : [];
  if (!actSelected || !cells.length) { host.hidden = true; host.innerHTML = ""; lastDetailKey = null; return; }
  const fresh = actSelected !== lastDetailKey; // animate the reveal only on a new interval
  lastDetailKey = actSelected;

  const dates = cells.map((c) => c.dataset.date).sort();
  const from = dates[0], to = dates[dates.length - 1];
  const inRange = (iso) => { const k = localKey(iso); return k && k >= from && k <= to; };

  const agg = { created: 0, archived: 0, sessions: 0, notes: 0 };
  const touched = new Map(); // id -> { t, evs:Set }
  const touch = (t, ev) => {
    let r = touched.get(t.id);
    if (!r) { r = { t, evs: new Set() }; touched.set(t.id, r); }
    r.evs.add(ev);
  };
  for (const t of LAST?.tasks || []) {
    if (inRange(t.created_at)) { agg.created++; touch(t, "created"); }
    if (t.state === "archived" && inRange(t.updated_at)) { agg.archived++; touch(t, "archived"); }
    for (const s of t.sessions || []) if (inRange(s.started_at)) { agg.sessions++; touch(t, "session"); }
    for (const n of t.notes || []) if (inRange(n.at)) { agg.notes++; touch(t, "note"); }
  }
  const total = agg.created + agg.archived + agg.sessions + agg.notes;

  const kind = actSelected[0];
  const modeLabel = kind === "d" ? "当日" : kind === "w" ? "当周" : "当月";
  const title = kind === "d" ? from : kind === "m" ? from.slice(0, 7) : `${from} → ${to}`;

  host.hidden = false;
  host.innerHTML = "";
  if (fresh) { host.classList.remove("ld-pop"); void host.offsetWidth; host.classList.add("ld-pop"); }

  const head = el("div", "ld-head");
  head.appendChild(el("span", "ld-name", `${modeLabel} · ${title}`));
  const close = el("button", "ld-close", "✕");
  close.type = "button";
  close.onclick = () => { actSelected = null; markSelected(); renderActDetail(); };
  head.appendChild(close);
  host.appendChild(head);

  const stats = el("div", "ld-stats");
  const stat = (label, val, cls) => {
    const s = el("div", "ld-stat" + (cls ? " " + cls : ""));
    s.appendChild(el("div", "ld-v", String(val)));
    s.appendChild(el("div", "ld-l", label));
    return s;
  };
  stats.appendChild(stat("新增", agg.created, "is-c"));
  stats.appendChild(stat("归档", agg.archived, "is-arch"));
  stats.appendChild(stat("会话", agg.sessions, "is-proc"));
  stats.appendChild(stat("笔记", agg.notes, "is-open"));
  host.appendChild(stats);

  if (total === 0) { host.appendChild(el("div", "ld-sub", "这段时间没有活动")); return; }

  host.appendChild(el("div", "ld-sub", `共 ${total} 次活动 · ${touched.size} 个任务被触达`));

  const evLabel = { created: "新增", archived: "归档", session: "会话", note: "笔记" };
  const evCls = { created: "is-c", archived: "is-arch", session: "is-proc", note: "" };
  const list = el("div", "act-list");
  for (const { t, evs } of touched.values()) {
    const row = el("button", "act-row");
    row.type = "button";
    row.onclick = () => openDrawer(t.id);
    const left = el("div", "ar-left");
    left.appendChild(el("span", "ar-id", t.id));
    left.appendChild(el("span", "ar-title", t.title));
    row.appendChild(left);
    const tags = el("div", "ar-tags");
    for (const ev of evs) tags.appendChild(el("span", "ar-ev " + evCls[ev], evLabel[ev]));
    row.appendChild(tags);
    list.appendChild(row);
  }
  host.appendChild(list);
}

/* ── notes formatting ────────────────────────────────────── */
// split a note into { kind, label, body } where kind drives styling
function parseNote(text) {
  let m;
  if ((m = text.match(/^\[digest\]\s*(.*)$/s))) return { kind: "digest", label: "digest", body: m[1] };
  if ((m = text.match(/^\[session\s+([^\]]+)\]\s*(.*)$/s))) return { kind: "session", label: m[1], body: m[2] };
  if ((m = text.match(/^\[([^\]]+)\]\s*(.*)$/s))) return { kind: "tagged", label: m[1], body: m[2] };
  return { kind: "plain", label: null, body: text };
}

const escHtml = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// inline markdown → html (on a single line of text, already HTML-escaped downstream)
// order matters: protect code spans first, then links/bold/italic, then domain highlights
function mdInline(raw) {
  let s = escHtml(raw);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, t, u) => `<a href="${escHtml(u)}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  // domain highlights on remaining plain text
  s = s
    .replace(/\b([0-9a-f]{7,40})\b/g, '<span class="hl-commit">$1</span>')
    .replace(/\b(T\d{6}-\d{2})\b/g, '<span class="hl-id">$1</span>')
    .replace(/([\w./-]+\.(?:go|ts|tsx|md|json|js|py|csv))\b/g, '<span class="hl-path">$1</span>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escHtml(codes[+i])}</code>`);
  return s;
}

// minimal block-level markdown → html (headings, lists, quotes, code fences, hr, paragraphs)
function mdToHtml(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', items: [] }
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(mdInline).join("<br>")}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join("")}</${list.type}>`); list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // fenced code block
    if (/^\s*```/.test(line)) {
      flushPara(); flushList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<pre><code>${escHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      out.push(`<h${m[1].length} class="md-h">${mdInline(m[2])}</h${m[1].length}>`);
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      flushPara();
      if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
      list.items.push(line.replace(/^\s*[-*+]\s+/, ""));
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${mdInline(m[1])}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara(); flushList(); out.push("<hr>"); continue;
    }
    para.push(line);
  }
  flushPara(); flushList();
  return out.join("");
}

// render a note body as markdown into host
function renderNoteBody(host, body) {
  const md = el("div", "md");
  md.innerHTML = mdToHtml(body);
  host.appendChild(md);
}

/* ── drawer ──────────────────────────────────────────────── */
function openDrawer(id) {
  if (!fillDrawer(id)) return;
  openTaskId = id;
  $("drawer").classList.add("show");
  $("drawer").setAttribute("aria-hidden", "false");
  $("scrim").classList.add("show");
}

function fillDrawer(id) {
  const t = LAST?.tasks.find((x) => x.id === id);
  if (!t) return false;
  const inner = $("drawerInner");
  inner.innerHTML = "";

  inner.appendChild(el("div", "dh-id", t.id));
  inner.appendChild(el("div", "dh-title", t.title));

  const meta = el("div", "dh-meta");
  const stateColors = { inbox: "var(--inbox)", processing: "var(--processing)", backlog: "var(--backlog)", archived: "var(--archived)" };
  const stateKv = el("div", "kv state");
  stateKv.style.setProperty("--scol", stateColors[t.state] || "var(--muted)");
  stateKv.innerHTML = `<b>${esc(t.state)}</b>`;
  meta.appendChild(stateKv);
  if (t.repo) { const k = el("div", "kv"); k.innerHTML = `repo <b>${esc(t.repo)}</b>`; meta.appendChild(k); }
  const et = t.effective_target;
  if (et && et.value) {
    const k = el("div", "kv");
    k.innerHTML = `target <b>${esc(et.value)}</b>${et.derived ? " <span style='color:var(--faint)'>(derived)</span>" : ""}`;
    meta.appendChild(k);
  }
  inner.appendChild(meta);

  if (t.tags.length) {
    const tagWrap = el("div", "c-meta");
    tagWrap.style.marginBottom = "20px";
    for (const g of t.tags) {
      const cls = g.startsWith("lane:") ? "chip lane" : g.startsWith("awaiting:") ? "chip awaiting" : "chip";
      tagWrap.appendChild(el("span", cls, g));
    }
    inner.appendChild(tagWrap);
  }

  if (t.ref) {
    const a = document.createElement("a");
    a.className = "dh-ref"; a.href = t.ref; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "↗ " + t.ref;
    inner.appendChild(a);
  }
  if (t.handoff_path) {
    const h = el("div", "kv"); h.style.marginBottom = "20px";
    h.innerHTML = `handoff <b>${esc(t.handoff_path)}</b>`;
    inner.appendChild(h);
  }

  // notes — formatted cards
  const notesTitle = el("div", "sec-title");
  notesTitle.innerHTML = `进度 notes <span class="n">${t.notes.length}</span>`;
  inner.appendChild(notesTitle);
  if (t.notes.length) {
    const wrap = el("div", "notes");
    // newest first reads better in a drawer
    for (const n of [...t.notes].reverse()) {
      const p = parseNote(n.text);
      const card = el("div", "note note-" + p.kind);
      const head = el("div", "note-head");
      const labels = el("div", "note-labels");
      const badge = el("span", "note-badge note-badge-" + p.kind, p.kind === "digest" ? "digest" : p.label || "note");
      labels.appendChild(badge);
      head.appendChild(labels);
      head.appendChild(el("span", "note-time", fmtTime(n.at)));
      card.appendChild(head);
      renderNoteBody(card, p.body);
      wrap.appendChild(card);
    }
    inner.appendChild(wrap);
  } else {
    inner.appendChild(el("div", "empty-note", "暂无 note"));
  }

  // sessions — full uuid + dir + copyable resume command
  const sessTitle = el("div", "sec-title");
  sessTitle.innerHTML = `关联 sessions <span class="n">${t.sessions.length}</span>`;
  inner.appendChild(sessTitle);
  if (t.sessions.length) {
    for (const s of t.sessions) {
      const row = el("div", "sess");
      const top = el("div", "sess-top");
      top.appendChild(el("span", "s-agent", s.agent || "cc"));
      top.appendChild(el("span", "s-time", fmtTime(s.started_at)));
      row.appendChild(top);

      // full uuid, click to copy
      row.appendChild(copyLine("uuid", s.uuid, s.uuid));

      if (s.transcript_path) {
        row.appendChild(el("div", "sess-dir", "file: " + s.transcript_path));
      }
      inner.appendChild(row);
    }
  } else {
    inner.appendChild(el("div", "empty-note", "暂无关联 session"));
  }
  return true;
}

// a labeled line with click-to-copy
function copyLine(label, display, copyVal) {
  const line = el("div", "copy-line");
  line.appendChild(el("span", "copy-label", label));
  const code = el("code", "copy-val", display);
  line.appendChild(code);
  const btn = el("button", "copy-btn", "copy");
  btn.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(copyVal).then(() => {
      btn.textContent = "copied";
      btn.classList.add("ok");
      setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("ok"); }, 1400);
    });
  };
  line.appendChild(btn);
  return line;
}

function closeDrawer() {
  openTaskId = null;
  $("drawer").classList.remove("show");
  $("drawer").setAttribute("aria-hidden", "true");
  $("scrim").classList.remove("show");
}

$("scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// activity heatmap mode toggle (按天 / 按周 / 按月)
$("actMode")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  const m = btn.dataset.mode;
  if (!m || m === actMode) return;
  actMode = m;
  for (const b of $("actMode").querySelectorAll(".seg-btn")) {
    b.classList.toggle("is-on", b.dataset.mode === m);
  }
  actSelected = null; // the selection unit changed → drop the open interval
  hotAnchor = null;
  clearHmHot();
  hideTip();
  markSelected();
  renderActDetail();
});

// "updated Ns ago" ticker
setInterval(() => {
  if (!lastFetchTs) return;
  const s = Math.round((Date.now() - lastFetchTs) / 1000);
  $("updated").textContent = s < 2 ? "just now" : `updated ${s}s ago`;
}, 1000);

load();
setInterval(load, 5000);
