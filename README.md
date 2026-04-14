# llm-tracker

**A Kanban board for LLMs to keep their humans up to date.**

[![npm](https://img.shields.io/npm/v/llm-tracker.svg)](https://www.npmjs.com/package/llm-tracker)
[![CI](https://github.com/justguy/llm-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/justguy/llm-tracker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)

Stop forcing your LLMs to re-read and rewrite massive architecture files just to update a status. `llm-tracker` is a **100 % local** mission-control center that bridges the gap between complex agentic workflows and human oversight.

It's a file-system-as-database tracker. Your LLMs update project states with tiny HTTP or file-based patches, and the local hub renders a live, **Bloomberg-terminal-style** priority matrix so you can see exactly what your agents are doing at a glance.

## Why use llm-tracker?

🔒 **100 % Local & Secure** — the hub makes zero external calls. It doesn't ping any LLM APIs; it watches your local filesystem, merges patches, and serves the UI. Your project state never leaves your machine.

💸 **Massive Token Savings** — no full-file rewrites. LLMs send surgical JSON patches (often <100 bytes) and pull changes since their last rev, keeping context windows small and API costs low.

⚡ **Stupidly Simple** — no databases, no daemons, no cloud accounts. `npx llm-tracker init`, `npx llm-tracker`, open the browser. Every project is one JSON file you can `cat`, diff, or commit.

---

## Screenshots

**Main view** — swimlane × priority matrix, scratchpad banner, status + block filters, segmented progress bar.

![Main view](./img/main-screen.png)

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
```

The first command prints a paste-ready prompt. Give it to any LLM with file-write or HTTP access, and your project appears in the UI within half a second.

Or install globally once:

```bash
npm install -g llm-tracker
llm-tracker init && llm-tracker
```

---

## Wire it into your LLM CLI

Drop a one-line file into your coding CLI's rules/skills folder. That's the whole install. Next time you ask "what's the state of my projects?" the LLM runs `npx llm-tracker status` on its own.

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

---

## Shell commands

```bash
# Works with hub NOT running — reads files directly
npx llm-tracker status              # dashboard of all projects
npx llm-tracker status <slug>       # detail on one project
npx llm-tracker status --json       # machine-readable

# Requires hub running
npx llm-tracker since <slug> <rev>  # event log since a rev (for LLMs to catch up)
npx llm-tracker rollback <slug> <rev>
npx llm-tracker link <slug> <abs-path>  # symlink an external tracker into the workspace
```

Full flag reference: `npx llm-tracker help`.

---

## The Contract (TL;DR)

**The hub owns structure. The LLM owns content.**

- **LLM writes** — statuses, assignees, dependencies, notes, tags, priorities, new tasks, scratchpad
- **Hub enforces** — task array order, existence (no accidental deletion), human UI state (drag positions, swimlane collapse), version stamps

LLMs send small patches. The hub merges them under a per-project lock, bumps `meta.rev`, writes a full snapshot, and appends a `{rev, delta}` line to the history log. When the LLM needs to refresh, it calls `GET /api/projects/:slug/since/<last-rev>` and gets only what changed — **constant-size payload regardless of project size**.

Two write modes:

- **Mode A — File patches** (bash-less): LLM drops a JSON patch in `patches/<slug>.<ts>.json`; hub picks it up and deletes it.
- **Mode B — HTTP patches** (fastest): `POST /api/projects/:slug/patch`; one-time `curl` approval in your CLI, then no filesystem access.

Full schema, merge semantics, field ownership, versioning, rollback, and the whole LLM-facing contract → **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

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
npm test           # 55 tests (Node's built-in test runner)
npm start          # hub on http://localhost:4400
```

Module map, internals, and schema deep-dive → **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## License

MIT — see [LICENSE](LICENSE).
