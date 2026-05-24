# Technical Design Document: llm-tracker Session Hub

**Product:** llm-tracker Session Hub  
**Status:** Draft v0.3  
**Primary constraint:** local-first, tracker-native, simple UI, deterministic runtime behavior  
**Critical safety rule:** raw stdio is display-only; never infer semantic state from terminal text

---

## 1. Summary

Session Hub adds a runtime control plane to `llm-tracker` for tracking and orchestrating active coding-agent sessions. Existing tracker JSON files remain durable project truth. Runtime session/job/skill state lives under `.runtime`, driven by a serialized event store and in-memory projection.

The system introduces:

- `RuntimeStore` — serialized append-only event store and projection.
- `SessionRegistry` — active sessions and capability tiers.
- `JobRegistry` — task/session/profile executions.
- `SkillsRegistry` — workflow skills and job profile hooks.
- `ActivityMonitor` — derives the `quiet` state and warning subtypes (`quiet_terminal`, `missing_heartbeat`) from structured signals only; never from raw stdio text.
- `ProjectWorkspaceWatcher` — watcher/git-derived file change/conflict evidence.
- `ContextPackService` — deterministic start/resume/rollover/handoff packs.
- `ProcessSessionAdapter` — raw stdio display and process lifecycle only.
- `McpTrackedSessionAdapter` — explicit session/job/skill events from agents.
- `CodexAppServerAdapter` — structured chat, approvals, and event ingestion.
- UI: session rail, Session Hub view, tool shelf, session drawer, layout state.

---

## 2. Architecture fit

The existing `llm-tracker` architecture has a Browser UI, Express/WebSocket hub, Store/merge engine, tracker JSON files, patch ingestion, snapshots/history, CLI commands, MCP server, and deterministic task-intelligence endpoints.

Session Hub should plug in without changing durable tracker semantics:

```text
Browser / CLI / MCP / AppServer
  -> Hub HTTP or WS
  -> RuntimeStore for session/job/skill events
  -> Existing Store for durable project/task writes
  -> WebSocket broadcast to UI
```

Durable tracker writes still use the existing Store and per-project merge/revision behavior. Runtime writes never bypass `RuntimeStore`.

---

## 3. Source-of-truth model

### 3.1 Durable truth

```text
trackers/<slug>.json
.snapshots/<slug>/
.history/<slug>.jsonl
```

Owns project/task state, dependencies, DoD, durable notes, decisions, references, rev, history, and snapshots.

### 3.2 Runtime truth

```text
.runtime/
  runtime-events.jsonl
  sessions.snapshot.json
  jobs.snapshot.json
  skill-runs.snapshot.json
  repo-events.jsonl
  session-stdio/<sessionId>.log
  appserver/<sessionId>.json
  layouts/session-hub.json
```

Authoritative runtime input is the append-only event log. Snapshots are derived caches.

### 3.3 Runtime deletion behavior

Deleting `.runtime` loses live session presence, layout, raw stdio logs, and runtime events. It must not corrupt tracker JSON or durable project history.

---

## 4. Critical design corrections

### 4.1 No stdio heuristics

`ProcessSessionAdapter` MUST NOT parse stdout/stderr to infer:

- approval requests;
- commands started/finished;
- task state;
- skill execution;
- MCP usage;
- blockers;
- completion.

It may only emit:

- `session.output` raw chunk;
- `session.last_output_at` update;
- `process.started`;
- `process.exited`;
- `process.signal_sent`;
- `session.stdin_written` when user/tool writes stdin.

UI copy must reflect this:

```text
Dumb terminal: quiet for 8m — check terminal.
```

Not:

```text
Waiting for approval.
```

unless structured evidence exists.

### 4.2 Serialized runtime writes

No request handler may read `sessions.snapshot.json`, mutate it, and write it back directly.

All runtime updates enter:

```ts
await runtimeStore.append(event)
```

`RuntimeStore` owns a single async write queue.

### 4.3 Deterministic rollover

Rollover successor packs are generated from durable tracker/git/runtime evidence. The old session may provide `tracker_session_handoff`, but it is advisory.

### 4.4 Watcher/git conflict detection

File conflict detection uses `ProjectWorkspaceWatcher` + git/worktree evidence. Agent-reported file paths are hints and cannot clear warnings.

---

## 5. RuntimeStore design

### 5.1 Files

```text
.runtime/runtime-events.jsonl        # all session/job/skill events (NOT layout)
.runtime/repo-events.jsonl           # file watcher/git events
.runtime/sessions.snapshot.json      # derived cache
.runtime/jobs.snapshot.json          # derived cache
.runtime/skill-runs.snapshot.json    # derived cache
.runtime/session-stdio/*.log         # raw output logs (rolling, max 5 MB, see §19.3)
.runtime/layouts/session-hub.json    # UI layout — atomic overwrite only, NOT event-sourced
```

A single combined runtime event log is simpler initially. If needed, split later by event type.

Layout state (window/card arrangement, group order, card sizes) does NOT enter the event log. Layout is written via atomic JSON overwrite at `.runtime/layouts/session-hub.json`. Treating layout as ephemeral UI state simplifies recovery (last write wins; corrupt layout falls back to default) and avoids polluting the durable event stream with high-frequency UI churn.

### 5.2 Event write path

```text
HTTP/MCP/AppServer/Adapter event
  -> RuntimeStore.append(event)
  -> queue.run(...)
  -> validate event
  -> append JSONL line
  -> apply to in-memory projection
  -> schedule debounced snapshot write
  -> broadcast WebSocket event
```

### 5.3 Pseudocode

```ts
class RuntimeStore {
  private queue = new AsyncWriteQueue();
  private projection = new RuntimeProjection();
  private snapshotDebouncer = new Debouncer(250);

  async append(event: RuntimeEvent): Promise<RuntimeAppendResult> {
    return this.queue.run(async () => {
      const normalized = normalizeRuntimeEvent(event);
      validateRuntimeEvent(normalized);
      await appendJsonlLine(this.paths.runtimeEvents, normalized);
      this.projection.apply(normalized);
      this.snapshotDebouncer.schedule(() => this.writeSnapshots());
      this.ws.broadcast({ type: "runtime.event", event: normalized });
      return { ok: true, eventId: normalized.id, rev: this.projection.runtimeRev };
    });
  }

  async writeSnapshots(): Promise<void> {
    const snapshots = this.projection.toSnapshots();
    await atomicWriteJson(this.paths.sessionsSnapshot, snapshots.sessions);
    await atomicWriteJson(this.paths.jobsSnapshot, snapshots.jobs);
    await atomicWriteJson(this.paths.skillRunsSnapshot, snapshots.skillRuns);
  }
}
```

### 5.4 Startup rebuild

```text
1. Load snapshots if valid.
2. Replay runtime-events.jsonl entries newer than snapshot watermark.
3. If snapshots invalid, rebuild full projection from JSONL.
4. If JSONL line is corrupt, stop at last valid line and write recovery warning.
```

### 5.5 Atomic file write

Snapshot writes use:

```text
write temp file
fsync temp file
rename temp -> target
fsync parent dir where supported
```

---

## 6. Data model

### 6.1 SessionRecord

```ts
// SessionTier:
// - "dumb_terminal":     raw process, stdio only, no semantic inference
// - "mcp_tracked":       agent calls tracker MCP/HTTP session tools explicitly
// - "codex_app_server":  structured Codex control surface (chat, approvals, events)
// - "hybrid":            app-server structured events combined with raw stdio display
// - "manual":            human-attached/advisory only — no process, no adapter;
//                        state advances only via explicit human edits
type SessionTier = "dumb_terminal" | "mcp_tracked" | "codex_app_server" | "hybrid" | "manual";

type ActivityState =
  | "starting"
  | "active"
  | "quiet"
  | "idle"
  | "waiting_for_human"
  | "waiting_for_approval"
  | "blocked"
  | "context_high"
  | "done"
  | "stopping"
  | "stopped"
  | "resuming"
  | "rolled_over"
  | "archived"
  | "unknown";

interface SessionRecord {
  id: string;
  name: string;
  tier: SessionTier;
  capabilities: SessionCapabilities;
  projectSlug?: string;
  taskId?: string;
  activeJobId?: string;
  agent?: "codex" | "claude" | "other";
  provider?: string;
  model?: string;
  cwd?: string;
  repoRoot?: string;
  worktreePath?: string;
  branch?: string;
  pid?: number;
  appServerThreadId?: string;
  status: ActivityState;
  statusSource: StatusSource;
  startedAt: string;
  lastActivityAt?: string;
  lastOutputAt?: string;
  lastStructuredEventAt?: string;
  predecessorSessionId?: string;
  successorSessionId?: string;
  warnings: SessionWarning[];
  layout?: SessionLayoutHint;
  archivedAt?: string;
}
```

### 6.2 Capabilities

```ts
interface SessionCapabilities {
  rawStdio: boolean;
  stdinWrite: boolean;
  processLifecycle: boolean;
  structuredEvents: boolean;
  structuredApprovals: boolean;
  structuredChat: boolean;
  structuredCommands: boolean;
  structuredMcpCalls: boolean;
  explicitTrackerMcp: boolean;
  appServerChat: boolean;
  directContextInjection: boolean;
}
```

### 6.3 StatusSource

```ts
type StatusSource =
  | { kind: "app_server"; eventId: string }
  | { kind: "mcp"; eventId: string }
  | { kind: "http"; eventId: string }
  | { kind: "human"; user?: string; eventId: string }
  | { kind: "derived_activity"; rule: "quiet_timeout" | "process_exit" }
  | { kind: "unknown" };
```

### 6.4 JobRecord

```ts
interface JobRecord {
  id: string;
  projectSlug: string;
  taskId: string;
  sessionId: string;
  profileId: string;
  kind: "code" | "prd" | "review" | "planning" | "closeout" | "custom";
  status: "queued" | "starting" | "running" | "blocked" | "verifying" | "completed" | "cancelled" | "rolled_over";
  startRev: number;
  startedAt?: string;
  completedAt?: string;
  predecessorJobId?: string;
  successorJobId?: string;
  skillPlan: SkillPlanItem[];
  completionGates: CompletionGate[];
  contextPackRefs: ContextPackRef[];
  warnings: JobWarning[];
}
```

### 6.5 SkillPlanItem

```ts
interface SkillPlanItem {
  id: string;
  skillId: string;
  phase:
    | "before_start"
    | "on_start"
    | "checkpoint"
    | "on_stale"
    | "on_blocked"
    | "before_complete"
    | "after_complete"
    | "on_rollover"
    | "on_resume";
  required: boolean;
  status: "pending" | "suggested" | "started" | "succeeded" | "failed" | "skipped" | "overridden";
  runId?: string;
  source?: StatusSource;
}
```

### 6.6 RuntimeEvent

```ts
type RuntimeEvent =
  | SessionStartedEvent
  | SessionStatusEvent
  | SessionOutputEvent
  | SessionStoppedEvent
  | JobStartedEvent
  | JobCheckpointEvent
  | JobCompletedEvent
  | SkillRunStartedEvent
  | SkillRunFinishedEvent
  | RepoChangeEvent
  | HumanOverrideEvent;
```

> Layout updates are **not** part of `RuntimeEvent`. Layout is UI-only state persisted by atomic JSON overwrite at `.runtime/layouts/session-hub.json` — see §5.1 and §12.4. Removing `LayoutUpdatedEvent` keeps the event log focused on auditable session/job/skill activity and prevents UI drag noise from inflating the JSONL.

All events include:

```ts
interface RuntimeEventBase {
  id: string;
  ts: string;
  type: string;
  source: "ui" | "cli" | "mcp" | "http" | "adapter" | "watcher" | "system";
  workspace: string;
}
```

### 6.7 Tracker schema additions

Session Hub introduces new optional fields on tracker tasks. The additions are backward compatible: existing trackers without them keep working, and the tracker store accepts JSON with or without these fields.

#### 6.7.1 `task.repos`

```ts
interface TaskRepos {
  primary?: TaskRepoRef;
  secondary?: TaskRepoRef[];
}

interface TaskRepoRef {
  root: string;             // absolute or workspace-relative repo root
  worktree?: string;        // optional worktree path (per-session worktrees recommended)
  branch?: string;          // optional pinned branch hint
  allowed_paths?: string[]; // glob patterns constraining which paths this task may touch
}
```

`allowed_paths` is consumed by `ProjectWorkspaceWatcher` (§9.4) to emit `outside_allowed_paths` warnings, and by completion gates (§11.5 `allowed_paths_clean`). It is advisory — the hub does not physically prevent writes; it raises warnings the operator must acknowledge.

#### 6.7.2 `task.verify`

```ts
interface TaskVerify {
  items: VerifyPackItem[]; // see §11.6.2
  notes?: string;
}
```

Optional, task-author-stamped verify items that get merged into the job's verify pack at job creation (§11.6).

#### 6.7.3 Migration

These fields are additive and unversioned. The tracker JSON schema validator accepts the new keys but does not require them. No existing tracker JSON requires rewriting. A future major version may promote them to required for specific task kinds; v0.3 keeps them optional.

Recommended order for adopters:

1. Update tracker schema validator to allow the new keys (no rewrite of stored JSON).
2. Add UI affordances in the existing tracker board for editing `repos` and `verify` on a task.
3. Backfill `repos.primary.root` for tasks tied to a single repo; leave others empty.
4. Add `allowed_paths` opportunistically as work surfaces overlap warnings.

---

## 7. Session adapters

### 7.1 Interface

```ts
interface SessionAdapter {
  kind: SessionTier;
  capabilities: SessionCapabilities;

  start?(request: StartSessionRequest): Promise<SessionHandle>;
  stop?(sessionId: string): Promise<void>;
  resume?(sessionId: string): Promise<SessionHandle>;
  restart?(sessionId: string): Promise<SessionHandle>;

  sendChat?(sessionId: string, message: string): Promise<void>;
  writeStdin?(sessionId: string, input: string): Promise<void>;

  getRawStdio?(sessionId: string): AsyncIterable<StdioChunk>;
  getStructuredEvents?(sessionId: string): AsyncIterable<StructuredSessionEvent>;
}
```

### 7.2 ProcessSessionAdapter

Purpose: launch/capture a CLI process and show raw stdio.

Allowed:

- spawn process;
- capture stdout/stderr;
- persist raw output;
- send stdin when user explicitly requests;
- stop/resume/restart process;
- report last output time;
- report process exit.

Forbidden:

- parse approvals;
- parse commands;
- parse progress;
- parse MCP usage;
- parse skill runs;
- infer task status.

### 7.3 McpTrackedSessionAdapter

Purpose: let any agent become structured by calling tracker tools.

Structured events come from MCP tools:

- `tracker_session_heartbeat`;
- `tracker_session_status`;
- `tracker_job_checkpoint`;
- `tracker_skill_run_start`;
- `tracker_skill_run_complete`;
- `tracker_session_handoff`.

### 7.4 CodexAppServerAdapter

Purpose: structured Codex control.

Capabilities:

- create/resume app-server thread;
- send chat/instructions;
- receive structured lifecycle/events;
- receive structured approval events;
- map app-server thread/conversation to session;
- inject context packs.

#### 7.4.1 Transport

The adapter connects to a Codex app-server instance over WebSocket using JSON-RPC 2.0. Connection target and auth are configured per workspace:

```yaml
adapters:
  codex_app_server:
    url: "ws://127.0.0.1:7100/jsonrpc"
    token: "${CODEX_APP_SERVER_TOKEN}"
    reconnectBackoffMs: [500, 1000, 2000, 5000, 10000]
    maxBackoffMs: 30000
```

A single multiplexed WS connection is maintained per app-server instance. Sessions are scoped per `threadId` within the connection. The adapter does not open one WS per session.

#### 7.4.2 Connection lifecycle

```text
adapter.connect()
  -> ws.open
  -> rpc.call("hello", { client: "llm-tracker", version, token })
  -> server returns { capabilities: { supportsApprovals, supportsContextUsage, supportsCancellation, ... }, serverVersion }
  -> adapter caches server capabilities
  -> rpc.call("events.subscribe", { filter: ["thread.*", "approval.*", "context.*"] })
  -> ready
```

On disconnect:

1. mark every adapter-backed session with the `disconnected` warning;
2. attempt reconnect with capped exponential backoff;
3. on reconnect, call `rpc.call("threads.list")` to reconcile session↔thread mappings;
4. for threads the server no longer knows about, mark the session `unknown` and require human action.

#### 7.4.3 RPC methods used by the adapter

| Method | Direction | Purpose |
|---|---|---|
| `hello` | client → server | handshake, capability exchange |
| `threads.create` | client → server | start new app-server thread for a session |
| `threads.resume` | client → server | reattach to an existing thread |
| `threads.list` | client → server | enumerate live threads after reconnect |
| `threads.send` | client → server | send chat / instruction message |
| `threads.cancel` | client → server | request graceful cancel |
| `threads.context_usage` | client → server | poll context usage if not pushed |
| `approvals.resolve` | client → server | submit an approval decision |
| `events.subscribe` | client → server | subscribe to push event stream |

All client→server calls return a JSON-RPC response with `{ ok: true }` plus method-specific payload, or a JSON-RPC error with `{ code, message, data? }`.

#### 7.4.4 Server-pushed event shapes

The server emits JSON-RPC notifications. The adapter normalizes each into a `RuntimeEvent`.

```ts
// thread.message — assistant or tool output
{ method: "thread.message", params: {
    threadId: string,
    role: "assistant" | "tool" | "user",
    content: string,
    ts: string
}}

// thread.status — lifecycle transition
{ method: "thread.status", params: {
    threadId: string,
    status: "running" | "idle" | "blocked" | "completed",
    reason?: string,
    ts: string
}}

// thread.approval — approval requested
{ method: "thread.approval", params: {
    threadId: string,
    approvalId: string,
    action: { kind: string, summary: string, args?: any },
    ts: string
}}

// thread.approval_resolved — approval closed
{ method: "thread.approval_resolved", params: {
    threadId: string,
    approvalId: string,
    decision: "approved" | "denied" | "cancelled",
    ts: string
}}

// thread.context_usage — token/context usage update
{ method: "thread.context_usage", params: {
    threadId: string,
    used: number,
    total: number,
    percent: number,
    ts: string
}}

// thread.error — non-fatal error notification
{ method: "thread.error", params: {
    threadId: string,
    code: string,
    message: string,
    retryable: boolean,
    ts: string
}}
```

#### 7.4.5 Mapping to RuntimeEvents

| App-server event | RuntimeEvent emitted | Notes |
|---|---|---|
| `thread.message` | `session.output` | `source.kind: "app_server"`, structured chat |
| `thread.status: running` | `session.status` → `active` | |
| `thread.status: idle` | `session.status` → `idle` | |
| `thread.status: blocked` | `session.status` → `blocked` | with reason in warning |
| `thread.status: completed` | `session.status` → `done` | |
| `thread.approval` | `session.status` → `waiting_for_approval` + `approval_needed` warning | warning `actionId = approvalId` |
| `thread.approval_resolved` | clear `approval_needed` warning; status returns to last known | |
| `thread.context_usage` with `percent ≥ threshold` | `session.status` → `context_high` + `context_high` warning | threshold configurable per workspace |
| `thread.error` | `session.warning` only | does not change ActivityState by default |

#### 7.4.6 Required vs optional capabilities

For Phase 7 acceptance, the app-server MUST support:

- `hello`, `threads.create`, `threads.send`, `events.subscribe`;
- `thread.message`, `thread.status` events.

These are optional capability flags; the adapter degrades gracefully when missing:

- `supportsApprovals` — without it, no `waiting_for_approval` state is ever inferred from this adapter.
- `supportsCancellation` — without it, stop reverts to closing the thread with no graceful cancel.
- `supportsContextUsage` — without it, `context_high` is never emitted for this session.
- `threads.resume` — without it, resume always behaves as a fresh `threads.create`.

### 7.5 Hybrid adapter

Combines app-server structured events and raw process/terminal display. Semantics come only from structured events.

---

## 8. ActivityMonitor

### 8.1 Inputs

- raw output timestamp;
- structured event timestamp;
- explicit heartbeat timestamp;
- process state;
- app-server state;
- job state;
- user manual status.

### 8.2 Rules

```ts
function deriveActivity(
  session: SessionRecord,
  now: Date
): { state: ActivityState; warnings: SessionWarning[] } {
  if (session.status === "archived" || session.status === "done") {
    return { state: session.status, warnings: [] };
  }
  if (processExited(session)) return { state: "stopped", warnings: [] };

  // Explicit structured state (app-server/MCP/human override) wins.
  if (hasExplicitStructuredState(session)) {
    return { state: session.status, warnings: session.warnings };
  }

  // Dumb-terminal: no recent raw output -> quiet + quiet_terminal warning.
  if (
    session.tier === "dumb_terminal" &&
    minutesSince(session.lastOutputAt) > quietAfterMinutes
  ) {
    return {
      state: "quiet",
      warnings: [{
        kind: "quiet_terminal",
        minutes: minutesSince(session.lastOutputAt),
        message: "No raw output recently; check terminal."
      }]
    };
  }

  // MCP/app-server/hybrid: missing expected heartbeat -> quiet + missing_heartbeat warning.
  if (
    expectsHeartbeat(session) &&
    minutesSince(session.lastStructuredEventAt) > staleAfterMinutes
  ) {
    return {
      state: "quiet",
      warnings: [{
        kind: "missing_heartbeat",
        minutes: minutesSince(session.lastStructuredEventAt),
        message: "No structured heartbeat recently."
      }]
    };
  }

  return { state: "active", warnings: [] };
}
```

`quiet` is the single ActivityState for both cases. The differentiator lives in the warning subtype — `quiet_terminal` for dumb terminals, `missing_heartbeat` for sessions that were expected to emit structured signals. There is no `stale` ActivityState in the model.

### 8.3 Warning examples

```ts
type SessionWarning =
  | { kind: "quiet_terminal"; minutes: number; message: "No raw output recently; check terminal." }
  | { kind: "missing_heartbeat"; minutes: number; message: "No structured heartbeat recently." }
  | { kind: "approval_needed"; source: "app_server" | "mcp" | "human"; actionId?: string }
  | { kind: "file_conflict"; conflictId: string }
  | { kind: "context_high"; percent?: number; source: "app_server" | "mcp" }
  | { kind: "skill_gate_missing"; skillId: string }
  | { kind: "disconnected"; source: "app_server" | "mcp"; sinceMs: number }
  | { kind: "stdio_capture_oversized"; rotatedSegments: number };
```

`context_high` carries an explicit `source` so the UI can show where the signal came from. The hub never synthesizes `context_high` from anything other than a structured app-server `thread.context_usage` event or an MCP `tracker_session_context_usage` call.

---

## 9. ProjectWorkspaceWatcher

### 9.1 Purpose

Detect file changes and potential conflicts using filesystem/git evidence, not agent self-reporting.

### 9.2 Watch roots

Sources:

- project `cwd` from sessions;
- task `repos.primary` and `repos.secondary[]` metadata;
- linked tracker repo root if known;
- session worktree path.

Ignore defaults:

```text
.git/
node_modules/
dist/
build/
.next/
coverage/
target/
.tmp/
vendor/
.cache/
```

### 9.3 RepoChangeEvent

```ts
interface RepoChangeEvent extends RuntimeEventBase {
  type: "repo.change";
  projectSlug: string;
  repoRoot: string;
  path: string;
  event: "add" | "change" | "unlink";
  activeSessionIds: string[];
  possibleSessionIds: string[];
  attribution: "worktree" | "single_active_session" | "ambiguous" | "unknown";
  relatedTaskIds: string[];
  outsideAllowedPaths?: boolean;
}
```

### 9.4 Attribution rules

1. If each session uses a unique worktree and the file path is under that worktree, attribution is strong.
2. If only one active session is bound to a repo/worktree, attribution is likely.
3. If multiple active sessions share the same repo/worktree, attribution is ambiguous.
4. If path violates task allowed paths, emit warning.
5. Agent-reported files are advisory display hints only.

### 9.5 Conflict types

```ts
type ConflictWarning =
  | "multiple_sessions_same_file"
  | "multiple_sessions_same_worktree"
  | "outside_allowed_paths"
  | "task_claim_conflict"
  | "stale_tracker_rev";
```

### 9.6 Event coalescing and debouncing

Raw filesystem events arrive in bursts (e.g., `npm install`, `git checkout`, large code-mod runs, formatters touching every file). The watcher MUST coalesce per-path events before they enter the RuntimeStore queue:

- per `(repoRoot, path)` key, hold the latest event in a debounce buffer for `coalesceMs` (default 200 ms) before emitting;
- if a later event arrives within the window, replace the buffered event:
  - `change` replaces `change`;
  - `unlink` collapses any preceding `change`/`add`;
  - `add` after `unlink` is preserved as an `add`;
- on flush, emit one `repo.change` event per `(repoRoot, path)`;
- batch flushes still enqueue events one at a time through `RuntimeStore.append` to preserve per-session ordering;
- if a single burst would enqueue more than `maxBatchSize` (default 500), the watcher emits an aggregate `repo.burst` summary event instead of N individual events, and the UI shows "N files changed" with a link to the git status.

A burst from `npm install` should therefore produce at most one event per touched file, not one event per fs notification, and should never stall session/job event processing on the RuntimeStore queue.

---

## 10. ContextPackService

### 10.1 Pack types

```ts
type ContextPackKind =
  | "start"
  | "resume"
  | "rollover"
  | "handoff"
  | "review"
  | "verify"
  | "closeout"
  | "changed_since";
```

### 10.2 Deterministic sources

- `/api/projects/:slug/tasks/:taskId/brief`
- `/why`
- `/execute`
- `/verify`
- `/handoff`
- `/changed?fromRev=`
- `/history`
- `/since/:rev`
- snapshots/history
- runtime job/session/skill events
- repo watcher events
- git status/diff/log

### 10.3 Rollover algorithm

```ts
async function buildRolloverPack(jobId: string): Promise<ContextPack> {
  const job = runtime.jobs.get(jobId);
  const session = runtime.sessions.get(job.sessionId);

  const brief = await tracker.brief(job.projectSlug, job.taskId);
  const why = await tracker.why(job.projectSlug, job.taskId);
  const execute = await tracker.execute(job.projectSlug, job.taskId);
  const verify = await tracker.verify(job.projectSlug, job.taskId);
  const changed = await tracker.changed(job.projectSlug, job.startRev);
  const history = await tracker.history(job.projectSlug, { sinceRev: job.startRev });
  const runtimeEvents = runtime.eventsForJob(jobId);
  const repoEvents = runtime.repoEventsFor(job.projectSlug, job.startedAt);
  const git = await gitEvidence.collect(session.cwd ?? session.repoRoot, job.startedAt);
  const advisoryHandoff = runtime.latestHandoff(jobId);

  return renderContextPack({
    kind: "rollover",
    source: "deterministic",
    brief,
    why,
    execute,
    verify,
    changed,
    history,
    runtimeEvents,
    repoEvents,
    git,
    advisoryHandoff,
    advisoryHandoffLabel: "old-session claim; verify against tracker/git evidence"
  });
}
```

### 10.4 Generated start prompt template

```text
You are session {{sessionId}} working on job {{jobId}}.

Project: {{projectSlug}}
Task: {{taskId}} — {{taskTitle}}
Profile: {{profileId}}
Start rev: {{startRev}}

Required workflow:
{{skillPlan}}

Use tracker tools for status:
- heartbeat/checkpoint after meaningful progress;
- report blockers explicitly;
- run verify before completion;
- run closeout/handoff before stopping.

Task context:
{{brief}}
{{why}}
{{execute}}
{{verify}}
```

---

## 11. Skills and jobs

### 11.1 SkillsRegistry

```ts
interface SkillDefinition {
  id: string;
  title: string;
  description: string;
  appliesTo: string[];
  defaultPhases: SkillPhase[];
  adapters: {
    codexSkill?: { shortcut: string };
    mcpPrompt?: { tool: string };
    promptTemplate?: { path: string };
    httpAction?: { endpoint: string };
  };
}
```

### 11.2 Built-in skills

Initial built-ins should map to existing workflow skills:

```yaml
skills:
  lt.execute_scope:
    title: Execute Scope
    codexSkill: "$lt:execute"
    mcpPrompt: "tracker_execute_scope"
    phases: [before_start]

  lt.closeout_sweep:
    title: Closeout Sweep
    codexSkill: "$lt:closeout"
    mcpPrompt: "tracker_closeout_sweep"
    phases: [before_complete, after_complete, on_rollover]

  lt.task_planner:
    title: Task Planner
    codexSkill: "$lt:plan"
    mcpPrompt: "tracker_plan_tasks"
    phases: [before_start, after_complete]

  lt.verify:
    title: Verify Task
    httpAction: "/api/projects/:slug/tasks/:taskId/verify"
    phases: [before_complete]
```

### 11.3 Job profiles

```yaml
jobProfiles:
  code-implementer:
    kind: code
    hooks:
      before_start:
        - skill: lt.execute_scope
          required: true
      checkpoint:
        - skill: lt.status_heartbeat
          everyMinutes: 5
      before_complete:
        - skill: lt.verify
          required: true
      after_complete:
        - skill: lt.closeout_sweep
          required: true

  prd-writer:
    kind: prd
    hooks:
      before_start:
        - skill: lt.task_planner
      before_complete:
        - skill: prd.quality_review
          required: true
      after_complete:
        - skill: lt.closeout_sweep

  reviewer:
    kind: review
    hooks:
      before_start:
        - skill: lt.changed_since
      before_complete:
        - skill: lt.verify
          required: true
      after_complete:
        - skill: lt.closeout_sweep
```

### 11.4 Skill run verification

A skill run is verified only by:

- `tracker_skill_run_start` / `tracker_skill_run_complete` MCP call;
- HTTP skill-run endpoint;
- app-server structured event mapped to a known skill;
- human manual override with reason.

Never from raw stdio.

### 11.5 Completion gates

```ts
interface CompletionGate {
  id: string;
  kind:
    | "required_skill"
    | "verify_pack"
    | "dod_checked"
    | "handoff_created"
    | "conflict_resolved"
    | "allowed_paths_clean";
  required: boolean;
  status: "pending" | "satisfied" | "failed" | "overridden";
  evidenceRef?: string;       // RuntimeEvent id providing evidence
  overrideReason?: string;    // required when status === "overridden"
}
```

### 11.6 Verify pack

The verify pack is the concrete, immutable set of checks a job must satisfy before it can be marked complete. It is computed at job creation, stamped onto `JobRecord.completionGates`, and cannot be silently widened mid-run.

#### 11.6.1 Composition

A verify pack is assembled from three sources, in this precedence (later sources merge with earlier; earlier sources win on `id` collision):

1. **Task-level verify spec** — `task.verify.items` from the tracker (§6.7.2), if present. These are author-stamped per-task checks.
2. **Profile defaults** — verify items contributed by the job profile (e.g., `code-implementer` adds `lt.verify` and `lt.closeout_sweep`).
3. **Workspace defaults** — global verify items from workspace config (e.g., "all jobs must produce a handoff").

#### 11.6.2 VerifyPackItem shape

```ts
type VerifyPackItem =
  | { kind: "command";        id: string; cmd: string; cwd?: string; required: boolean; timeoutSec?: number; expectExit?: number }
  | { kind: "lint";           id: string; tool: string; args?: string[]; required: boolean }
  | { kind: "skill_run";      id: string; skillId: string; required: boolean }
  | { kind: "human_approval"; id: string; prompt: string; required: boolean }
  | { kind: "dod_check";      id: string; ref: string; required: boolean };

interface VerifyPack {
  jobId: string;
  stampedAt: string;
  stampedFromRev: number; // tracker rev at the moment the pack was stamped
  items: VerifyPackItem[];
}
```

#### 11.6.3 Lifecycle

```text
1. Job creation triggers ContextPackService.buildVerifyPack(profile, task, workspace).
2. Each VerifyPackItem is converted into a CompletionGate (§11.5):
   - command/lint  -> kind "verify_pack" with evidenceRef pointing at the run's RuntimeEvent
   - skill_run     -> kind "required_skill" with skillId
   - human_approval-> kind "verify_pack" with evidence from a HumanOverrideEvent
   - dod_check     -> kind "dod_checked" with ref to the DoD item id
3. The verify pack is persisted alongside the job; the pack is immutable.
4. As skill/command/human checks complete, the matching gate flips status to "satisfied" or "failed".
5. Job.complete is allowed only when every required gate is satisfied (or overridden with overrideReason).
6. Patches to task.verify after the pack is stamped do NOT widen an in-flight job; new tasks/jobs pick up the new spec.
```

#### 11.6.4 Evidence binding

Every gate transition to `satisfied` MUST carry an `evidenceRef` pointing at a concrete RuntimeEvent:

- `command` / `lint` — the corresponding `verify.command.completed` event with exit code, stdout/stderr refs, and duration;
- `skill_run` — the `skill.run.finished` event with `status: "succeeded"`;
- `human_approval` — a `HumanOverrideEvent` with explicit reason text;
- `dod_check` — a tracker patch that flipped the DoD bullet, referenced by tracker rev.

A gate cannot be flipped to `satisfied` via UI alone — the click must create the corresponding RuntimeEvent first.

#### 11.6.5 API surface

```http
GET    /api/jobs/:jobId/verify-pack
POST   /api/jobs/:jobId/verify-pack/items/:itemId/run     # runs command/lint, records event
POST   /api/jobs/:jobId/verify-pack/items/:itemId/resolve # marks human_approval / dod_check, requires reason
```

The MCP equivalents follow the existing `tracker_*` naming: `tracker_job_verify_pack`, `tracker_job_verify_run`, `tracker_job_verify_resolve`.

---

## 12. APIs

### 12.1 Session endpoints

```http
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:sessionId
PATCH  /api/sessions/:sessionId
POST   /api/sessions/:sessionId/heartbeat
POST   /api/sessions/:sessionId/status
POST   /api/sessions/:sessionId/stop
POST   /api/sessions/:sessionId/resume
POST   /api/sessions/:sessionId/restart
POST   /api/sessions/:sessionId/rollover
GET    /api/sessions/:sessionId/stdio
POST   /api/sessions/:sessionId/stdin
POST   /api/sessions/:sessionId/chat
```

`stdin` and `chat` require adapter capability checks.

### 12.2 Job endpoints

```http
GET    /api/jobs
POST   /api/projects/:slug/tasks/:taskId/jobs
GET    /api/jobs/:jobId
PATCH  /api/jobs/:jobId
POST   /api/jobs/:jobId/checkpoint
POST   /api/jobs/:jobId/complete
POST   /api/jobs/:jobId/cancel
POST   /api/jobs/:jobId/rollover
GET    /api/jobs/:jobId/context-pack?kind=start|resume|rollover|verify|handoff
```

### 12.3 Skill endpoints

```http
GET    /api/skills
GET    /api/skills/:skillId
GET    /api/job-profiles
GET    /api/jobs/:jobId/skill-plan
POST   /api/jobs/:jobId/skill-runs
PATCH  /api/jobs/:jobId/skill-runs/:runId
POST   /api/jobs/:jobId/skill-runs/:runId/override
```

### 12.4 Layout endpoints

```http
GET    /api/session-layouts/default
PUT    /api/session-layouts/default
POST   /api/session-layouts/default/reset
```

Layout state contains only UI arrangement and is persisted via atomic JSON overwrite at `.runtime/layouts/session-hub.json`. It is **not** event-sourced — `PUT` replaces the file, the corresponding WS broadcast (`layout.updated`) is debounced over 100 ms (§15.1), and no entry is written to `runtime-events.jsonl`. A corrupt layout file falls back to the default layout on read.

### 12.5 Conflict endpoints

```http
GET    /api/projects/:slug/session-conflicts
GET    /api/sessions/:sessionId/conflicts
POST   /api/conflicts/:conflictId/ack
```

---

## 13. MCP tools

### 13.1 Session tools

```text
tracker_session_start
tracker_session_heartbeat
tracker_session_status
tracker_session_note
tracker_session_blocked
tracker_session_handoff
tracker_session_complete
tracker_session_list
tracker_session_context
tracker_session_broadcast
```

### 13.2 Job tools

```text
tracker_job_start
tracker_job_status
tracker_job_checkpoint
tracker_job_complete
tracker_job_rollover
tracker_job_context_pack
tracker_job_skill_plan
```

### 13.3 Skill tools

```text
tracker_skills_list
tracker_job_profiles
tracker_skill_run_start
tracker_skill_run_complete
tracker_skill_run_skip
tracker_skill_run_fail
```

### 13.4 Example: heartbeat

```json
{
  "sessionId": "sess_abc123",
  "jobId": "job_001",
  "status": "active",
  "note": "Implemented card resize handles; running UI smoke test.",
  "progress": {
    "phase": "implementation",
    "percent": 55,
    "source": "reported"
  }
}
```

### 13.5 Example: skill complete

```json
{
  "jobId": "job_001",
  "sessionId": "sess_abc123",
  "skillId": "lt.verify",
  "status": "succeeded",
  "summary": "Verify pack checked; npm test passed; manual card resize flow tested.",
  "evidence": ["npm test", "ui smoke test"]
}
```

---

## 14. CLI commands

```bash
llm-tracker sessions
llm-tracker session attach --project <slug> --task <taskId> --agent codex
llm-tracker session start --project <slug> --task <taskId> --profile code-implementer --adapter codex-app-server
llm-tracker session stop <sessionId>
llm-tracker session resume <sessionId>
llm-tracker session rollover <sessionId>
llm-tracker session stdio <sessionId>

llm-tracker jobs
llm-tracker job start <slug> <taskId> --session <sessionId|new:codex> --profile code-implementer
llm-tracker job status <jobId>
llm-tracker job context <jobId> --kind start
llm-tracker job complete <jobId>
llm-tracker job rollover <jobId>

llm-tracker skills list
llm-tracker skills show <skillId>
llm-tracker job-profiles
```

---

## 15. WebSocket events

```ts
type RuntimeWsMessage =
  | { type: "runtime.event"; event: RuntimeEvent }
  | { type: "runtime.snapshot"; sessions: SessionRecord[]; jobs: JobRecord[] }
  | { type: "session.output"; sessionId: string; chunks: StdioChunk[]; chunkCount: number }
  | { type: "repo.conflict"; conflict: ConflictWarning }
  | { type: "layout.updated"; layout: SessionHubLayout };
```

### 15.1 Coalescing of high-frequency events

`session.output` and `repo.change` originate from high-rate sources (raw stdio bursts, fs event storms). The hub MUST batch these to keep the UI usable:

- **Server-side stdio batching.** The hub buffers `session.output` chunks per session for `outputCoalesceMs` (default 50 ms), then emits one WS message containing the array of chunks plus a `chunkCount`. UI clients append the concatenated chunks to the stdio buffer as a single render pass.
- **UI-side render throttling.** Visible session stdio panes render at most 30 frames/sec. Off-screen sessions render at 5 frames/sec. The chunk buffer keeps accumulating between frames; flushing is render-coalesced, not event-coalesced.
- **Repo events.** `repo.change` events arrive already coalesced from the watcher (§9.6); no further batching is applied at the WS layer.
- **Ordering.** All event kinds other than `session.output` are forwarded as-is and preserve per-session order. `session.output` batches preserve chunk order within the batch.

`layout.updated` is debounced server-side over 100 ms so rapid drag/resize churn results in one broadcast per gesture, not one per pointer event.

---

## 16. UI technical design

### 16.1 Components

```text
SessionHubPage
  SessionFilterBar
  SessionGroupList
    SessionGroup
      SessionCard
  SessionDetailDock
    SessionSummaryTab
    SessionStdioTab
    SessionChatTab
    SessionContextTab
    SessionSkillsTab
    SessionEventsTab
  ToolShelf
  StartJobDialog
  RolloverDialog
  ConflictBanner
```

### 16.2 Simple layout mechanics

- Use CSS grid/flex for groups.
- Card size is enum: `compact | normal | large` for MVP.
- Later add free resizing if enum sizes are insufficient.
- Drag/drop reorders cards and moves cards between groups.
- Layout saved through layout endpoint and stored in `.runtime/layouts`.

### 16.3 Session card view model

```ts
interface SessionCardViewModel {
  id: string;
  title: string;
  projectLabel: string;
  taskLabel?: string;
  statusLabel: string;
  statusTone: "neutral" | "active" | "warning" | "danger" | "done";
  capabilityLabel: string;
  lastActivityLabel: string;
  progressLabel?: string;
  skillBadges: Array<{ label: string; state: "done" | "pending" | "warning" }>;
  warnings: string[];
  actions: SessionCardAction[];
}
```

### 16.4 Tool shelf behavior

The tool shelf is context-sensitive but always visible.

Selected task:

```text
[READ] [WHY] [EXEC] [VERIFY] [HANDOFF] [RUN]
```

Selected session:

```text
[OPEN] [STDIO] [CHAT] [PING] [STOP] [RESUME] [ROLLOVER]
```

Selected job:

```text
[CONTEXT] [SKILLS] [CHECKPOINT] [VERIFY] [CLOSEOUT] [COMPLETE]
```

Actions requiring missing capability are disabled with a short reason, not hidden.

### 16.5 Drawer/dock

The dock should be resizable and remember width. It avoids route changes for common inspection.

---

## 17. Context rollover implementation

### 17.1 Trigger sources

- user clicks rollover;
- context-high structured event;
- no heartbeat for threshold;
- explicit MCP `tracker_job_rollover` request;
- resume/reload flow.

### 17.2 Steps

```text
1. Mark job/session rollover_requested.
2. Try optional final handoff request if structured adapter available.
3. Wait bounded time or skip.
4. Build deterministic rollover pack.
5. Show editable prompt to user.
6. Start successor session/job or copy prompt.
7. Link predecessor/successor.
8. Mark old session rolled_over or archived.
```

### 17.3 Bounded final handoff

The old session gets one optional request:

```text
Call tracker_session_handoff with facts, evidence, risks, and next ask. Do not mark complete unless verify passed.
```

If it fails or times out, continue.

---

## 18. Completion gate flow

### 18.1 UI-driven complete

```text
User/agent clicks complete job
  -> evaluate gates
  -> if all satisfied: patch tracker status complete
  -> if missing: show gate checklist
  -> human may override with reason
  -> runtime event records override
```

### 18.2 Raw tracker patches

Agents may still patch tracker state directly through existing mechanisms. Session Hub should not break existing tracker behavior. It should, however, surface warnings:

```text
Task marked complete while active job lacks verify/closeout skill events.
```

---

## 19. Security and safety

### 19.1 Surface and transport

- Localhost binding and existing hub auth rules continue to apply.
- Mutating runtime endpoints use the same CSRF/origin/token policy as durable project writes.
- Stdin/chat injection requires explicit user action or a configured trusted adapter mode.

### 19.2 Session-scoped adapter auth

Every state-mutating call against a session (heartbeat, status update, job checkpoint, skill-run report, stdin write, chat send, verify-pack resolve) MUST carry a session-scoped ephemeral token issued at session creation/attach time.

#### 19.2.1 Token issuance

```text
1. Hub creates the SessionRecord (via UI, CLI, or attach flow).
2. Hub generates an ephemeral session token bound to (sessionId, capabilities, expiresAt).
3. The token is returned to whoever started the session:
   - UI launcher receives it via the create-session HTTP response;
   - CLI `session start` / `session attach` prints it to stdout;
   - structured adapters receive it directly from the hub at spawn time.
4. The token is passed to the agent process out-of-band (env var, config file, paste).
```

#### 19.2.2 Token transport

Adapters and agents send the token on every mutating call:

- HTTP: header `X-LT-Session-Token: <token>`;
- MCP: argument `sessionToken: "<token>"` on every session/job/skill mutating tool.

#### 19.2.3 Validation

```text
- Hub validates (token, sessionId) on every mutation.
- Mismatch -> 401/Unauthorized; the call is dropped and an audit event is recorded.
- Token expires when the session is archived OR after maxLifetimeMinutes (default 24h).
- Token rotation: the UI can issue a new token via `POST /api/sessions/:sessionId/token/rotate`; the old token is revoked immediately.
```

#### 19.2.4 Scope

Read-only endpoints (list sessions, fetch context pack, view stdio) do NOT require the session token — they remain gated by the existing workspace auth. The session token is strictly for state mutation.

Manual-tier sessions still issue a token; it scopes which human-edit endpoints the launcher can call.

### 19.3 Stdio capture and secrets

- Per-session stdio logs (§5.1) are capped at a configurable maximum size (default **5 MB**) with rolling rotation. When the live log exceeds the cap, it is rotated to `<sessionId>.<n>.log` and a fresh live log is started.
- Older rotated segments are retained up to a bounded count (default **3**) and then deleted.
- Total per-session disk for stdio is therefore capped at roughly `4 × maxBytes` (live + 3 rotated).
- Stdio capture is configurable per workspace; the default (ON vs OFF) is an open question (see PRD §15).
- The UI MUST display a "stdio captured" indicator on every session card whose adapter is writing raw stdio to disk, with a tooltip linking to the secrets caveat below.
- **Secrets caveat:** raw stdio commonly contains API keys, tokens, cookies, MFA codes, and other secrets. The hub does NOT redact. Operators are responsible for disabling stdio capture in sensitive environments. This caveat is repeated in the user-facing docs and surfaced in the workspace config schema.

### 19.4 Other safety

- No automatic terminal approvals.
- No raw stdio parsing for semantic decisions.
- Human confirmation required for cross-project multi-session launch.
- Rollover prompt review is default unless the user opts into auto-launch.

---

## 20. Tests

### 20.1 RuntimeStore

- concurrent append calls preserve all events;
- snapshot rebuild from JSONL;
- corrupt snapshot rebuilds from event log;
- corrupt JSONL line reports recovery warning;
- atomic snapshot write does not leave partial JSON.

### 20.2 ProcessSessionAdapter

- captures stdout/stderr;
- stores log;
- updates last output time;
- never emits approval/status/skill events from output content;
- stop/resume emits process lifecycle events only.

### 20.3 ActivityMonitor

- dumb terminal no output => state `quiet`, warning `quiet_terminal` (NOT `quiet`);
- mcp-tracked missing heartbeat => state `quiet`, warning `missing_heartbeat`;
- app-server approval event => state `waiting_for_approval`, warning `approval_needed`;
- MCP blocked status => state `blocked`;
- process exit => state `stopped`;
- no `stale` ActivityState is ever produced (regression guard for the renamed model);
- `waiting_for_approval` is not overwritten by a quiet-timeout pass unless the approval event has explicitly expired by configured policy;
- `context_high` is only emitted for sessions with `tier in {codex_app_server, hybrid, mcp_tracked-with-context-usage}`; dumb-terminal sessions never enter `context_high`.

### 20.4 Rollover

- builds pack without old session available;
- includes tracker brief/why/execute/verify;
- includes changed-since start rev;
- includes git evidence when repo exists;
- labels old-session handoff advisory.

### 20.5 WorkspaceWatcher

- emits repo change events;
- ignores configured directories;
- detects ambiguous write with shared worktree;
- detects same-file multi-session conflict;
- detects outside allowed paths;
- coalesces a burst of N rapid fs events on the same path into one `repo.change` event (§9.6);
- never enqueues more than `maxBatchSize` individual events for a single watcher burst — produces a `repo.burst` aggregate instead.

### 20.6 Skills/jobs

- profile creates expected skill plan;
- skill run via MCP marks gate satisfied;
- raw stdio containing `$lt:verify` text does not satisfy gate;
- human override requires reason;
- completion gate warnings appear;
- verify pack is stamped at job creation and is immutable thereafter;
- a patch to `task.verify` after the pack is stamped does NOT widen the in-flight job's gates;
- a gate cannot flip to `satisfied` without a corresponding `evidenceRef` pointing at a real RuntimeEvent.

### 20.7 UI

- 10+ session cards render cleanly;
- filters work;
- card size changes (`compact | normal | large`) persist via the layout JSON;
- drag/drop group assignment persists;
- tool shelf actions are one-click;
- disabled actions show reason;
- layout state never enters `runtime-events.jsonl` (regression guard against `LayoutUpdatedEvent` reappearing);
- stdio capture indicator renders on every card whose adapter is writing raw stdio to disk.

### 20.8 Auth and stdio retention

- a state-mutating call without a valid `X-LT-Session-Token` is rejected with 401;
- token rotation immediately revokes the old token;
- stdio log over `maxBytes` rotates to a numbered segment;
- segment count above the retention bound deletes the oldest segments;
- read-only endpoints (list sessions, fetch context pack, view stdio) do NOT require the session token.

### 20.9 WebSocket coalescing

- rapid `session.output` chunks within the 50 ms window collapse into one WS message containing the chunk array;
- ordering within the chunk array matches arrival order;
- `layout.updated` debounces within 100 ms — a drag gesture produces one broadcast, not many.

---

## 21. Implementation plan

### Phase 1 — Runtime foundation

Files/modules:

```text
hub/runtime/store.js
hub/runtime/projection.js
hub/runtime/events.js
hub/runtime/snapshots.js
hub/runtime/paths.js
```

Deliver:

- serialized event store;
- projections;
- WebSocket runtime events;
- basic session CRUD.

### Phase 2 — Session UI + dumb terminal

Files/modules:

```text
hub/sessions/registry.js
hub/sessions/adapters/process.js
hub/sessions/auth/tokens.js          # session-scoped token issuance/validation (§19.2)
hub/sessions/stdio/rotation.js       # stdio log rotation/retention (§19.3)
hub/runtime/layouts.js               # atomic JSON read/write for layout (§5.1, §12.4)
ui/session-hub/*
```

Deliver:

- session cards (enum sizes `compact | normal | large`, no free resize);
- manual attach;
- raw stdio logs with 5 MB rolling rotation and bounded segment retention;
- "stdio captured" UI indicator + secrets caveat tooltip;
- session-scoped ephemeral tokens issued at create/attach;
- layout state persisted as atomic JSON (not event-sourced);
- quiet detection only, using `quiet_terminal` and `missing_heartbeat` warning subtypes.

### Phase 3 — Jobs and skills

Files/modules:

```text
hub/jobs/registry.js
hub/jobs/profiles.js
hub/jobs/verify-pack.js              # verify pack composition + stamping (§11.6)
hub/skills/registry.js
hub/skills/gates.js
```

Tracker schema:

- accept new optional `task.repos` (with `allowed_paths`) and `task.verify` fields (§6.7);
- no migration of existing tracker JSON required.

Deliver:

- start job from task;
- skill plan generation;
- verify pack stamped at job creation, immutable thereafter;
- evidence-bound gate transitions (no UI-only flips to `satisfied`);
- tool shelf;
- context packs;
- gate warnings.

### Phase 4 — MCP reporting

Files/modules:

```text
bin/mcp-server.js additions
hub/runtime/mcp-events.js
hub/sessions/auth/mcp-token.js       # validate sessionToken argument on every mutation tool
```

Deliver:

- session/job/skill MCP tools;
- explicit structured reports;
- `tracker_session_context_usage` for agents that want to participate in `context_high` detection;
- every state-mutating MCP tool validates the session token (§19.2);
- verified skill runs.

### Phase 5 — Workspace watcher/conflicts

Files/modules:

```text
hub/workspaces/watcher.js
hub/workspaces/coalescer.js          # per-(repoRoot, path) debounce + burst aggregation (§9.6)
hub/workspaces/git-evidence.js
hub/conflicts/detector.js
```

Deliver:

- repo events, coalesced per path with `coalesceMs` default 200 ms;
- `repo.burst` aggregate when a single burst would exceed `maxBatchSize`;
- conflict warnings;
- allowed-path checks driven by `task.repos.allowed_paths` (§6.7.1).

### Phase 6 — Deterministic rollover

Files/modules:

```text
hub/context-packs/service.js
hub/context-packs/rollover.js
hub/context-packs/templates.js
```

Deliver:

- rollover pack;
- successor session links;
- prompt review UI.

### Phase 7 — Codex app-server adapter

Files/modules:

```text
hub/sessions/adapters/codex-app-server.js   # JSON-RPC/WS client (§7.4.1)
hub/sessions/adapters/codex-rpc.js          # transport, hello, reconnect/backoff
hub/sessions/appserver-events.js            # event normalization (§7.4.4–§7.4.5)
```

Deliver:

- JSON-RPC over WebSocket transport with reconnect/backoff and capability handshake;
- structured chat;
- structured approval badge (only when `supportsApprovals` is advertised by the server);
- structured `context_high` (only when `supportsContextUsage` is advertised);
- thread resume when `threads.resume` is advertised; otherwise successor spawn via `threads.create`;
- direct context injection;
- WS-coalesced `session.output` from `thread.message` events (§15.1).

---

## 22. Migration and compatibility

- Existing trackers require no migration.
- Existing CLI/MCP/project endpoints keep working.
- `.runtime` is created on demand.
- Runtime feature can be disabled with config flag.
- Direct tracker patches are not blocked by Session Hub; warnings are additive.
- Existing workflow skills remain valid and are registered as built-in skill definitions.
- The new optional task fields `task.repos` and `task.verify` (§6.7) are additive — schema validator accepts them, but no existing JSON requires rewriting.
- Adapters and agents written against pre-v0.3 endpoints will fail closed when they hit a state-mutating endpoint without a session token (§19.2). The v0.3 release notes call out the required header / argument.
- Existing layouts written into the old `runtime-events.jsonl` are not migrated; they were a v0.2-draft-only artifact never shipped, and the layout file (§5.1) becomes the sole source.

---

## 23. Open technical questions

### 23.1 Resolved in v0.3

- **Layout persistence** — atomic JSON overwrite at `.runtime/layouts/session-hub.json`; `LayoutUpdatedEvent` removed from the runtime event log.
- **Stale vs quiet** — single `quiet` ActivityState; cause carried by warning subtype (`quiet_terminal`, `missing_heartbeat`); the `stale` state is removed from the vocabulary entirely.
- **Context-high triggers** — only emitted for sessions whose tier reports structured context usage (app-server `thread.context_usage` or MCP `tracker_session_context_usage`).
- **Adapter ↔ hub auth** — session-scoped ephemeral token required on every state-mutating call (§19.2).
- **Verify pack** — concrete `VerifyPackItem` shape, immutable-after-stamp lifecycle, evidence-bound gate transitions (§11.6).
- **Tracker schema additions** — `task.repos` (incl. `allowed_paths`) and `task.verify` as additive, optional fields (§6.7).
- **Codex app-server protocol** — JSON-RPC over WebSocket, methods, event shapes, capability flags (§7.4.1–§7.4.6).
- **Watcher event coalescing** — debounced per `(repoRoot, path)` before queue enqueue (§9.6).
- **WebSocket stdio coalescing** — server batches over 50 ms; UI render throttled to 30 fps (§15.1).
- **Stdio retention** — 5 MB cap, rolling rotation, bounded segment retention; secrets caveat in §19.3.

### 23.2 Still open

1. Single `runtime-events.jsonl` vs split-by-type — keeping single for now; revisit if projection rebuild becomes slow.
2. How to discover repo roots reliably for attached sessions whose launcher does not provide `cwd`?
3. Should app-server adapter be required for structured approvals in v1, or v1.5?
4. What default `quietAfterMinutes` / `staleAfterMinutes` thresholds are least annoying in real use?
5. Should the conflict detector recommend creating a worktree automatically when `multiple_sessions_same_worktree` fires?
6. Default stdio-capture state per workspace — ON (debug-friendly) or OFF (secret-safe)?
7. Verify-pack `human_approval` notifications — push-style WS event vs UI inbox polling?
8. Snapshot debounce max-age — should `RuntimeStore` force a flush after N seconds even if events keep arriving?

---

## 24. Appendix: minimal runtime event examples

### Session start

```json
{
  "id": "evt_001",
  "ts": "2026-05-22T16:30:00Z",
  "type": "session.started",
  "source": "ui",
  "workspace": "/Users/adil/.llm-tracker",
  "session": {
    "id": "sess_001",
    "name": "Phalanx reviewer",
    "tier": "codex_app_server",
    "projectSlug": "project-phalanx",
    "taskId": "rm-semantix-alignment-intake"
  }
}
```

### Quiet warning

```json
{
  "id": "evt_002",
  "ts": "2026-05-22T16:38:00Z",
  "type": "session.warning",
  "source": "system",
  "workspace": "/Users/adil/.llm-tracker",
  "sessionId": "sess_001",
  "warning": {
    "kind": "quiet",
    "minutes": 8,
    "message": "No output recently; check terminal. Raw stdio is not parsed for approvals."
  }
}
```

### Skill run complete

```json
{
  "id": "evt_003",
  "ts": "2026-05-22T16:42:00Z",
  "type": "skill.run.finished",
  "source": "mcp",
  "workspace": "/Users/adil/.llm-tracker",
  "jobId": "job_001",
  "sessionId": "sess_001",
  "skillId": "lt.verify",
  "status": "succeeded",
  "summary": "Verify pack satisfied; tests passed."
}
```

### Repo conflict

```json
{
  "id": "evt_004",
  "ts": "2026-05-22T16:44:00Z",
  "type": "repo.change",
  "source": "watcher",
  "workspace": "/Users/adil/.llm-tracker",
  "projectSlug": "project-phalanx",
  "repoRoot": "/Users/adil/Documents/dev/Project-Phalanx",
  "path": "src/auth/session.ts",
  "event": "change",
  "activeSessionIds": ["sess_001", "sess_002"],
  "possibleSessionIds": ["sess_001", "sess_002"],
  "attribution": "ambiguous",
  "relatedTaskIds": ["task_a", "task_b"]
}
```
