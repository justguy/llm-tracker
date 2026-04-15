# llm-tracker

**A Kanban board for LLMs to keep their humans up to date.**

[![npm](https://img.shields.io/npm/v/llm-tracker.svg)](https://www.npmjs.com/package/llm-tracker)
[![CI](https://github.com/justguy/llm-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/justguy/llm-tracker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)

Stop forcing your LLMs to re-read and rewrite massive architecture files just to update a status. `llm-tracker` is a **100 % local** mission-control center that bridges the gap between complex agentic workflows and human oversight.

It's a file-system-as-database tracker. Your LLMs update project states with tiny HTTP or file-based patches, and the local hub renders a live, **Bloomberg-terminal-style** priority matrix so you can see exactly what your agents are doing at a glance.

When an agent needs to answer "what should I do next?", it can now make one call to `npx llm-tracker next <slug>` or `GET /api/projects/<slug>/next` and get a ranked shortlist instead of re-reading the full tracker.

## Why use llm-tracker?

🔒 **100 % Local & Secure** — the hub makes zero external calls. It doesn't ping any LLM APIs; it watches your local filesystem, merges patches, and serves the UI. Your project state never leaves your machine.

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
npx llm-tracker blockers <slug>        # structural blockers and what they are waiting on
npx llm-tracker changed <slug> <rev>   # changed tasks since a rev
npx llm-tracker pick <slug> [task-id] --assignee codex  # atomic claim, defaults to top ready task
npx llm-tracker next <slug> [--limit 5]  # ranked shortlist: recommendation + alternatives
npx llm-tracker since <slug> <rev>  # event log since a rev (for LLMs to catch up)
npx llm-tracker rollback <slug> <rev>
npx llm-tracker link <slug> <abs-path>  # symlink an external tracker into the workspace

# Optional background lifecycle
npx llm-tracker --daemon                  # start hub in the background
npx llm-tracker daemon status             # show pid / port / log path
npx llm-tracker daemon stop               # stop the background hub
npx llm-tracker daemon logs --lines 80    # print recent daemon logs
```

Full flag reference: `npx llm-tracker help`.

## Background daemon

Foreground startup is still the default. Existing users can keep using `npx llm-tracker` exactly as before.

If you want the hub to keep running without a dedicated shell, use `npx llm-tracker --daemon` or `npx llm-tracker daemon start`. Runtime artifacts live under `~/.llm-tracker/.runtime/` by default:

- `daemon.json` stores pid, port, and startup metadata
- `daemon.log` captures hub stdout and stderr

Existing workspaces do not need migration work. The `.runtime/` directory is created on demand the first time daemon mode is used.

Hub-backed CLI commands reuse the active daemon port from `.runtime/daemon.json` when you omit `--port`, so `next`, `since`, `rollback`, and `link` keep working against a background hub started on a non-default port.

---

## The Contract (TL;DR)

**The hub owns structure. The LLM owns content.**

- **LLM writes** — statuses, assignees, dependencies, notes, tags, priorities, new tasks, scratchpad
- **Hub enforces** — task array order, existence (no accidental deletion), human UI state (drag positions, swimlane collapse), version stamps

LLMs send small patches. The hub merges them under a per-project lock, bumps `meta.rev`, writes a full snapshot, and appends a `{rev, delta}` line to the history log. When the LLM needs to refresh, it calls `GET /api/projects/:slug/since/<last-rev>` and gets only what changed — **constant-size payload regardless of project size**.

For task pickup, prefer the atomic claim flow over hand-built status patches:

- `POST /api/projects/:slug/pick`
- `npx llm-tracker pick <slug> [task-id] --assignee <model>`

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

MIT — see [LICENSE](LICENSE).
