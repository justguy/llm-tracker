# LLM Project Tracker — Agent Contract

> **Canonical agent contract.** This file is served by `GET /help` and is the
> authoritative specification for agents interacting with the hub. The
> project-root `README.md` links into this document where it describes the
> agent contract — do not duplicate or overwrite the contract there.

You are being asked to read this because there is a **local project tracker** running on this machine. It's a Kanban board that reflects real project state to a human operator. Your job: keep the tracker in sync with what you're actually doing, using **small JSON patches** — not full-file rewrites.

Writes are **frequent and tiny**. Reads are **rare and only at decision points**. The hub is authoritative for structure (task order, which tasks exist, human UI state). You are authoritative for content (status, assignee, dependencies, context, new tasks, priority changes).

If the hub is running and you can make one HTTP call, prefer `GET /help` first. It serves this exact contract for the active workspace.

If your client supports MCP, prefer the `tracker_*` MCP tools over ad hoc `curl` once they are configured. The intended first call is still the same: `tracker_help`.

---

## 0. The rule that prevents the most common failure

> **The workspace root is the directory containing this file** — an absolute path like `/Users/adi/.llm-tracker/`. Every relative path below (`trackers/...`, `patches/...`) resolves against **that directory**, not against your current working directory.

Before you write anything:

- Know the absolute workspace path. The operator told you, or it defaults to `~/.llm-tracker/`. If unsure, ask.
- **DO NOT create a new `.llm-tracker/` folder anywhere else** — not in the user's repo, not in `/tmp`, not in your CWD.
- If you are about to write `README.md`, `templates/default.json`, `settings.json`, or anything else that is already in this workspace — **STOP**. The workspace already exists. You are writing to the wrong place.

**The safest way to avoid this entirely: use HTTP mode** (§7 Option B, §8 Mode B). HTTP mode requires zero filesystem access to the workspace.

### Local auth model (read this before your first write)

- The hub binds to `127.0.0.1` only by default. It is not reachable from other hosts.
- Mutating requests (`POST` / `PUT` / `PATCH` / `DELETE`) with an `Origin` or `Referer` that is neither loopback nor the exact hub origin serving that request get `403`. CLI tools and MCP clients that send no `Origin` are allowed.
- WebSocket upgrades to `/ws` use the same origin gate. Cross-origin browser tabs are rejected with `403`, so other sites cannot subscribe to tracker broadcasts.
- If the operator set `LLM_TRACKER_TOKEN`, every mutating request must carry `Authorization: Bearer <token>` (or `X-LLM-Tracker-Token: <token>`). The workspace `llm-tracker` CLI reads it from the same env var. The browser UI authenticates via a short-lived HttpOnly same-origin session cookie; the raw token is not exposed to page JavaScript.
- If the operator set `LLM_TRACKER_TOKEN`, `/ws` also requires that bearer token header (or `X-LLM-Tracker-Token`) unless the upgrade request carries the browser UI's short-lived same-origin session cookie.
- Default JSON body limit is 1 MB. Oversized `meta.scratchpad` (> 5000 chars), `task.comment` (> 500 chars), and `task.blocker_reason` (> 2000 chars) are rejected before merge.
- Deleted projects can be brought back by a human with `llm-tracker restore <slug>` or `POST /api/projects/<slug>/restore`. Agents must not call this unless explicitly asked.

### Supported topologies

The system supports two shapes:

- Recommended: one **shared workspace** such as `~/.llm-tracker/`, one shared daemon, many projects registered or symlinked into it.
- Supported: multiple isolated workspaces, each with its own daemon and port.

If a project keeps its tracker JSON in a repo and the hub registers it via **§7 Option C**, the repo-local file is only the project file. The **workspace is still the shared workspace** containing this README. That means:

- `patches/` means `<shared-workspace>/patches/`, not `<repo>/.llm-tracker/patches/`
- `.runtime/` means the shared workspace runtime metadata
- HTTP calls should still target the shared daemon

---

## 1. TL;DR

- **Hub owns structure. You own content.**
- **Hub enforces** — task array order, task existence (no accidental deletion), human UI state (`meta.swimlanes[i].collapsed`), version stamps (`updatedAt`, `rev`).
- **You write freely** — `status`, `assignee`, `dependencies`, `blocker_reason`, `context.*`, `placement.priorityId`, `placement.swimlaneId`, `meta.scratchpad`, new tasks.
- **Patch-mode new tasks must start open** — when you append a brand-new task through Mode A or Mode B, use `not_started` or `in_progress`, not `complete` or `deferred`.
- **When you need the next item**, prefer one call to `GET /api/projects/<slug>/next?limit=5` or `llm-tracker next <slug>` instead of scanning the whole tracker.
- **When the human asks a feature-shaped or fuzzy question**, prefer `GET /api/projects/<slug>/search?q=...` for semantic search or `GET /api/projects/<slug>/fuzzy-search?q=...` for deterministic lexical matching before rereading the full tracker.
- **When you need focused task context**, prefer one call to `GET /api/projects/<slug>/tasks/<taskId>/brief` or `llm-tracker brief <slug> <taskId>` instead of rereading docs and source files by hand.
- **When you need the task rationale**, prefer `GET /api/projects/<slug>/tasks/<taskId>/why` or `llm-tracker why <slug> <taskId>`.
- **When you need prior decision memory**, prefer `GET /api/projects/<slug>/decisions` or `llm-tracker decisions <slug>`.
- **When you are ready to act**, prefer `GET /api/projects/<slug>/tasks/<taskId>/execute` or `llm-tracker execute <slug> <taskId>`.
- **When you need a deterministic sign-off checklist**, prefer `GET /api/projects/<slug>/tasks/<taskId>/verify` or `llm-tracker verify <slug> <taskId>`.
- **When you need the contract**, prefer `GET /help` instead of guessing write modes, endpoint shapes, or status vocabulary.
- **When MCP is configured**, prefer `tracker_help`, `tracker_projects_status`, `tracker_project_status`, `tracker_next`, `tracker_search`, `tracker_fuzzy_search`, `tracker_brief`, `tracker_why`, `tracker_decisions`, `tracker_execute`, `tracker_verify`, `tracker_blockers`, `tracker_changed`, `tracker_history`, `tracker_pick`, `tracker_undo`, `tracker_redo`, and `tracker_reload` over raw `curl`.
- MCP read tools work directly from workspace files and do **not** require the daemon. MCP write tools (`tracker_pick`, `tracker_undo`, `tracker_redo`, `tracker_reload`) do require the hub or daemon to be reachable.
- If MCP resources are configured, prefer `tracker://help` for the full contract and `tracker://workspace/runtime` for daemon state, patch paths, and the read-vs-write daemon rule.
- If MCP prompts are configured, start with `tracker_start_here` and then use `tracker_pick_next`, `tracker_task_context`, `tracker_execute_task`, `tracker_verify_task`, or `tracker_patch_write` instead of inventing the workflow from scratch.
- **Writes are fire-and-forget patches.** No re-read before each write. The hub merges your changes under a per-project lock.
- **Reads at decision points only** — claiming a task, resolving a blocker, answering the human. Use `GET /api/projects/<slug>/since/<last-rev>` to pull only what changed; don't re-read the whole tracker.
- **On failure**, read `<slug>.errors.json` (file mode) or the JSON response body (HTTP mode). Both are structured `{error, type, hint}` with a precise path pointer.

---

## 2. Workspace layout

```
README.md                        ← you are here (already exists — do not overwrite)
settings.json                    ← hub-managed (already exists — do not touch)
trackers/<slug>.json             ← canonical project state. Hub writes this.
trackers/<slug>.errors.json      ← hub writes here when your update is rejected
patches/<slug>.<anything>.json   ← drop small update patches here (Mode A)
patches/<slug>.<anything>.errors.json  ← hub writes here when your patch is invalid
templates/default.json           ← copy this when registering (already exists)
.runtime/daemon.json             ← optional background-hub metadata (hub-managed)
.runtime/daemon.log              ← optional background-hub log output (hub-managed)
.snapshots/<slug>/<rev>.json     ← hub-managed per-rev snapshot (for rollback)
.history/<slug>.jsonl            ← hub-managed append-only event log (rev + delta)
```

### Quick self-check before writing

1. Do you know the absolute workspace path? (e.g. `/Users/adi/.llm-tracker/`)
2. Does the path you're about to write start with that absolute path?
3. Is the file you're writing under `trackers/` (registration) or `patches/` (updates)? **Anything else means you're wrong.**

If any is "no" or "unsure," ask the human before proceeding.

---

## 3. The contract

**What you update as work progresses:**

- `status` — `not_started` → `in_progress` when you start, → `complete` when shipped, → `deferred` when parked
- `assignee` — your model ID when you claim a task
- `dependencies` — task IDs this one blocks on; drives the derived **block state** (§5)
- `blocker_reason` — one sentence when stuck
- `context.*` — `tags`, `files_touched`, `notes`, anything diagnostic (shallow-merged per key)
- `placement.priorityId` and `placement.swimlaneId` — you *can* change these; last-write-wins against human drags
- `meta.scratchpad` — status banner to the human (rendered above the matrix)
- **New tasks** — include them in your patch; hub appends to the end of `tasks[]`, but brand-new patch tasks must start as `not_started` or `in_progress`

**What the hub enforces (you can't break these even if you try):**

- **Array order in `tasks[]`** — hub preserves its own order regardless of what you submit. Reorder happens only through the UI's drag endpoint.
- **Swimlane order in `meta.swimlanes`** — row order is human/UI-controlled. Reorder happens only through the UI lane move controls.
- **Deletion** — missing task IDs are kept, not deleted. To archive, set `status: "deferred"`. Deletion is human-only via the UI.
- **Tombstones** — when a human deletes a task, the id is recorded in `meta.deleted_tasks`. Any incoming write that tries to re-add that id is dropped with an `ignored` note. Pick a **new id** if you really need to reopen the work.
- **`meta.swimlanes[i].collapsed`** — human UI state. Hub always keeps the existing value; your submissions for this field are dropped.
- **`meta.deleted_tasks`** — hub-owned tombstone list. Any value you submit is ignored.
- **`updatedAt`, `rev`** — hub-owned, monotonic. Any value you submit is ignored and overwritten.

### Workflow

1. **Start of a work burst** — call `GET /api/projects/<slug>/next?limit=5` (or `llm-tracker next <slug>`) to pick what is next. Read the full tracker only when you need broader context than the shortlist gives you.
2. **During the burst** — write small patches constantly. No re-reading between writes. Each patch is self-contained.
3. **At the next decision point** — read again if needed. Use `since/<last-rev>` to pull only what changed.

---

## 4. Schema

Two top-level keys: `meta` and `tasks`.

### 4.1 `meta`

| Field        | Type                              | Required | Notes                                                                      |
| ------------ | --------------------------------- | :------: | -------------------------------------------------------------------------- |
| `name`       | string                            |    ✓    | Display name in the UI.                                                    |
| `slug`       | `^[a-z0-9][a-z0-9-]*$`            |    ✓    | Must match the filename stem: `<slug>.json`.                               |
| `swimlanes`  | array of swimlane objects         |    ✓    | ≥1. Row axis. Schema in §4.2.                                              |
| `priorities` | array of `{id, label}`            |    ✓    | ≥1. Column axis. Conventional IDs: `p0`–`p3`.                              |
| `scratchpad` | string                            |          | Status banner to the human.                                                |
| `updatedAt`  | ISO string \| null                |          | **Hub-owned.**                                                             |
| `rev`        | integer \| null                   |          | **Hub-owned.** Monotonic.                                                  |
| `deleted_tasks` | array of task ids \| null       |          | **Hub-owned.** Tombstones for human-deleted tasks — incoming writes that re-add any id listed here are refused. |

### 4.2 Swimlane

| Field         | Type       | Required | Notes                                                                     |
| ------------- | ---------- | :------: | ------------------------------------------------------------------------- |
| `id`          | string     |    ✓    | Stable identifier. Referenced from every `task.placement.swimlaneId`.     |
| `label`       | string     |    ✓    | Row header in the UI.                                                     |
| `description` | string     |          | Optional one-liner under the label.                                       |
| `collapsed`   | boolean    |          | **Hub-enforced.** Set by the human via UI. Your submissions are dropped.  |

### 4.3 Task

Tasks are ordered by array index. Hub owns the order.

| Field            | Type                                           | Required | Notes                                                 |
| ---------------- | ---------------------------------------------- | :------: | ----------------------------------------------------- |
| `id`             | string                                         |    ✓    | Unique within the project. Immutable.                 |
| `title`          | string                                         |    ✓    | Card headline.                                        |
| `goal`           | string                                         |          | One or two sentences under the title.                 |
| `status`         | enum (§5)                                      |    ✓    | `not_started` \| `in_progress` \| `complete` \| `deferred` |
| `placement`      | `{swimlaneId, priorityId}`                     |    ✓    | Both values must exist in `meta`.                     |
| `dependencies`   | array of task IDs                              |          | Drives block state (§6).                              |
| `assignee`       | string \| null                                 |          | Your model ID when claiming.                          |
| `reference`      | string \| null                                 |          | Legacy single source location as `path/to/file.ext:line` or `…:line-line`. Bare URLs are invalid. |
| `references`     | array of strings \| null                       |          | Preferred additive source list. Use the same `path:line` or `path:line-line` format. Bare URLs are invalid. |
| `effort`         | `xs`\|`s`\|`m`\|`l`\|`xl`\|null                |          | Optional sizing hint for ranking and planning.        |
| `related`        | array of task IDs \| null                      |          | Optional soft links to adjacent tasks.                |
| `comment`        | string \| null                                 |          | One short note that helps explain why the task matters. |
| `blocker_reason` | string \| null                                 |          | One sentence when stuck.                              |
| `definition_of_done` | array of strings \| null                   |          | Optional completion contract for future verify flows. |
| `constraints`    | array of strings \| null                       |          | Optional execution guardrails.                        |
| `expected_changes` | array of strings \| null                     |          | Optional modules, files, or artifacts expected to change. |
| `allowed_paths`  | array of strings \| null                       |          | Optional filesystem scope for future execution tooling. |
| `approval_required_for` | array of strings \| null                |          | Optional approval categories that make the task less ready than peers. |
| `context`        | object (freeform)                              |          | Shallow-merged per key on patch.                      |
| `updatedAt`      | ISO string \| null                             |          | **Hub-owned.**                                        |
| `rev`            | integer \| null                                |          | **Hub-owned.**                                        |

Prefer `references[]` for new data. Legacy `reference` remains valid for backward compatibility and is normalized alongside `references[]` when the hub builds ranked `next` responses.

Reference path rules:

- For trackers stored inside the shared workspace, relative reference paths resolve from the shared workspace root.
- For linked repo-local trackers such as `<repo>/.llm-tracker/trackers/<slug>.json` or `<repo>/.phalanx/<slug>.json`, relative reference paths resolve from the repo root, not from the hidden tracker directory and not from the shared workspace root.
- Prefer portable repo-relative references for repo files. Do **not** rewrite them into machine-specific absolute paths just to make snippets appear.
- Bare URLs are invalid in `reference` and `references[]`. Use a real file location with `:line` or `:line-line`.
- If a valid repo-relative reference is not producing a snippet, treat that as a reload/resolver issue to verify and report; do not "fix" it by baking local absolute paths into the tracker.

### 4.3a Migrating older trackers

If this workspace or tracker file started on `v0.1.1` or any pre-`0.2.0` setup:

- you do **not** need a bulk schema rewrite
- old tracker files remain valid
- legacy `reference` still works
- legacy `status: "partial"` is normalized to `in_progress`

When backfilling older tasks, write only author-owned metadata:

- `goal`
- `references[]`
- `effort`
- `related`
- `comment`
- `context.tags`
- `context.notes`
- `context.files_touched`
- `blocker_reason`
- `definition_of_done`
- `constraints`
- `expected_changes`
- `allowed_paths`
- `approval_required_for`

Do **not** write derived fields:

- `ready`
- `blocked_kind`
- `blocking_on`
- `requires_approval`
- `lastTouchedRev`
- `updatedAt`
- `rev`

Backfill active tasks first:

- `in_progress`
- `p0` / `p1`
- blocked tasks missing context

Skip low-value bulk rewrites of old completed tasks unless humans still ask about them.

When the project is linked from a repo worktree and the human wants branch-safe writes:

1. relink the shared workspace slug to the intended branch/worktree tracker file
2. run `reload <slug>`
3. verify a read call before writing patches

Do not assume the shared daemon is writing to the branch file unless the link was updated first.

For migration/backfill batches, prefer this order:

1. bounded `in_progress` tasks
2. bounded `p0` / `p1` tasks
3. blocked tasks missing context
4. broad roadmap/container rows only when they improve ranking or blocker explanations
5. remaining open but inactive tasks only if they still matter to search or active work

For bounded active tasks, do not stop at retrieval-only fields if the execution contract can be grounded. A strong first batch should usually include:

- `goal` when weak or stale
- `references[]`
- `effort`
- `comment`
- `context.tags`
- `context.notes`
- `context.files_touched`
- `blocker_reason` when the task is currently blocked
- `definition_of_done`
- `constraints`
- `expected_changes`
- `allowed_paths`
- `approval_required_for`

If a patch only adds `references[]`, `effort`, `related`, and `comment`, treat it as **retrieval-only enrichment**. Do not describe it as a complete migration batch for that task.

Do not append a brand-new standalone docs/workflow row through patch mode just to mark it `complete` or `deferred` immediately after. If the idea is already folded into an owning row, update that owning row instead of creating churn.

For active tasks, evaluate the whole author-owned field set and leave fields blank only when the repo/docs/tracker evidence truly does not support them.

The suggested field order in the migration guide is a sequence, not permission to ignore `goal`, `context.*`, or `blocker_reason` when there is real evidence for them.

After each batch, verify with `next`, `brief`, `execute`, `verify`, `search`, and `fuzzy-search`, then stop and report. Do **not** commit or refresh a PR unless the human explicitly asked you to.

### 4.4 Canonical example

```json
{
  "meta": {
    "name": "Project Phalanx",
    "slug": "phalanx",
    "swimlanes": [
      { "id": "execution", "label": "Execution Core" },
      { "id": "operator",  "label": "Operator Trust" }
    ],
    "priorities": [
      { "id": "p0", "label": "P0 / Now" },
      { "id": "p1", "label": "P1 / Next" },
      { "id": "p2", "label": "P2 / Soon" },
      { "id": "p3", "label": "P3 / Later" }
    ],
    "scratchpad": ""
  },
  "tasks": [
    {
      "id": "t-001",
      "title": "Live run progress surface",
      "goal": "Show which demo claims are real in a sticky banner.",
      "status": "in_progress",
      "placement": { "swimlaneId": "execution", "priorityId": "p0" },
      "dependencies": [],
      "assignee": "claude-opus-4-6",
      "context": { "tags": ["demo"], "files_touched": ["src/live-run.tsx"] }
    }
  ]
}
```

### 4.5 Cross-reference rules

- Every task's `placement.swimlaneId` must appear in `meta.swimlanes`.
- Every task's `placement.priorityId` must appear in `meta.priorities`.
- Every `dependencies[]` entry must reference a task `id` in the same project.
- Every `task.id` must be unique.

Violations → hub writes `<slug>.errors.json` with the exact failing pointer. Prior valid state stays live.

---

## 5. Status vocabulary

Four values only:

| Status        | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `not_started` | Not picked up yet.                                                         |
| `in_progress` | Actively being worked on. Set `assignee`.                                  |
| `complete`    | Shipped / merged / done.                                                   |
| `deferred`    | Intentionally parked. Use instead of deletion. Excluded from progress %.   |

Backward compatibility: legacy patches or tracker files that still send `status: "partial"` are normalized to `in_progress` on ingest. Canonical tracker state always writes back the four values above.

**Progress %** = `round((count(complete) + 0.5 * count(in_progress)) / (total - count(deferred)) * 100)`.

---

## 6. Block state (derived)

Computed by the hub on every write. You influence it via `dependencies` and `status`.

| State     | Definition                                                                           |
| --------- | ------------------------------------------------------------------------------------ |
| `blocked` | Any entry in `dependencies` references a task whose `status != complete`.            |
| `open`    | `dependencies` empty **or** every referenced task is `complete`.                     |

UI shows a red `BLOCKED BY <id>` badge and exposes a `[BLOCKED] / [OPEN]` filter.

`blocker_reason` is a separate, narrative field ("I'm stuck because…") — independent of graph-derived block state.

---

## 6.1 Getting the next task in one call

When the human asks "what's next?" or you need to pick work, call:

```bash
curl http://localhost:<PORT>/api/projects/<slug>/next?limit=5
```

or, if shell access is available:

```bash
llm-tracker next <slug>
```

The shortlist is deterministic and capped at 5 tasks:

- item 1 is the current recommendation
- items 2-5 are ranked alternatives
- each task includes `ready`, `blocked_kind`, `blocking_on`, `requires_approval`, normalized `references`, optional `effort`, freshness (`lastTouchedRev`), and `reason[]`
- bounded executable tasks rank ahead of aggregate roadmap/container rows when both are otherwise actionable
- active bounded work ranks ahead of starting a fresh bounded task

Use this instead of scanning the whole tracker just to choose work.

If MCP is configured, the matching tools are `tracker_projects_status`, `tracker_project_status`, `tracker_next`, `tracker_search`, `tracker_fuzzy_search`, `tracker_brief`, `tracker_why`, `tracker_decisions`, `tracker_execute`, `tracker_verify`, `tracker_blockers`, `tracker_changed`, `tracker_history`, `tracker_pick`, `tracker_undo`, `tracker_redo`, and `tracker_reload`.

Daemon rule:

- MCP reads do **not** require a running daemon.
- MCP writes (`tracker_pick`, `tracker_undo`, `tracker_redo`, `tracker_reload`) do require the shared hub or daemon.

Helpful MCP resources:

- `tracker://help` for the full workspace contract
- `tracker://workspace/status` for workspace + project summaries
- `tracker://workspace/runtime` for daemon state, runtime paths, and patch workflow
- `tracker://projects` for all project summaries
- `tracker://projects/<slug>/status` for one project summary

Register the MCP server in your client config instead of launching it manually in a spare shell. `llm-tracker mcp` is a stdio server, so the client should spawn and keep it alive.

Assume the package is installed and register the installed binary in your MCP config:

```toml
[mcp_servers.llm-tracker]
command = "llm-tracker"
args = ["mcp", "--path", "/Users/you/.llm-tracker"]
startup_timeout_sec = 60
```

If the client does not resolve installed binaries cleanly, use `npx`:

```toml
[mcp_servers.llm-tracker]
command = "npx"
args = ["llm-tracker", "mcp", "--path", "/Users/you/.llm-tracker"]
startup_timeout_sec = 60
```

Local checkout example:

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

Helpful MCP prompts:

- `tracker_start_here`
- `tracker_pick_next`
- `tracker_search_project`
- `tracker_task_context`
- `tracker_execute_task`
- `tracker_verify_task`
- `tracker_patch_write`

Related deterministic reads:

- `GET /api/projects/<slug>/tasks/<taskId>/brief` for one capped task-context pack: metadata, dependency context, references, snippets, and recent task history
- `GET /api/projects/<slug>/tasks/<taskId>/why` for one capped rationale pack: why the task exists now, what it blocks or unblocks, and recent task history
- `GET /api/projects/<slug>/decisions?limit=20` for the current project's recent decision notes
- `GET /api/projects/<slug>/tasks/<taskId>/execute` for one deterministic execution pack: readiness, guardrails, expected changes, references, and snippets
- `GET /api/projects/<slug>/tasks/<taskId>/verify` for one deterministic verification pack: explicit checks plus real evidence sources from tracker state, history, references, and snippets
- `GET /api/projects/<slug>/search?q=<query>` for semantic local-model search when the question is feature-shaped rather than task-id-shaped
- `GET /api/projects/<slug>/fuzzy-search?q=<query>` for deterministic fuzzy lexical fallback when you want approximate string matching without embeddings
- `GET /api/projects/<slug>/blockers` for structural blockers and what is blocking them
- `GET /api/projects/<slug>/changed?fromRev=<n>&limit=20` for changed tasks since a rev, without replaying raw history yourself
- `GET /api/projects/<slug>/history?limit=50` for the append-only revision log with structured rollback/undo/redo metadata
- `POST /api/projects/<slug>/pick` to atomically claim work once you know what to do next
- `POST /api/projects/<slug>/undo` to restore the previous effective project state
- `POST /api/projects/<slug>/redo` to reapply the most recent undo

### 6.2 Getting task context in one call

When you already know the task you are about to work on and need focused context, call:

```bash
curl http://localhost:<PORT>/api/projects/<slug>/tasks/<taskId>/brief
```

or:

```bash
llm-tracker brief <slug> <taskId>
```

The brief pack is deterministic and capped:

- task metadata and decision note
- dependency and related-task context
- normalized references with `selectedBecause`
- up to 5 extracted snippets, capped to 8 KB combined text
- up to 3 recent history entries for that task

Use this before broad repo reads. The intended flow is `/help` → `next` → `brief`/`why` → `execute` → `pick` → `verify`.

### 6.2b Answering fuzzy feature questions

When the human asks "what about the feature with the..." or you need to recover a task from concept-language instead of a task id, call:

```bash
curl "http://localhost:<PORT>/api/projects/<slug>/search?q=<query>"
curl "http://localhost:<PORT>/api/projects/<slug>/fuzzy-search?q=<query>"
```

or:

```bash
llm-tracker search <slug> <query>
llm-tracker fuzzy-search <slug> <query>
```

If MCP is configured, the matching tools are `tracker_search` and `tracker_fuzzy_search`.

- `search` is semantic local-model search backed by `@huggingface/transformers` and `Xenova/all-MiniLM-L6-v2`
- it tries the native Node runtime first, then a local WASM runtime, then a bundled offline hash runtime, and only then degrades to deterministic fuzzy matching
- if semantic has to fall back, `search` returns a warning; if model runtimes are unavailable it can still return semantic results with `backend: "semantic_hash_fallback"`, and only unexpected failures degrade to `backend: "fuzzy_fallback"`
- `fuzzy-search` is deterministic lexical fallback
- use the returned task ids to pivot into `brief` or `why`

### 6.3 Understanding why a task exists

When the human asks "why is this task here?" or you need to justify work before touching it, call:

```bash
curl http://localhost:<PORT>/api/projects/<slug>/tasks/<taskId>/why
```

or:

```bash
llm-tracker why <slug> <taskId>
```

The pack is deterministic and capped:

- task goal and decision note
- why-now reasons derived from priority, blockers, approvals, and freshness
- what the task is blocked by and what it unblocks
- normalized references with `selectedBecause`
- up to 3 recent history entries

### 6.4 Recalling recent decisions

When the human asks what you already decided, call:

```bash
curl http://localhost:<PORT>/api/projects/<slug>/decisions?limit=20
```

or:

```bash
llm-tracker decisions <slug>
```

This returns the current task comments/decision notes in deterministic order, newest first, capped at 20 items by default.

### 6.5 Building a deterministic execution plan

When you are about to start the task and want the current execution contract in one place, call:

```bash
curl http://localhost:<PORT>/api/projects/<slug>/tasks/<taskId>/execute
```

or:

```bash
llm-tracker execute <slug> <taskId>
```

The pack includes:

- current task state and readiness
- explicit execution contract fields: `definition_of_done`, `constraints`, `expected_changes`, `allowed_paths`
- approvals that still gate the task
- references and cached snippets
- recent task history

### 6.6 Building a deterministic verification checklist

When you need to confirm what evidence counts for sign-off, call:

```bash
curl http://localhost:<PORT>/api/projects/<slug>/tasks/<taskId>/verify
```

or:

```bash
llm-tracker verify <slug> <taskId>
```

The pack includes:

- explicit verification checks derived from `definition_of_done`, `expected_changes`, `allowed_paths`, and dependency state
- real evidence sources only: task state, recent history, references, and extracted snippets
- no guessed git diff or semantic inference

---

## 7. How to register a new project

Three options; pick whichever your CLI supports best. Prefer Option B (HTTP) — no filesystem access means no chance of writing to the wrong directory.

### Option A — File write (bash-less, works everywhere)

1. Read `templates/default.json` at the absolute workspace path.
2. Pick a `slug` (lowercase, dash-separated, unique).
3. Write the full project to `<workspace>/trackers/<slug>.json` with `meta.name`, `meta.slug`, `meta.swimlanes`, `meta.priorities`, and `tasks[]`.
4. Hub auto-discovers within ~500ms.

### Option B — HTTP PUT (no file paths to guess) *[preferred]*

```bash
# Write full project JSON to a file, then send it with --data-binary
curl -X PUT http://localhost:<PORT>/api/projects/<slug> \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/<slug>-init.json
```

`meta.slug` must match the URL slug or the hub rejects. Response: `{ok: true, slug}`.

### Option C — Symlink an existing project-local tracker

For when the human wants the tracker file to live in their project repo (version-controlled alongside the code) AND visible in the central tracker UI:

1. Write the project JSON to `<user-project>/.llm-tracker/trackers/<slug>.json` at the repo.
2. Ask the hub to symlink it in:

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/symlink \
  -H "Content-Type: application/json" \
  -d '{"target": "/absolute/path/to/<slug>.json"}'
```

The hub validates (must exist, be a regular `.json`, pass schema, `meta.slug` matches URL slug) and creates `<workspace>/trackers/<slug>.json` as a symlink. Rev stamps flow back through the symlink to the real file.

After linking:

- the hub automatically watches the linked target file for direct edits
- file patches still go to `<workspace>/patches/`
- HTTP updates still go to the shared daemon for that workspace

To unlink: `DELETE /api/projects/<slug>` removes the workspace symlink registration and leaves the target tracker file intact.

If the slug is already registered and the human explicitly wants to move the shared registration to a different branch/worktree file, the safe relink sequence is:

1. verify the new target file exists, is valid JSON, and already has the same `meta.slug`
2. call `DELETE /api/projects/<slug>` to remove only the current workspace symlink registration
3. call `POST /api/projects/<slug>/symlink` again with the new absolute target path
4. run `reload <slug>`
5. verify a read call before writing patches

This is the one safe exception to the normal "do not delete projects" rule for agents. In this relink flow, you are deleting only the shared symlink registration, not the real tracker file in the repo/worktree.

**Windows note:** `symlinkSync` requires Developer Mode or Administrator. If EPERM: fall back to Option B.

After registration, **never write to `trackers/<slug>.json` directly**. Use one of the two update modes (§8).

---

## 8. How to update — TWO MODES

### Mode A — File patches (bash-less, works everywhere)

Drop a small JSON patch in `patches/<slug>.<anything>.json`. Filename must start with `<slug>.` (e.g. `patches/phalanx.2026-04-13T12-00-00.json`).

Body — only fields you're changing:

```json
{
  "tasks": {
    "t-001": { "status": "complete", "context": { "notes": "shipped" } },
    "t-002": { "placement": { "priorityId": "p0" } }
  },
  "meta": { "scratchpad": "green build; pinned on t-002" }
}
```

Hub merges under a per-slug lock, writes merged state to `trackers/<slug>.json`, deletes the patch file. On failure: writes `patches/<slug>.<anything>.errors.json` and leaves your patch in place.

### Mode B — HTTP patches (fastest, requires pre-approved `curl`)

```bash
# 1. Write body to a temp file (avoids shell quoting + newline mangling)
# 2. Send it with --data-binary
curl -X POST http://localhost:<PORT>/api/projects/<slug>/patch \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/<slug>-patch.json
```

**Always use `--data-binary @file`, never inline `-d '...'`.** `-d` is curl's form-body mode: it strips newlines and may URL-decode special characters, which produces invalid JSON for multi-line `notes` or anything past a few hundred bytes. `--data-binary` sends file bytes verbatim. Use `--data-raw` only for tiny payloads with no newlines/quotes.

**On failure:** rerun with `curl -i` to capture the response. The hub returns structured JSON: `{error, type, hint}`.

### Merge semantics (both modes)

- `tasks` patch keyed by id → each listed task is field-merged with existing (shallow merge on `context` and `placement`; other fields replaced).
- `tasks` patch as an array → same, but tasks missing from the array are **preserved, not deleted**, with a warning in `notes`.
- New task IDs → **appended to the end of `tasks[]`**. You can't insert or reorder, and brand-new patch tasks must start as `not_started` or `in_progress`.
- `meta.swimlanes[i].collapsed` → always dropped. Hub keeps whatever's on disk.
- `updatedAt`, `rev` → always dropped. Hub-owned.

---

## 9. How to claim work

1. Call `GET /api/projects/<slug>/next?limit=5` or run `llm-tracker next <slug>`.
2. If you need focused context before claiming, call `GET /api/projects/<slug>/tasks/<taskId>/brief` or `llm-tracker brief <slug> <taskId>`.
3. If you need to justify the task before touching it, call `GET /api/projects/<slug>/tasks/<taskId>/why` or `llm-tracker why <slug> <taskId>`.
4. If you are about to implement, call `GET /api/projects/<slug>/tasks/<taskId>/execute` or `llm-tracker execute <slug> <taskId>`.
5. Pick the top-ranked task whose `ready` flag is `true`, unless the human explicitly redirects you.
6. Claim it atomically:

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/pick \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/<slug>-pick.json
```

Example body:

```json
{
  "assignee": "codex",
  "taskId": "t-001"
}
```

If you omit `taskId`, the hub claims the current top ready task from the deterministic `next` ranking.

Shell shortcut:

```bash
llm-tracker pick <slug> [<taskId>] --assignee codex
```

`llm-tracker claim ...` and `POST /api/projects/<slug>/claim` are aliases.

7. Do the work. Send patches freely as you go — status updates, context notes, files_touched.
8. Before sign-off, call `GET /api/projects/<slug>/tasks/<taskId>/verify` or `llm-tracker verify <slug> <taskId>`.
9. On completion: patch `status: "complete"`.
10. On blocker: patch `status: "not_started"` + `blocker_reason: "<one sentence>"`, and post to `meta.scratchpad`.

---

## 10. Versioning & "changes since rev N" (avoid re-reading the whole tracker)

The hub stamps `meta.rev` on every accepted change. Each rev is persisted three places:

- **Tracker file** — current rev only, in `meta.rev`
- **Snapshot** — `.snapshots/<slug>/<rev>.json`, full state at that rev
- **History log** — `.history/<slug>.jsonl`, one line per rev: `{rev, ts, delta, summary}`

### Read changes since rev N (primary refresh mechanism)

```bash
curl http://localhost:<PORT>/api/projects/<slug>/since/<your-last-rev>
```

Response:

```json
{
  "fromRev": 42,
  "currentRev": 47,
  "events": [
    {"rev": 43, "ts": "...", "delta": {"tasks": {"t-001": {"status": "in_progress"}}}, "summary": [...]},
    ...
  ]
}
```

Apply the deltas, update your `last-rev` to `currentRev`. **Payload size scales with number of events, not project size.** Use this instead of re-reading the whole tracker.

Each event's `delta` has three optional keys:

- `delta.meta` → `{key: newValue, …}` — meta fields that changed
- `delta.tasks` → `{taskId: {field: newValue, …} | {__added__: {...}} | {__removed__: true}}`
- `delta.order` → `[taskIds]` — new array order (only present if order changed)

### Rollback / Undo

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/rollback \
  -H "Content-Type: application/json" -d '{"to": 42}'
```

Rollback creates a new rev (`currentRev + 1`) whose content equals rev 42. History is **not** rewritten — the rollback appears as a normal event with `rolledBackTo: 42`.

**Only humans should rollback.** The UI's `[UNDO]` button is rollback to `currentRev - 1`. LLMs should not call this unilaterally.

### Deletion (human-only)

```bash
# Delete one task (hub removes it + scrubs its id from others' dependencies)
curl -X DELETE http://localhost:<PORT>/api/projects/<slug>/tasks/<taskId>

# Delete an entire project (removes trackers/<slug>.json; snapshots + history kept)
curl -X DELETE http://localhost:<PORT>/api/projects/<slug>
```

**LLMs must not call `DELETE`.** These are human operations, exposed in the UI as the `[×]` button on cards and the `[DELETE]` button in the header + drawer. To archive a task, set `status: "deferred"`.

---

## 11. Talking to the human

`meta.scratchpad` (string) is your **status banner** — rendered as a sticky line above the matrix. Overwrite freely; not an append-only log.

Good uses:

- What you're pinned on right now
- Green-or-not signals: test count, build status, typecheck state
- The next milestone or decision you need the human to make
- Assumptions you've made that the human should know about

For per-task diagnostics, use `context`. Suggested keys (none required):

- `context.tags: string[]` — pills on the card
- `context.files_touched: string[]` — grey sub-pills
- `context.notes: string` — one-liner under the goal

Additional keys render as `key: value` rows automatically.

---

## 12. When the hub rejects your write

- **Mode A (file patch)** → hub writes `patches/<same-name>.errors.json` next to your patch. Patch file is kept so you can fix and retry.
- **Mode B (HTTP)** → response body has `ok: false` and `{error, type, hint}`. Use `curl -i` to capture full headers.
- **Direct file edit of `trackers/<slug>.json`** (registration only) → `trackers/<slug>.errors.json`.

Error shape:

```json
{
  "error": "/tasks/0/references/0: reference must use path:line or path:line-line; bare URLs are invalid",
  "type": "schema",
  "hint": "Use repo-relative file references in `path:line` or `path:line-line` form. Bare URLs are invalid in `reference` and `references[]`.",
  "timestamp": "2026-04-13T12:34:56.000Z",
  "kind": "schema",
  "message": "/tasks/0/placement/priorityId: \"p9\" not declared in meta.priorities",
  "path": "/path/to/the/file"
}
```

`type` / `kind` is `parse` (malformed JSON) or `schema` (valid JSON, fails §4 or §4.5). `message` is kept for compatibility; prefer `error` + `hint` in new consumers. Prior valid state remains live.

---

## 13. CLI reference (if you can run shell commands)

| Command                                                   | Purpose                                                                       | Hub required |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | :----------: |
| `llm-tracker init [--path <dir>]`                         | Scaffold a workspace.                                                         |     no       |
| `llm-tracker [--path <dir>] [--port N]`                   | Start the hub + UI.                                                           |     no       |
| `llm-tracker [--path <dir>] [--port N] --daemon`          | Start the hub in the background.                                              |     no       |
| `llm-tracker daemon start [--path <dir>] [--port N]`      | Start the background hub.                                                     |     no       |
| `llm-tracker daemon stop [--path <dir>]`                  | Stop the background hub.                                                      |     no       |
| `llm-tracker daemon restart [--path <dir>] [--port N]`    | Restart the background hub on the same workspace.                             |     no       |
| `llm-tracker daemon status [--path <dir>]`                | Show background-hub pid / port / log path.                                    |     no       |
| `llm-tracker daemon logs [--path <dir>] [--lines N]`      | Print recent background-hub logs.                                             |     no       |
| `llm-tracker mcp [--path <dir>] [--port N]`               | Start the stdio MCP server exposing `tracker_*` tools.                        |     no       |
| `llm-tracker shortcuts [--alias NAME]`                    | Print shell shortcuts for zero-token `lt next`, `lt brief`, etc.              |     no       |
| `GET /healthz`                                            | Lightweight health probe: `{ok, projects, uptimeSeconds}`.                    |     no       |
| `GET /help`                                               | Fetch the current workspace agent contract over HTTP.                         |     no       |
| `llm-tracker status`                                      | Dashboard of all projects.                                                    |     no       |
| `llm-tracker status <slug>`                               | Detail view of one project.                                                   |     no       |
| `llm-tracker status --json`                               | Machine-readable dashboard.                                                   |     no       |
| `llm-tracker brief <slug> <taskId> [--json]`              | Focused task brief pack with references, snippets, and recent history.        |    **yes**   |
| `llm-tracker why <slug> <taskId> [--json]`                | Explain why a task matters now and what it blocks or unblocks.                |    **yes**   |
| `llm-tracker decisions <slug> [--json] [--limit N]`       | Recent project decision notes derived from task comments.                     |    **yes**   |
| `llm-tracker execute <slug> <taskId> [--json]`            | Deterministic execution pack with readiness, guardrails, and reading list.    |    **yes**   |
| `llm-tracker verify <slug> <taskId> [--json]`             | Deterministic verification checklist with tracker-backed evidence.             |    **yes**   |
| `llm-tracker blockers <slug> [--json]`                    | Structural blockers: blocked tasks plus the tasks blocking them.              |    **yes**   |
| `llm-tracker changed <slug> [<fromRev>] [--json] [--limit N]` | Changed tasks since a rev, grouped by task.                               |    **yes**   |
| `llm-tracker search <slug> <query> [--json] [--limit N]` | Semantic local-model search for feature-oriented questions.                  |    **yes**   |
| `llm-tracker fuzzy-search <slug> <query> [--json] [--limit N]` | Deterministic fuzzy lexical search.                                      |    **yes**   |
| `llm-tracker reload [<slug>] [--json]`                    | Reload one or all tracker files from disk into the running hub.               |    **yes**   |
| `llm-tracker pick <slug> [<taskId>] [--assignee ID] [--force] [--json]` | Atomically claim a task; defaults to the top ready task.         |    **yes**   |
| `llm-tracker next <slug> [--json] [--limit N]`            | Ranked shortlist of the next 1-5 tasks.                                       |    **yes**   |
| `llm-tracker since <slug> <rev> [--json]`                 | Events since the given rev.                                                   |    **yes**   |
| `llm-tracker rollback <slug> <rev>`                       | Roll back to a prior rev (human-only).                                        |    **yes**   |
| `llm-tracker link <slug> <abs-path>`                      | Symlink an external tracker (Option C).                                       |    **yes**   |
| `llm-tracker help`                                        | Show usage.                                                                   |     no       |

When a background daemon is running, hub-backed CLI commands reuse the recorded daemon port from `.runtime/daemon.json` if you omit `--port`. Do not edit `.runtime/` by hand.

Daemon state is workspace-scoped. In the recommended topology, everyone should point at the same shared workspace. Do **not** fix a stale daemon by creating another `.llm-tracker/` directory in a repo.

### Daemon mismatch recovery

The hub now rescans tracker files on startup, eagerly loads trackers created through `link`, auto-reloads missing slugs when a slug route is hit, and refreshes `/api/projects` from disk before returning the list.

If a tracker exists on disk but a slug still 404s or the UI is missing it:

1. If a specific slug 404s, retry the request once. The hub now attempts an on-demand reload first.
2. Run `llm-tracker reload <slug>` or `llm-tracker reload` before assuming the tracker file is bad.
3. If it was registered via §7 Option C, prefer `llm-tracker link ...` over hand-made symlinks because `link` now forces an eager load.
4. If the daemon itself is stale, run `llm-tracker daemon restart`.

If `llm-tracker daemon status` and actual hub reachability disagree:

1. Check `llm-tracker daemon logs [--path <dir>] --lines 120`.
2. If the workspace has a recorded PID but the port is dead, tell the human the daemon is wedged rather than silently creating a new workspace.
3. Recovery is: stop the stale PID, clear stale `.runtime/daemon.json` if needed, then restart the daemon on the same workspace.

### Wiring the status shortcut into the user's CLI

When the human asks you to "wire up the status command" or "add a skill for project status," drop a small integration file pointing at `npx llm-tracker status`. Don't reinvent the command.

| Environment                                                 | File                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| Claude Code (`~/.claude/` exists)                           | `~/.claude/skills/llm-tracker-status/SKILL.md`             |
| Cursor (`.cursor/` in the repo)                             | `.cursor/rules/llm-tracker.md`                             |
| Windsurf (`.windsurfrules` / `.windsurf/` in the repo)      | Append to `.windsurfrules`                                 |
| Aider (`.aider.conf.yml` / `CONVENTIONS.md` in the repo)    | Append to `CONVENTIONS.md`                                 |
| Generic / unknown                                           | `AGENTS.md` in the repo root                               |

Minimum content: one sentence saying *"For project status, run `npx llm-tracker status`."* Don't overwrite existing files — merge or append.

### Zero-token terminal shortcuts

If the human wants direct terminal commands in Codex or Claude without asking the model first, use:

```bash
eval "$(npx llm-tracker shortcuts)"
```

That installs a small `lt` shell function in the current shell, so the human can run `lt next <slug>`, `lt brief <slug> <taskId>`, `lt why ...`, `lt execute ...`, and `lt verify ...` directly with zero model tokens. To keep it permanently, append the printed snippet to `~/.zshrc` or `~/.bashrc`. Use `--alias <name>` if the human wants a different shell function name.

---

## 14. Hard rules (do not violate)

- **Never create a new `.llm-tracker/` folder outside the workspace** (§0).
- If the hub is running, read `/help` before guessing contract details.
- If MCP is configured, use `tracker_help` before guessing the contract and prefer the `tracker_*` tools over handwritten `curl`.
- If you know the task id, read `brief` before broad repo reads.
- If you need to explain or justify work, read `why` before guessing intent from raw fields.
- If the human asks what was already decided, read `decisions` instead of scanning every task comment manually.
- If you are about to change code, read `execute` before inventing a work plan.
- If you are about to mark work complete, read `verify` before guessing what counts as evidence.
- If a known slug 404s, retry once, then use `reload` before guessing the workspace is wrong.
- In shared-daemon mode, never drop patch files into a repo-local `.llm-tracker/` folder. Use the shared workspace or HTTP.
- Never write to `trackers/<slug>.json` after registration — use Mode A or Mode B patches.
- Never invent a `status` value outside the four in §5.
- Never invent a `priorityId` or `swimlaneId` not declared in `meta`.
- Never append a brand-new patch task as already `complete` or `deferred`; patch-mode task creation is for open work.
- Never add a standalone docs-only/workflow task and then immediately retire it if the work already belongs under an existing owning row.
- Never put bare URLs in `reference` or `references[]`; use `path:line` or `path:line-line`.
- Never set `updatedAt` or `rev` — hub ignores and overwrites.
- Never rewrite this README.
- Never touch `settings.json`, `.runtime/`, `.snapshots/`, `.history/`, `<slug>.errors.json`.
- Never call `DELETE /api/projects/:slug/tasks/:taskId` — human-only.
- Never call `DELETE /api/projects/...` unless the human explicitly asked you to relink a shared symlinked project registration to a different target file. In that one case, `DELETE /api/projects/<slug>` removes only the workspace symlink registration and leaves the target tracker file intact.
- Never call the rollback endpoint — human-only.
- Never call `POST /api/projects/<slug>/restore` on your own. Restore brings back a project that a human deleted; only run it if the human explicitly asks you to recover a deleted project.
- When symlinking (§7 Option C), the target path MUST be absolute and the file MUST be valid before you call the endpoint.
- Inline `curl -d '...'` for JSON: **no**. Use `--data-binary @file` (§8 Mode B).

You can try to delete a task, reorder `tasks[]`, or set `collapsed` — the hub will silently refuse. These are safety rails, not errors, so don't rely on them; just don't do it.
