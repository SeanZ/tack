# pops

A single-user, file-based task tracker built around Claude Code (CC) sessions.

`pops` captures incoming work, aggregates tasks across repos, and links each CC
session to the task it belongs to — so progress notes and session digests live
next to the task and survive across days and machines.

The tool is data-free: the code lives in this repo, your tasks and config live
under `~/.pops`. You can share the tool without sharing your data.

## Install

Requires [Bun](https://bun.com) (and `jq` for the CC hooks).

```bash
bun install

# expose the CLI on PATH (wrapper that runs this checkout)
mkdir -p ~/.local/bin
printf '#!/bin/bash\nexec bun %s/bin/pops.ts "$@"\n' "$PWD" > ~/.local/bin/pops
chmod +x ~/.local/bin/pops

# scaffold ~/.pops (config + git-managed data dir)
pops init
```

`pops init` creates:

- `~/.pops/config.json` — machine-local config (copy of `config.example.json`)
- `~/.pops/data/` — your tasks, as an independent git repo. Add a private
  remote and push to back it up:

  ```bash
  git -C ~/.pops/data remote add origin <your-private-repo>
  git -C ~/.pops/data add -A && git -C ~/.pops/data commit -m "init" && git -C ~/.pops/data push -u origin main
  ```

## Layout

```
this repo (tool, shareable)        ~/.pops (your data, private)
├── bin/pops.ts   CLI entry        ├── config.json   data_dir / repos / defaults
├── web/          dashboard        └── data/         ← its own git repo
├── hooks/        CC hooks             ├── tasks.jsonl   one line per task
└── config.example.json                └── tasks/<id>/digests/   session digests
```

Path resolution: assets resolve relative to the checkout; data resolves from
`POPS_DATA_DIR` → `config.json:data_dir` → `~/.pops/data`. Set `POPS_HOME` /
`POPS_DATA_DIR` to run an isolated instance (e.g. for tests).

## Workflow

```
event comes in → pops add (lands in inbox)
  ↓ pops triage the backlog, decide per item
  ↓ work the task inside a CC session
  ↓ pops note <id> "..."   ← logs progress AND auto-links this session
  ↓ pops mv <id> archived  ← writes a closing digest of the session(s)
```

Session linking is automatic: inside a CC session, `pops note` (and any
processing-state write) links the current session to the task using
`CLAUDE_CODE_SESSION_ID`. Digests are generated lazily on `pops show`, on
archive, and best-effort at session end — none of it depends on you closing the
session.

## Commands

```bash
pops add "<title>" [--tag a,b] [--repo r] [--target cc|trae|self] [--box b]
pops ls [box] [--tag t] [--repo r] [--all] [--json]
pops show <id> [--json]
pops mv <id> <box>              # inbox / processing / backlog / archived
pops tag <id> [tags...]         # no args: list; `untag` to remove
pops note <id> "<text>"         # append progress note (+ auto-link session)
pops set <id> key=val ...       # repo= target= state= ref= handoff_path= title=
pops link --task <id>           # link current session (hooks/manual)
pops digest --task <id>         # generate a session digest
pops brief <id>                 # compact brief (used by SessionStart hook)
pops which <uuid>               # which task owns a session uuid
pops scan [--repo r]            # CC sessions not yet linked to any task
pops web [--port 7420]          # local dashboard (foreground; Ctrl+C to stop)
pops setup cc                   # install the CC SessionStart/SessionEnd hooks
pops config [key] [value]       # read / write config
```

`pops task <verb> ...` is accepted as an alias for `pops <verb> ...`.

## CC hooks

`pops setup cc` installs two hooks into `~/.claude/settings.json`:

- **SessionStart** — if the resumed session is already linked to a task, injects
  that task's brief into context.
- **SessionEnd** — best-effort digest of the session into its task dir.
