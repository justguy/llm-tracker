# Architecture

Deep-dive on the internals. For the marketing hook and installation, see [README.md](./README.md). For the LLM-facing contract, see [workspace-template/README.md](./workspace-template/README.md) — that's what gets copied into every workspace as the canonical spec for agents.

---

## Pieces

```
bin/llm-tracker.js       CLI: init | run | daemon start/stop/status/logs | status | since | rollback | link
hub/server.js            Express + WebSocket + chokidar wiring + vendor routes
hub/store.js             In-memory state, per-slug lock, applyPatch/applyMove/applyCollapse/rollback/deleteTask/deleteProject/symlinkProject
hub/merge.js             Hub-authoritative merge: preserves task order, refuses deletions, keeps collapsed, drops updatedAt/rev
hub/versioning.js        computeDelta (structured field-level diff), summarize, hasChanges
hub/snapshots.js         Per-rev .snapshots/<slug>/<rev>.json + .history/<slug>.jsonl append-only log
hub/runtime.js           Workspace runtime helpers (.runtime/, daemon pid/log metadata)
hub/validator.js         Ajv schema + cross-reference checks
hub/progress.js          Counts, pct, blocked-by derivation
hub/status.js            Terminal dashboard (used by `llm-tracker status`)
ui/index.html            Import map + mount
ui/app.js                Preact + htm components: Matrix, Cell, Card, Drawer, HelpModal, SettingsModal, FilterToggles, Dropdown
ui/styles.css            Bloomberg-terminal palette, dark (default) + light theme
workspace-template/      Copied on `init` into the workspace folder. README.md is the LLM-facing contract.
```

---

## Workspace layout

```
~/.llm-tracker/
├── README.md                   # LLM-facing contract (workspace-template/README.md)
├── settings.json               # hub config (port, etc.)
├── trackers/<slug>.json        # canonical project state
├── patches/<slug>.*.json       # LLM patches (Mode A) — transient
├── templates/default.json      # copy to start a new project
├── .runtime/daemon.json        # optional background-hub pid/port metadata
├── .runtime/daemon.log         # optional background-hub stdout/stderr
├── .snapshots/<slug>/<rev>.json # hub-managed full snapshot per rev (rollback source)
└── .history/<slug>.jsonl       # append-only event log: {rev, ts, delta, summary}
```

---

## Schema

Every tracker JSON has two top-level keys: `meta` and `tasks`.

### meta

| Field        | Type                              | Required | Notes                                                              |
| ------------ | --------------------------------- | :------: | ------------------------------------------------------------------ |
| `name`       | string                            |    ✓     | Display name in the UI.                                            |
| `slug`       | `^[a-z0-9][a-z0-9-]*$`            |    ✓     | Must match the filename stem (`<slug>.json`).                      |
| `swimlanes`  | array of swimlane objects         |    ✓     | ≥ 1. Row axis. See below.                                          |
| `priorities` | array of `{id, label}`            |    ✓     | ≥ 1. Column axis. Conventional: `p0`–`p3`.                         |
| `scratchpad` | string (≤ 5000 chars)             |          | LLM's status banner to the human. Rendered above the matrix, collapsed by default, editable inline. |
| `updatedAt`  | ISO string \| null                |          | **Hub-owned.**                                                     |
| `rev`        | integer \| null                   |          | **Hub-owned.** Monotonic, bumps on every accepted change.          |

**Swimlane object:**

| Field         | Type       | Required | Notes                                                         |
| ------------- | ---------- | :------: | ------------------------------------------------------------- |
| `id`          | string     |    ✓     | Stable. Referenced from `task.placement.swimlaneId`.          |
| `label`       | string     |    ✓     | Row header in the UI.                                         |
| `description` | string     |          | One-liner shown under the label.                              |
| `collapsed`   | boolean    |          | **Human-owned.** UI state. Hub preserves it on every write.   |

### tasks

Ordered by array index. Hub owns the order.

| Field            | Type                                           | Required | Notes                                                 |
| ---------------- | ---------------------------------------------- | :------: | ----------------------------------------------------- |
| `id`             | string                                         |    ✓     | Unique, immutable.                                    |
| `title`          | string                                         |    ✓     | Card headline.                                        |
| `goal`           | string                                         |          | Short description under the title.                    |
| `status`         | `not_started`\|`in_progress`\|`complete`\|`deferred` |  ✓   | See §Status vocabulary.                               |
| `placement`      | `{swimlaneId, priorityId}`                     |    ✓     | Both values must exist in `meta`.                     |
| `dependencies`   | array of task ids                              |          | Drives **block state** (§Block state).                |
| `assignee`       | string \| null                                 |          | LLM's model id when claimed.                          |
| `reference`      | string \| null                                 |          | Source location as `path/to/file.ext:line` or `…:line-line`. |
| `comment`        | string \| null (≤ 500 chars)                   |          | One free-form note per task. Rendered as a `[C]` badge with a hover popover. |
| `blocker_reason` | string \| null                                 |          | One sentence when the LLM is stuck.                   |
| `context`        | object (freeform)                              |          | Tags, files touched, notes — shallow-merged on patch. |
| `updatedAt`      | ISO string \| null                             |          | **Hub-owned.**                                        |
| `rev`            | integer \| null                                |          | **Hub-owned.**                                        |

### Cross-reference rules

- Every `task.placement.swimlaneId` must appear in `meta.swimlanes`.
- Every `task.placement.priorityId` must appear in `meta.priorities`.
- Every `task.dependencies[]` entry must reference an existing `task.id`.
- Every `task.id` must be unique.

Violations → hub writes `<slug>.errors.json` and keeps the prior valid state live.

---

## Status vocabulary

Four values only:

| Status        | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `not_started` | Not picked up.                                                             |
| `in_progress` | Actively being worked. `assignee` should be set.                           |
| `complete`    | Shipped.                                                                   |
| `deferred`    | Intentionally parked. Excluded from progress %; LLMs use this in place of deletion. |

**Progress %** = `round((count(complete) + 0.5 * count(in_progress)) / (total - count(deferred)) * 100)`.

---

## Block state (derived)

Computed on every accepted write. LLMs don't set it; they influence it via `dependencies` and `status`.

| State     | Definition                                                                |
| --------- | ------------------------------------------------------------------------- |
| `blocked` | Any entry in `dependencies` references a task whose `status != complete`. |
| `open`    | `dependencies` empty **or** every referenced task is `complete`.          |

`blocker_reason` (narrative) is distinct from block state (structural / graph-derived).

---

## Versioning & history

Every accepted write:

1. Bumps `meta.rev` (monotonic integer, persisted in the file).
2. Writes a full snapshot to `.snapshots/<slug>/<rev>.json`.
3. Appends `{rev, ts, delta, summary}` to `.history/<slug>.jsonl`.

The **delta** is a structured field-level diff:

```json
{
  "meta": { "scratchpad": "new text" },
  "tasks": {
    "t-001": { "status": "complete" },
    "t-009": { "__added__": { "id": "t-009", "title": "...", ... } },
    "t-017": { "__removed__": true }
  },
  "order": ["t-001", "t-002", ...]
}
```

The three optional keys (`meta`, `tasks`, `order`) each appear only when changed.

### Reading changes since a rev (instead of re-reading the tracker)

```bash
curl http://localhost:<PORT>/api/projects/<slug>/since/<last-rev>
```

Returns `{fromRev, currentRev, events: [...]}`. Apply deltas, update your `last-rev`. Payload size scales with *number of events*, not *project size*.

### Rollback

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/rollback \
  -H "Content-Type: application/json" -d '{"to": 42}'
```

Creates a new rev (current + 1) whose content equals rev 42. History is never rewritten — the rollback appears as an event with `rolledBackTo: 42`. The UI's `[UNDO]` button is a rollback to `currentRev - 1`.

---

## Merge semantics

When a write arrives (whether via HTTP patch, file patch, or direct file edit), the hub merges the incoming against the current state using these rules:

- **Tasks keyed by id** → each listed task field-merged with existing. `context` and `placement` shallow-merged; other fields replaced.
- **Tasks as an array** (full-file write) → same, but tasks missing from the array are **preserved, not deleted**, with a warning in `notes`.
- **New task ids** → appended to the end of `tasks[]`. LLMs can't insert at a specific index or reorder.
- **`meta.swimlanes[].collapsed`** → always preserved from existing state. LLM submissions for this field are silently dropped.
- **`updatedAt`, `rev`** → always hub-stamped; LLM submissions are ignored.

The effect: LLMs can send whatever they want without risk of corrupting structure. The hub makes invalid transitions structurally impossible.

---

## Registration — three ways

**Option A — File write** (bash-less): write the full project to `<workspace>/trackers/<slug>.json`. Hub auto-discovers.

**Option B — HTTP PUT** (no path guessing):

```bash
curl -X PUT http://localhost:<PORT>/api/projects/<slug> \
  -H "Content-Type: application/json" \
  --data-binary @project.json
```

`meta.slug` must match the URL slug.

**Option C — Symlink** (file stays in the user's repo, visible in the central UI):

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/symlink \
  -H "Content-Type: application/json" \
  -d '{"target": "/absolute/path/to/<slug>.json"}'
```

Hub creates `<workspace>/trackers/<slug>.json` as a symlink. Polling on the trackers dir picks up target-file changes.

---

## Updates — two modes

**Mode A — File patches** (bash-less):

Drop a JSON patch at `patches/<slug>.<anything>.json`. Hub merges atomically under a per-slug lock and deletes the patch file.

```json
{
  "tasks": {
    "t-001": { "status": "complete", "context": { "notes": "shipped" } },
    "t-002": { "placement": { "priorityId": "p0" } }
  },
  "meta": { "scratchpad": "..." }
}
```

**Mode B — HTTP patches** (fastest, requires pre-approved `curl`):

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/patch \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/patch.json
```

**Always use `--data-binary @file`, never inline `-d '...'`** — `-d` is curl's form-body mode and strips newlines + can URL-decode special characters, which corrupts JSON bodies. `--data-binary` sends file bytes verbatim.

---

## HTTP API reference

| Endpoint                                            | Method | Purpose                                                    |
| --------------------------------------------------- | :----: | ---------------------------------------------------------- |
| `/api/workspace`                                    | GET    | Workspace paths (readme, root).                            |
| `/api/settings`                                     | GET/PUT| Hub config (port).                                         |
| `/api/projects`                                     | GET    | List of projects with derived counts.                      |
| `/api/projects/:slug`                               | GET    | Full project state.                                        |
| `/api/projects/:slug`                               | PUT    | Create or replace a project (full body).                   |
| `/api/projects/:slug`                               | DELETE | Remove the tracker file. Snapshots/history preserved.      |
| `/api/projects/:slug/patch`                         | POST   | Partial update merged with existing state.                 |
| `/api/projects/:slug/move`                          | POST   | UI drag-drop: change task placement + array position.      |
| `/api/projects/:slug/swimlane-collapse`             | POST   | Toggle `meta.swimlanes[i].collapsed`.                      |
| `/api/projects/:slug/tasks/:taskId`                 | DELETE | Remove one task; hub scrubs its id from other deps.        |
| `/api/projects/:slug/since/:rev`                    | GET    | Events after the given rev.                                |
| `/api/projects/:slug/revisions`                     | GET    | All revs with summaries.                                   |
| `/api/projects/:slug/rollback`                      | POST   | Create a new rev with the content of an older rev.         |
| `/api/projects/:slug/symlink`                       | POST   | Register a project by symlinking an external JSON.         |
| `/api/history/:slug`                                | GET    | Last 50 raw history lines.                                 |
| `/README.md`                                        | GET    | Serve the workspace README.                                |
| `/ws`                                               | WS     | WebSocket: SNAPSHOT on connect, UPDATE/ERROR/REMOVE on change. |

All errors return JSON: `{error, type?, hint?}`. Body limit: 16 MB.

---

## Field ownership summary

| Field                                              | Owner       |
| -------------------------------------------------- | ----------- |
| task `status`, `assignee`, `dependencies`, `blocker_reason`, `context.*` | LLM |
| task `placement.priorityId`, `placement.swimlaneId`| LLM (shared with UI drag; last-write-wins)           |
| `meta.name`, `meta.priorities`, `meta.swimlanes[].{id,label,description}`, `meta.scratchpad` | LLM |
| `meta.swimlanes[].collapsed`                       | Human (UI)  |
| Task array order                                   | Hub (structural) |
| `meta.updatedAt`, `meta.rev`, `task.updatedAt`, `task.rev` | Hub |

---

## Port resolution

First match wins:

1. `--port N` flag
2. `LLM_TRACKER_PORT` env
3. `<workspace>/settings.json` → `port`
4. Default `4400`

---

## Background daemon

Foreground startup remains the default: `llm-tracker` starts the hub in the current shell.

Daemon mode is explicit:

- `llm-tracker --daemon`
- `llm-tracker daemon start`
- `llm-tracker daemon stop`
- `llm-tracker daemon status`
- `llm-tracker daemon logs --lines N`

Daemon runtime files live under `<workspace>/.runtime/`. Existing workspaces do not need manual migration; the directory is created lazily on first daemon start.

---

## Workspace resolution

First match wins:

1. `--path <dir>` flag
2. `LLM_TRACKER_HOME` env
3. Default `~/.llm-tracker/`

---

## Implementation notes

### Symlink-aware atomic writes

`atomicWriteJson(file, data)` writes to a temp file and `rename`s it into place. A naive `renameSync(tmp, file)` on top of a symlink **replaces the symlink with a regular file** — killing Option C's whole point. The hub resolves the symlink first with `realpathSync` and renames onto the real target, so the symlink survives any number of writes and the rev stamps flow through to the original file in the user's repo.

### Polling-based file watching

Chokidar uses native fsevents on macOS, which subscribes to directory events. When a tracker file in `trackers/` is a symlink to a file in a **different directory** (Option C), writes to the target file fire OS events in *that* other directory — which fsevents on the trackers dir does not see. The hub therefore runs chokidar with `usePolling: true, interval: 300`: `stat()` every ~300 ms picks up changes to target files regardless of where they live. For a local tool watching a handful of files, polling overhead is negligible.

### Body parsing & error format

Express JSON body limit is **16 MB**. Any body-parser failure (too-large, malformed JSON) is handled by a custom error middleware that returns `{error, type, hint}` instead of Express's default HTML error page — so LLMs always get a machine-readable response.

### Cold-start resume

On hub start, each tracker file's `meta.rev` is compared against the snapshot at that rev. If they match (normal shutdown → restart case), the hub resumes silently without creating a phantom "all tasks added" event. If the file differs from its snapshot (e.g. someone edited it while the hub was down), that delta becomes a new rev with a correct history entry.

### Concurrency

- **Per-slug write lock** — `store.withLock(slug, fn)` serializes all mutations to a project: HTTP patches, UI drags, collapses, rollbacks, deletions. Two simultaneous requests to the same slug run sequentially; different slugs run in parallel.
- **In-memory-first for structure-changing ops** — `rollback`, `deleteTask`, `applyCollapse` update in-memory state *before* writing the file. The chokidar re-ingest from that write sees matching state and no-ops. This avoids the merge layer (which is designed to protect against LLM accidents) from clobbering legitimate hub-initiated changes.

### What's deliberately NOT implemented

- **Per-agent patch files** — two agents writing the *same task's same fields* in the same second still get last-write-wins. Avoided in favour of simpler HTTP patches. Revisit if you hit a real concurrency collision in practice.
- **Offline esm.sh fallback** — Preact + htm are vendored from `node_modules` via resolved paths, so the UI works offline after `npm install`. No runtime fetch from esm.sh.
- **Cross-volume atomic renames** — temp files are written next to their target (resolved through symlinks), so `rename` is always same-volume. Cross-filesystem edge cases don't apply.
