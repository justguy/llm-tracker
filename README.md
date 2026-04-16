# llm-tracker

**A Kanban board for LLMs to keep their humans up to date.**

[![npm](https://img.shields.io/npm/v/llm-tracker.svg)](https://www.npmjs.com/package/llm-tracker)
[![CI](https://github.com/justguy/llm-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/justguy/llm-tracker/actions/workflows/ci.yml)
[![License: Apache%202.0](https://img.shields.io/badge/License-Apache%202.0-amber.svg)](LICENSE)

Stop forcing your LLMs to re-read and rewrite massive architecture files just to update a status. `llm-tracker` is a **100 % local** mission-control center that bridges the gap between complex agentic workflows and human oversight.

It's a file-system-as-database tracker. Your LLMs update project states with tiny HTTP or file-based patches, and the local hub renders a live, **Bloomberg-terminal-style** priority matrix so you can see exactly what your agents are doing at a glance.

When an agent needs to answer "what should I do next?", it can now make one call to `npx llm-tracker next <slug>` or `GET /api/projects/<slug>/next` and get a ranked shortlist instead of re-reading the full tracker. The ranking prefers bounded actionable work over aggregate roadmap/container rows, and prefers continuing active bounded work over starting a fresh bounded task.

When a human or agent asks "what about the feature with the..." instead of naming a task id, the hub now exposes both `GET /api/projects/<slug>/search?q=...` for local embedding-backed semantic search and `GET /api/projects/<slug>/fuzzy-search?q=...` for deterministic fuzzy lexical matching. The UI keeps the existing exact board filter and adds a separate `[FUZZY]` mode that highlights deterministic fuzzy matches in context.

When an agent already knows the task id and needs focused context, it can now make one call to `npx llm-tracker brief <slug> <task-id>` or `GET /api/projects/<slug>/tasks/<taskId>/brief` and get a capped pack instead of rereading the tracker, docs, and code by hand.

When an agent needs to answer "why does this task exist?" or "what decisions did we already make?", it can now call `npx llm-tracker why <slug> <task-id>` or `npx llm-tracker decisions <slug>` instead of reconstructing that from raw comments and history.

When an agent is ready to act or validate work, it can now call `npx llm-tracker execute <slug> <task-id>` and `npx llm-tracker verify <slug> <task-id>` for deterministic execution and verification packs instead of inventing a plan from scratch.

When an agent needs the current contract for a running hub, it should call `GET /help` first instead of guessing write modes or endpoints.

The UI now exposes the same deterministic loop for humans: header actions for `[NEXT]`, `[BLOCKERS]`, `[CHANGED]`, and `[DECISIONS]`, hover task actions for `[READ]`, `[WHY]`, `[EXEC]`, and `[VERIFY]`, project-shortlist `[PICK]` actions that jump straight into execution context, a live `/help` contract panel, an exact board filter plus deterministic `[FUZZY]` highlight mode, plus real `[UNDO]`, `[REDO]`, and revision history.

## Why use llm-tracker?

🔒 **100 % Local & Secure** — the core hub doesn't ping any LLM APIs; it watches your local filesystem, merges patches, and serves the UI. Your project state never leaves your machine. Semantic `/search` uses a local embedding model and only reaches out once if the model is not already cached on disk.

💸 **Massive Token Savings** — no full-file rewrites. LLMs send surgical JSON patches (often <100 bytes) and pull changes since their last rev, keeping context windows small and API costs low.

⚡ **Stupidly Simple** — no databases, no cloud accounts, and no behavior surprises. `npx llm-tracker init`, `npx llm-tracker`, open the browser. Foreground remains the default; an optional local background daemon is available if you do not want to dedicate a shell. Every project is one JSON file you can `cat`, diff, or commit.

---

## Screenshots

**Main view** — swimlane × priority matrix, scratchpad banner, status + block filters, segmented progress bar.

![Main view](./img/main-screen.png)

**Task comments** — each task has an optional `comment` field (≤ 500 chars). Set it via JSON, patch API, or the inline `[+C]` editor on the card; hover the `[C]` badge to read it. The popover clamps to the viewport so cards near the edges don't clip.

**Overview drawer** — all projects at a glance; click to switch, pin to keep it open.

![Overview drawer](./img/overview-drawer.png)

**Drag and drop** — re-prioritize or move tasks across swimlanes; hub writes atomically, UI updates live.

![Drag and drop](./img/drag-and-drop.png)

**Dark mode (default)** — high-contrast Bloomberg amber on black. Light theme via the `[☼]` toggle.

![Dark mode](./img/dark-mode.png)

---

## Install (30 seconds)

```bash
npx llm-tracker init     # scaffolds ~/.llm-tracker workspace
npx llm-tracker          # starts hub + UI on http://localhost:4400
npx llm-tracker --daemon # same hub, but detached into the background
```

The first command prints a paste-ready prompt. Give it to any LLM with file-write or HTTP access, and your project appears in the UI within half a second.

Or install globally once:

```bash
npm install -g llm-tracker
llm-tracker init && llm-tracker
```

## Supported Topologies

`llm-tracker` supports two deployment shapes:

- Recommended: **one shared workspace + one shared daemon + many linked projects.** Run the hub on a central workspace such as `~/.llm-tracker`, then link repo-local tracker files into it with `npx llm-tracker link <slug> <abs-path>`. This gives one source of truth for humans and agents.
- Supported: **multiple isolated workspaces + multiple daemons.** Useful for demos, sandboxes, or teams that want hard isolation. Each daemon needs its own workspace folder and port.

If you keep a tracker file in a repo and link it into the shared workspace:

- the shared daemon automatically watches the linked tracker file for direct edits
- the shared daemon automatically watches the shared workspace `patches/` directory
- patch files belong in the shared workspace, not in the repo-local `.llm-tracker/` folder

## Agent Help

Running hubs expose `GET /help` as the current agent contract for that workspace.

- It serves the workspace `README.md`
- For standard workspaces, that file comes from [`workspace-template/README.md`](./workspace-template/README.md)
- Agents should read `/help` before using write paths or task-intelligence endpoints
- Agents should prefer `next` to choose work, `brief` to load task context, `why` to explain task intent, `decisions` to recall prior decisions, and `execute` / `verify` to close the work loop before broad file reads
- If you change agent-facing behavior, update the workspace template so `/help` stays accurate

---

## Wire it into your LLM CLI

Drop a one-line file into your coding CLI's rules/skills folder. That's the whole install. Next time you ask "what's the state of my projects?" the LLM runs `npx llm-tracker status` on its own.

That path is still prompt-driven. It saves rereads, but it still spends model tokens.

**Claude Code** — create `~/.claude/skills/llm-tracker-status/SKILL.md`:

```markdown
---
description: Show overall status of LLM Project Tracker projects.
---

When the user asks about project status, progress, or what the tracker shows, run:

    npx llm-tracker status

For one project in detail: `npx llm-tracker status <slug>`.
For JSON (chainable): `npx llm-tracker status --json`.
```

**Every other CLI** — one sentence pointing at the same command:

| Environment  | Drop the line at                                    |
| ------------ | --------------------------------------------------- |
| Cursor       | `.cursor/rules/llm-tracker.md`                      |
| Windsurf     | append to `.windsurfrules`                          |
| Aider        | append to `CONVENTIONS.md`                          |
| Anything else | `AGENTS.md` in the repo root                       |

Each file just says: *"For project status, run `npx llm-tracker status`."* That's it.

If the hub is already running, add one more line: *"Before using the tracker, read `GET /help`."*

---

## Zero-token terminal shortcut

If you want direct tracker commands from a Codex or Claude terminal session without asking the model anything, print the shell wrapper once and load it into your shell:

```bash
eval "$(npx llm-tracker shortcuts)"
```

That creates a small `lt` shell function. Use it like:

```bash
lt next project-phalanx
lt brief project-phalanx t-021
lt why project-phalanx t-021
lt execute project-phalanx t-021
lt verify project-phalanx t-021
```

To keep it permanently, append the printed snippet to `~/.zshrc` or `~/.bashrc`. If you want a different function name, use `npx llm-tracker shortcuts --alias tracker`.

---

## Shell commands

```bash
# Zero-token shell wrapper for lt next / lt brief / lt verify
npx llm-tracker shortcuts            # prints a bash/zsh function wrapper

# Works with hub NOT running — reads files directly
npx llm-tracker status              # dashboard of all projects
npx llm-tracker status <slug>       # detail on one project
npx llm-tracker status --json       # machine-readable

# Requires hub running
npx llm-tracker help                     # local CLI usage help
npx llm-tracker blockers <slug>        # structural blockers and what they are waiting on
npx llm-tracker changed <slug> <rev>   # changed tasks since a rev
npx llm-tracker search <slug> <query>  # semantic local-model search (requires hub)
npx llm-tracker fuzzy-search <slug> <query>  # deterministic fuzzy lexical search (requires hub)
npx llm-tracker pick <slug> [task-id] --assignee codex  # atomic claim, defaults to top ready task
npx llm-tracker next <slug> [--limit 5]  # ranked shortlist: recommendation + alternatives
npx llm-tracker since <slug> <rev>  # event log since a rev (for LLMs to catch up)
npx llm-tracker rollback <slug> <rev>
npx llm-tracker link <slug> <abs-path>  # symlink an external tracker into the workspace
npx llm-tracker reload [<slug>]         # rescan one or all trackers from disk

# Optional background lifecycle
npx llm-tracker --daemon                  # start hub in the background
npx llm-tracker daemon status             # show pid / port / log path
npx llm-tracker daemon stop               # stop the background hub
npx llm-tracker daemon restart            # restart the same background hub
npx llm-tracker daemon logs --lines 80    # print recent daemon logs

# For LLMs talking to the running hub
curl http://localhost:4400/help           # current workspace agent contract
```

Full flag reference: `npx llm-tracker help`.

## HTTP API Quick Reference

The HTTP hub is the clean machine interface for agent clients.

Start with:

```bash
curl http://localhost:4400/help
```

That returns the active workspace contract for the running hub. In daemon mode on
another port, use the port recorded in `.runtime/daemon.json` or
`npx llm-tracker daemon status`.

### Core read endpoints

```bash
# Workspace / project overview
curl http://localhost:4400/help
curl http://localhost:4400/api/projects
curl http://localhost:4400/api/projects/<slug>
curl "http://localhost:4400/api/projects/<slug>/next?limit=5"
curl "http://localhost:4400/api/projects/<slug>/since/<rev>"

# Focused task context
curl http://localhost:4400/api/projects/<slug>/tasks/<taskId>/brief
curl http://localhost:4400/api/projects/<slug>/tasks/<taskId>/why
curl http://localhost:4400/api/projects/<slug>/tasks/<taskId>/execute
curl http://localhost:4400/api/projects/<slug>/tasks/<taskId>/verify

# Project-level context
curl "http://localhost:4400/api/projects/<slug>/decisions?limit=20"
curl http://localhost:4400/api/projects/<slug>/blockers
curl "http://localhost:4400/api/projects/<slug>/changed?fromRev=<rev>&limit=20"
curl "http://localhost:4400/api/projects/<slug>/history?limit=50"

# Search
curl "http://localhost:4400/api/projects/<slug>/search?q=<query>"
curl "http://localhost:4400/api/projects/<slug>/fuzzy-search?q=<query>"
```

Use `search` for feature-shaped questions and `fuzzy-search` when you want a
deterministic lexical fallback.

### Core write endpoints

Use HTTP writes when you want to avoid touching the workspace filesystem.

```bash
# Atomic claim / pick
curl -X POST http://localhost:4400/api/projects/<slug>/pick \
  -H "Content-Type: application/json" \
  -d '{"taskId":"<task-id>","assignee":"codex"}'

# Fire-and-forget project patch
curl -X POST http://localhost:4400/api/projects/<slug>/patch \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/<slug>-patch.json

# Revision controls
curl -X POST http://localhost:4400/api/projects/<slug>/undo
curl -X POST http://localhost:4400/api/projects/<slug>/redo

# Reload trackers from disk
curl -X POST http://localhost:4400/api/projects/<slug>/reload
```

Patch payloads stay small. Typical shape:

```json
{
  "tasks": {
    "t-001": {
      "status": "complete",
      "context": {
        "notes": "shipped"
      }
    }
  },
  "meta": {
    "scratchpad": "t-001 closed; t-002 is next"
  }
}
```

### Practical rule of thumb

- Read `/help` first.
- Use `next`, `brief`, `why`, `execute`, and `verify` instead of rereading the whole tracker.
- Use `patch` for status/content updates.
- Use `pick` when you want an atomic claim instead of hand-rolling status changes.
- Keep writes small and frequent.

### Agent Interfaces

This project ships a stdio MCP server via `llm-tracker mcp`.

Use the workspace contract first, then the narrowest interface that fits:

- read `GET /help` or `tracker_help` first for the active workspace contract
- use `tracker_next`, `tracker_brief`, `tracker_why`, `tracker_decisions`, `tracker_execute`, `tracker_verify`, `tracker_search`, and `tracker_fuzzy_search` for focused reads
- use `tracker_pick`, `tracker_undo`, `tracker_redo`, and `tracker_reload` through the running hub for authoritative writes

Register the server in your client config instead of launching it manually:

```toml
[mcp_servers.llm-tracker]
command = "node"
args = [
  "/Users/you/path/to/llm-project-tracker/bin/llm-tracker.js",
  "mcp",
  "--path",
  "/Users/you/.llm-tracker",
]
startup_timeout_sec = 60
```

MCP reads work directly from workspace files. MCP writes still require the shared hub or daemon to be reachable.

## Background daemon

Foreground startup is still the default. Existing users can keep using `npx llm-tracker` exactly as before.

If you want the hub to keep running without a dedicated shell, use `npx llm-tracker --daemon` or `npx llm-tracker daemon start`. Runtime artifacts live under `~/.llm-tracker/.runtime/` by default:

- `daemon.json` stores pid, port, and startup metadata
- `daemon.log` captures hub stdout and stderr

Existing workspaces do not need migration work. The `.runtime/` directory is created on demand the first time daemon mode is used.

Hub-backed CLI commands reuse the active daemon port from `.runtime/daemon.json` when you omit `--port`, so `brief`, `why`, `decisions`, `execute`, `verify`, `next`, `blockers`, `changed`, `pick`, `since`, `rollback`, `link`, and `reload` keep working against a background hub started on a non-default port.

Daemon state is **workspace-scoped**. `npx llm-tracker daemon stop --path <dir>` only affects the daemon for that workspace. In the recommended shared-daemon topology, that means one daemon for the central workspace and linked repo-local project files underneath it.

### Daemon troubleshooting

The hub now rescans tracker files on startup, eagerly loads trackers created through `link`, auto-reloads missing slugs on demand, and refreshes the project list from disk before serving `/api/projects`. In normal use, that should remove most "restart to see the project" failures.

If a tracker exists on disk but does not appear in the UI or a slug 404s unexpectedly:

1. If a specific slug 404s, retry the request once. The hub now attempts an on-demand reload for missing slugs.
2. Run `npx llm-tracker reload [<slug>] --path <workspace>` to rescan one slug or the whole workspace explicitly.
3. If it is a symlinked repo-local tracker, make sure it was registered through `npx llm-tracker link ...` rather than by manual symlink creation.
4. If the daemon itself looks stale, run `npx llm-tracker daemon restart --path <workspace>`.

If `daemon stop` times out or hub-backed commands say `Hub not reachable`:

1. Run `npx llm-tracker daemon status --path <workspace>` and `npx llm-tracker daemon logs --path <workspace> --lines 120`.
2. If the recorded PID still exists but the recorded port does not answer, stop that PID manually.
3. Run `daemon status` again. If the process is gone but `.runtime/daemon.json` is still present, remove the stale metadata file and start the daemon again.

Do **not** fix this by creating a second accidental workspace in the repo. The correct recovery target is the original workspace.

---

## The Contract (TL;DR)

**The hub owns structure. The LLM owns content.**

- **LLM writes** — statuses, assignees, dependencies, notes, tags, priorities, new tasks, scratchpad
- **Hub enforces** — task array order, existence (no accidental deletion), human UI state (drag positions, swimlane collapse), version stamps

Two patch-time guardrails now matter for agent reliability:

- append brand-new patch tasks only as `not_started` or `in_progress`, not already `complete` or `deferred`
- use `reference` / `references[]` only in `path:line` or `path:line-line` form; bare URLs are rejected with an explicit hint

LLMs send small patches. The hub merges them under a per-project lock, bumps `meta.rev`, writes a full snapshot, and appends a `{rev, delta}` line to the history log. When the LLM needs to refresh, it calls `GET /api/projects/:slug/since/<last-rev>` and gets only what changed — **constant-size payload regardless of project size**.

For task pickup, prefer the atomic claim flow over hand-built status patches:

- `GET /api/projects/:slug/tasks/:taskId/brief`
- `npx llm-tracker brief <slug> <task-id>`
- `GET /api/projects/:slug/tasks/:taskId/why`
- `npx llm-tracker why <slug> <task-id>`
- `GET /api/projects/:slug/decisions`
- `npx llm-tracker decisions <slug>`
- `GET /api/projects/:slug/tasks/:taskId/execute`
- `npx llm-tracker execute <slug> <task-id>`
- `GET /api/projects/:slug/tasks/:taskId/verify`
- `npx llm-tracker verify <slug> <task-id>`
- `POST /api/projects/:slug/pick`
- `npx llm-tracker pick <slug> [task-id] --assignee <model>`

For feature-oriented or fuzzy questions, prefer:

- `GET /api/projects/:slug/search?q=<query>`
- `npx llm-tracker search <slug> <query>`
- `GET /api/projects/:slug/fuzzy-search?q=<query>`
- `npx llm-tracker fuzzy-search <slug> <query>`

Legacy compatibility: if an older patch or tracker file still uses `status: "partial"`, the hub normalizes it to `in_progress` on ingest and writes back the canonical value.

### Semantic search stack

- Semantic `/search` uses [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) in the local Node.js hub.
- The default embedding model is [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2).
- Both are Apache-2.0 licensed.
- The first semantic query may download the model into the local Hugging Face cache; after that, query embedding and cosine ranking stay local.
- Semantic `/search` now tries the native Node runtime first, then a local WASM runtime bundled from `onnxruntime-web`, then a bundled offline hash runtime, and only then degrades to deterministic fuzzy matching.
- If semantic has to fall back, the payload returns a warning. If model runtimes are unavailable, `/search` can still return semantic results with `backend: "semantic_hash_fallback"`; only unexpected runtime failures degrade to `backend: "fuzzy_fallback"`.
- `/fuzzy-search` remains the deterministic lexical fallback when you want approximate string matching without loading embeddings.

Two write modes:

- **Mode A — File patches** (bash-less): LLM drops a JSON patch in `patches/<slug>.<ts>.json`; hub picks it up and deletes it.
- **Mode B — HTTP patches** (fastest): `POST /api/projects/:slug/patch`; one-time `curl` approval in your CLI, then no filesystem access.

Patch failures now return `error`, `type`, and `hint` so agents do not have to reverse-engineer raw schema regex output. The same hint-bearing payload is also written to `.errors.json` files in file-patch mode.

Full schema, merge semantics, field ownership, versioning, rollback, and the whole LLM-facing contract → **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

Migrating an older `0.1.x` workspace or tracker set to the `0.2.0` contract, including agent backfill guidance for the new fields → **[MIGRATING.md](./MIGRATING.md)**.

That migration guide also covers existing shared-workspace projects linked from repo worktrees: relink the slug to the intended branch file, `reload` it, backfill bounded active tasks first, verify with `execute` / `verify` / `search`, and stop before any commit unless the human asked for one.

If a linked slug is already registered, the safe relink flow is: remove the current workspace symlink registration, re-link the slug to the new absolute target path, then `reload` it. That unregister step removes only the shared workspace symlink, not the real tracker file in the repo/worktree.

It now also calls out an easy failure mode: a patch that adds only `references[]`, `effort`, `related`, and `comment` is retrieval-only enrichment, not a complete migration batch for active tasks.

The migration guidance now also tells agents to evaluate the full author-owned field set for active tasks, including `goal`, `context.*`, and `blocker_reason`, rather than treating only the retrieval and execution-contract subsets as the whole job.

It also now makes the reference rule explicit: for linked repo-local trackers, keep repo file references portable and repo-relative. If a valid repo-relative reference is not producing snippets, `reload` and treat it as a resolver/runtime problem to report, not as a cue to rewrite the tracker with machine-specific absolute paths.

---

## How it looks under the hood

```
┌──────────┐    patch       ┌──────────────┐     merge     ┌──────────┐
│   LLM    ├───HTTP or file►│  Hub (Node)  │────────────►  │  <slug>  │
└──────────┘                │              │  atomic write │  .json   │
                            │              │               └──────────┘
┌──────────┐   drag/drop    │              │
│ Browser  ├───POST /move───►              │
└────▲─────┘                └──────┬───────┘
     │                             │
     └─────────WebSocket broadcast─┘
```

---

## Development

```bash
npm install
npm test           # Node's built-in test runner
npm start          # hub on http://localhost:4400
node bin/llm-tracker.js --daemon  # optional background hub in dev
```

Module map, internals, and schema deep-dive → **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## Contributing & releases

The repo ships every change through **issues → feature branch → PR → automated release**.

**1. Propose a change** — open a GitHub issue (`bug`, `enhancement`, etc.). Attach it to a milestone if you want it scoped to a specific release.

**2. Branch + PR** — branch off `main` using a prefix that matches the work (`fix/…`, `feat/…`, `docs/…`, `chore/…`). `main` is protected: no direct pushes, PR-only, linear history, squash-merge.

**3. PR title = Conventional Commits** — squash-merge uses the PR title as the commit subject on `main`. A CI check rejects titles that don't match `feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `chore:` / etc. Close the relevant issue with `Closes #N` in the body.

**4. Merge lands on `main` immediately** — no need to hold PRs for a release. Feature work and releases are decoupled.

**5. Release-please accumulates** — every commit on `main` updates a rolling "release PR" (auto-opened by [release-please](https://github.com/googleapis/release-please)) that bumps `package.json` and appends to `CHANGELOG.md` based on the commit types:

| Commit type(s) since last tag | Version bump        |
| ----------------------------- | ------------------- |
| any `feat!:` / `BREAKING CHANGE:` footer | major (x.0.0) |
| any `feat:`                   | minor (0.x.0)       |
| only `fix:` / `perf:`         | patch (0.0.x)       |
| only `chore:` / `ci:` / `test:` / `docs:` / `refactor:` | no bump (hidden from notes) |

**6. Cut a release** — merge the release PR when you want to ship. That tags `v*.*.*`, which triggers `publish.yml` → `npm publish`. You decide the cadence: after every feature, weekly, or whenever a milestone closes.

Workflow files: [`.github/workflows/release-please.yml`](./.github/workflows/release-please.yml), [`.github/workflows/pr-title.yml`](./.github/workflows/pr-title.yml), [`release-please-config.json`](./release-please-config.json).

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
