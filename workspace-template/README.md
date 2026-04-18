# LLM Project Tracker — Agent Contract

You are being asked to read this because there is a **local project tracker** running on this machine. It's a Kanban board that reflects real project state to a human operator. Your job: keep the tracker in sync with what you're actually doing, using **small JSON patches** — not full-file rewrites.

Writes are **frequent and tiny**. Reads are **rare and only at decision points**. The hub is authoritative for structure (task order, which tasks exist, human UI state). You are authoritative for content (status, assignee, dependencies, context, new tasks, priority changes).

---

## 0. The rule that prevents the most common failure

> **The workspace root is the directory containing this file** — an absolute path like `/Users/adi/.llm-tracker/`. Every relative path below (`trackers/...`, `patches/...`) resolves against **that directory**, not against your current working directory.

Before you write anything:

- Know the absolute workspace path. The operator told you, or it defaults to `~/.llm-tracker/`. If unsure, ask.
- **DO NOT create a new `.llm-tracker/` folder anywhere else** — not in the user's repo, not in `/tmp`, not in your CWD.
- If you are about to write `README.md`, `templates/default.json`, `settings.json`, or anything else that is already in this workspace — **STOP**. The workspace already exists. You are writing to the wrong place.

**The safest way to avoid this entirely: use HTTP mode** (§7 Option B, §8 Mode B). HTTP mode requires zero filesystem access to the workspace.

---

## 1. TL;DR

- **Hub owns structure. You own content.**
- **Hub enforces** — task array order, task existence (no accidental deletion), human UI state (`meta.swimlanes[i].collapsed`), version stamps (`updatedAt`, `rev`).
- **You write freely** — `status`, `assignee`, `dependencies`, `blocker_reason`, `context.*`, `placement.priorityId`, `placement.swimlaneId`, `meta.scratchpad`, new tasks.
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
- **New tasks** — include them in your patch; hub appends to the end of `tasks[]`

**What the hub enforces (you can't break these even if you try):**

- **Array order in `tasks[]`** — hub preserves its own order regardless of what you submit. Reorder happens only through the UI's drag endpoint.
- **Deletion** — missing task IDs are kept, not deleted. To archive, set `status: "deferred"`. Deletion is human-only via the UI.
- **`meta.swimlanes[i].collapsed`** — human UI state. Hub always keeps the existing value; your submissions for this field are dropped.
- **`updatedAt`, `rev`** — hub-owned, monotonic. Any value you submit is ignored and overwritten.

### Workflow

1. **Start of a work burst** — read the relevant task (for full context) or the tracker index (to pick what's next). One read per decision.
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
| `blocker_reason` | string \| null                                 |          | One sentence when stuck.                              |
| `context`        | object (freeform)                              |          | Shallow-merged per key on patch.                      |
| `updatedAt`      | ISO string \| null                             |          | **Hub-owned.**                                        |
| `rev`            | integer \| null                                |          | **Hub-owned.**                                        |

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

To unlink: `DELETE /api/projects/<slug>` removes the symlink, leaves the target intact.

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
- New task IDs → **appended to the end of `tasks[]`**. You can't insert or reorder.
- `meta.swimlanes[i].collapsed` → always dropped. Hub keeps whatever's on disk.
- `updatedAt`, `rev` → always dropped. Hub-owned.

---

## 9. How to claim work

1. Read the tracker (`GET` the file, or `curl http://localhost:<PORT>/api/projects/<slug>`).
2. Find the highest-priority task (`p0` > `p1` > `p2` > `p3`) with `status == "not_started"` and block state `open`.
3. Send a patch: `{ tasks: { <id>: { status: "in_progress", assignee: "<your model id>", blocker_reason: null } } }`.
4. Do the work. Send patches freely as you go — status updates, context notes, files_touched.
5. On completion: patch `status: "complete"`.
6. On blocker: patch `status: "not_started"` + `blocker_reason: "<one sentence>"`, and post to `meta.scratchpad`.

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
  "timestamp": "2026-04-13T12:34:56.000Z",
  "kind": "schema",
  "message": "/tasks/0/placement/priorityId: \"p9\" not declared in meta.priorities",
  "path": "/path/to/the/file"
}
```

`kind` is `parse` (malformed JSON) or `schema` (valid JSON, fails §4 or §4.5). Prior valid state remains live.

---

## 13. CLI reference (if you can run shell commands)

| Command                                                   | Purpose                                                                       | Hub required |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | :----------: |
| `llm-tracker init [--path <dir>]`                         | Scaffold a workspace.                                                         |     no       |
| `llm-tracker [--path <dir>] [--port N]`                   | Start the hub + UI.                                                           |     no       |
| `llm-tracker status`                                      | Dashboard of all projects.                                                    |     no       |
| `llm-tracker status <slug>`                               | Detail view of one project.                                                   |     no       |
| `llm-tracker status --json`                               | Machine-readable dashboard.                                                   |     no       |
| `llm-tracker since <slug> <rev> [--json]`                 | Events since the given rev.                                                   |    **yes**   |
| `llm-tracker rollback <slug> <rev>`                       | Roll back to a prior rev (human-only).                                        |    **yes**   |
| `llm-tracker link <slug> <abs-path>`                      | Symlink an external tracker (Option C).                                       |    **yes**   |
| `llm-tracker help`                                        | Show usage.                                                                   |     no       |

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

---

## 14. Hard rules (do not violate)

- **Never create a new `.llm-tracker/` folder outside the workspace** (§0).
- Never write to `trackers/<slug>.json` after registration — use Mode A or Mode B patches.
- Never invent a `status` value outside the four in §5.
- Never invent a `priorityId` or `swimlaneId` not declared in `meta`.
- Never set `updatedAt` or `rev` — hub ignores and overwrites.
- Never rewrite this README.
- Never touch `settings.json`, `.snapshots/`, `.history/`, `<slug>.errors.json`.
- Never call `DELETE /api/projects/...` or `DELETE /api/projects/:slug/tasks/:taskId` — human-only. Archive with `status: "deferred"`.
- Never call the rollback endpoint — human-only.
- When symlinking (§7 Option C), the target path MUST be absolute and the file MUST be valid before you call the endpoint.
- Inline `curl -d '...'` for JSON: **no**. Use `--data-binary @file` (§8 Mode B).

You can try to delete a task, reorder `tasks[]`, or set `collapsed` — the hub will silently refuse. These are safety rails, not errors, so don't rely on them; just don't do it.
