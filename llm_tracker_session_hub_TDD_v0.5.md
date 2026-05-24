# Technical Design Document: llm-tracker Session Hub

**Product:** llm-tracker Session Hub  
**Status:** Draft v0.7 — operator-capable personal build with design-integration patches (queue model, model-swap defaults, untasked sessions, single-funnel, attach-as-queue)  
**Primary constraint:** local-first, tracker-native, simple UI, deterministic runtime behavior  
**Critical safety rule:** raw stdio is display-only; never infer semantic state from terminal text

---

## 1. Summary

Session Hub adds a runtime control plane to `llm-tracker` for tracking and orchestrating active coding-agent sessions. Existing tracker JSON files remain durable project truth. Runtime session/job/skill state lives under `.runtime`, driven by a serialized event store and in-memory projection.

The system introduces:

- `RuntimeStore` — serialized append-only event store and projection.
- `RunSessionService` — one launch funnel for task-card, swimlane, Hub, CLI, and attach entry points.
- `RunCandidateService` — fit-ranked runnable task recommendations across lanes/projects.
- `SessionRegistry` — active sessions and capability tiers.
- `JobRegistry` — task/session/profile executions.
- `SkillsRegistry` — workflow skills and job profile hooks.
- `ActivityMonitor` — derives the `quiet` state and warning subtypes (`quiet_terminal`, `missing_heartbeat`) from structured signals only; never from raw stdio text.
- `AttentionEngine` — projects sessions/jobs/warnings/gates/conflicts into prioritized operator attention items.
- `ProjectWorkspaceWatcher` — watcher/git-derived file change/conflict evidence.
- `ContextPackService` — deterministic start/resume/rollover/handoff packs.
- `ProcessSessionAdapter` — raw stdio display and process lifecycle only.
- `McpTrackedSessionAdapter` — explicit session/job/skill events from agents.
- `CodexAppServerAdapter` — structured chat, approvals, and event ingestion.
- UI: Session Hub view, project board Sessions strip, Triage view, persistent Attention strip, tool shelf, session drawer, layout state.

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
  queuedJobIds?: string[];            // ordered; first is next on activeJob completion (§23.2 #35)
  agent?: "codex" | "claude" | "other";
  provider?: string;
  model?: string;
  ctxMax?: number;                    // model context window total tokens (display-only)
  sandbox?: "readonly" | "workspace-write" | "autoedit" | "full-auto";  // §23.2 #29
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

> **Rejected shapes** (§23.2 #29):
> - `activeJobIds: JobId[]` — sessions are explicitly single-active-job. Concurrent execution per session is not supported.
> - `boundTasks: BoundTask[]` stored on `SessionRecord` — the multi-task view in the large card is a *view-model* computed per render (`SessionTaskLedgerItem[]`, see SH-2-25) from `activeJobId` + `queuedJobIds` + historical `JobRecord`s in this session + `RunCandidateService` suggestions.
> - `now: {...}` and `spark: number[]` — derived per render by `SessionTimelineService` (Phase 4A); not stored.

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
    | "on_quiet"
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
  | SessionWarningEvent
  | SessionWarningClearedEvent
  | SessionOutputEvent
  | SessionStoppedEvent
  | SessionStdioCaptureChangedEvent
  | SessionTokenRotatedEvent
  | SessionTokenAuditEvent
  | JobStartedEvent
  | JobCheckpointEvent
  | JobCompletedEvent
  | JobRolloverRequestedEvent
  | SkillRunStartedEvent
  | SkillRunFinishedEvent
  | RepoChangeEvent
  | RepoBurstEvent
  | VerifyCommandStartedEvent
  | VerifyCommandCompletedEvent
  | VerifyHumanApprovalRequestedEvent
  | VerifyHumanApprovalResolvedEvent
  | ConflictAckEvent
  | AttentionAckEvent
  | AttentionSnoozedEvent
  | AttentionClearedEvent
  | HumanOverrideEvent
  // v0.7 design-integration additions:
  | SessionSandboxChangedEvent        // restart-with-stricter-sandbox or live sandbox change
  | SessionModelChangedEvent          // live mid-thread model swap (capability-gated)
  | SessionTaskAttachedEvent          // AttachTaskModal confirm; updates queuedJobIds
  | SessionTaskUnboundEvent           // explicit [Unbind] from ledger row
  | JobQueuedEvent                    // task attached while activeJob in flight
  | JobUnblockedEvent                 // manual [UNBLOCK] action on blocked job
  | SandboxEscapeRequestedEvent       // Codex thread.approval with kind=sandbox
  | SandboxEscapeResolvedEvent
  | SessionAskEvent                   // cross-session ASK <other-session>
  | SessionInterruptEvent             // composer INTERRUPT → threads.cancel
  | NewTaskFromLauncherEvent;         // audit trail for "+ Add Task" from Run Session
```

> Layout updates are **not** part of `RuntimeEvent`. Layout is UI-only state persisted by atomic JSON overwrite at `.runtime/layouts/session-hub.json` — see §5.1 and §12.4. Removing `LayoutUpdatedEvent` keeps the event log focused on auditable session/job/skill activity and prevents UI drag noise from inflating the JSONL.

All events include:

```ts
interface RuntimeEventBase {
  schemaVersion: 1;
  id: string;
  ts: string;
  type: string;
  source: "ui" | "cli" | "mcp" | "http" | "adapter" | "watcher" | "system";
  workspace: string;
  idempotencyKey?: string;
}
```

Mutating HTTP/MCP/app-server calls MAY provide `idempotencyKey`. `RuntimeStore` deduplicates by `(sessionId?, jobId?, source, idempotencyKey)` when present, so retrying a heartbeat/checkpoint/skill/verify call does not duplicate state transitions.

### 6.7 Run Session funnel models

```ts
type RunEntryPoint =
  | { kind: "task_card"; projectSlug: string; taskId: string; lockedTask: true }
  | { kind: "swimlane"; projectSlug: string; laneId: string; preselectBest: true }
  | { kind: "hub"; projectSlug?: string }
  | { kind: "cli"; projectSlug?: string; taskId?: string }
  | { kind: "attach"; projectSlug?: string; taskId?: string; existingSessionId?: string };

interface RunSessionDraft {
  id: string;
  entryPoint: RunEntryPoint;
  // v0.7 additions:
  source: "task_card" | "swimlane_next" | "hub_run" | "global_new_session" | "attach" | "cli";  // §23.2 #33
  mode: "task_backed" | "untasked" | "attach_existing";                                          // §23.2 #33
  projectSlug?: string;
  taskId?: string;                       // required iff mode === "task_backed"
  taskLocked: boolean;
  profileId?: string;
  runtime: "codex_app_server" | "dumb_terminal" | "mcp_tracked" | "manual" | "attach_existing";
  providerId?: string;                   // v0.7: provider broker reference
  model?: string;                        // v0.7
  sandbox?: "readonly" | "workspace-write" | "autoedit" | "full-auto";  // v0.7
  adapterConfig?: Record<string, unknown>;
  repoRoot?: string;
  worktreePath?: string;
  branch?: string;
  contextPreviewRef?: ContextPackRef;
  skillPlanPreview?: SkillPlanItem[];
  verifyPackPreview?: VerifyPack;
  capabilityPreview?: ProviderCapabilities;
  claimMode?: "fail_if_active" | "join" | "force";
  expectedTrackerRev?: number;
  warnings: RunPreflightWarning[];
  createdAt: string;
  expiresAt: string;
}

// v0.7: NewTaskFormDraft is transient; must become a durable tracker task before launch (§23.2 #32).
interface NewTaskFormDraft {
  title: string;
  projectSlug: string;
  lane?: string;
  priority?: string;
  dod?: string[];
  // becomes RunSessionDraft.taskId only after a successful tracker patch.
}

type RunPreflightWarning =
  | { kind: "task_already_has_active_job"; jobId: string; severity: "high" }
  | { kind: "missing_repo_metadata"; severity: "medium" }
  | { kind: "shared_worktree"; worktreePath: string; sessionIds: string[]; severity: "medium" | "high" }
  | { kind: "dependencies_not_satisfied"; dependencyTaskIds: string[]; severity: "high" }
  | { kind: "verify_pack_empty"; severity: "medium" }
  | { kind: "adapter_capability_missing"; capability: keyof SessionCapabilities; severity: "low" | "medium" }
  // v0.7 design-integration additions:
  | { kind: "provider_unavailable"; providerId: string; severity: "high" }
  | { kind: "capability_mismatch"; requiredCap: string; severity: "medium" | "high" }
  | { kind: "sandbox_disallowed"; sandbox: string; reason: string; severity: "high" }
  | { kind: "context_injection_unsupported"; severity: "low" | "medium" }
  | { kind: "task_already_bound_other_session"; otherSessionId: string; otherJobId: string; severity: "high" }
  | { kind: "attach_context_overflow"; currentUsed: number; estBriefTokens: number; capacity: number; severity: "medium" | "high" };

interface RunCandidate {
  projectSlug: string;
  taskId: string;
  laneId?: string;
  score: number;
  reasons: string[];
  penalties: string[];
  recommendedProfileId?: string;
  recommendedRuntime?: RunSessionDraft["runtime"];
}
```

Candidate scoring is deterministic and explainable:

```ts
score =
  +100 if task is in selected lane
  +80  if dependencies are satisfied
  +60  if task is marked next/recommended
  +40  if priority is high
  +30  if repo/worktree metadata is present
  +20  if verify plan is present
  -100 if task already has active job
  -80  if blocked
  -50  if another active session shares same worktree
  -40  if allowed_paths missing for a risky repo
```

### 6.8 Attention models

```ts
type AttentionKind =
  | "approval_needed"
  | "blocked"
  | "conflict"
  | "outside_allowed_paths"
  | "not_responding"
  | "quiet"
  | "context_high"
  | "done_needs_closeout"
  | "done_claimed_verify_missing"
  | "verify_missing"
  | "unbound_session";

type AttentionSource =
  | "structured"
  | "reported"
  | "derived"
  | "manual"
  | "watcher_git"
  | "unknown";

interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: "critical" | "high" | "medium" | "low";
  projectSlug?: string;
  taskId?: string;
  jobId?: string;
  sessionId?: string;
  title: string;
  detail: string;
  source: AttentionSource;
  evidenceRef?: string;          // RuntimeEvent id, tracker rev, or conflict id
  createdAt: string;
  updatedAt: string;
  dedupeKey: string;
  recommendedActions: AttentionAction[];
  acknowledgedAt?: string;
  snoozedUntil?: string;
  clearedAt?: string;
}

interface AttentionAction {
  id: string;
  label: string;
  kind:
    | "open_session"
    | "open_stdio"
    | "open_chat"
    | "approve"
    | "deny"
    | "request_checkpoint"
    | "rollover"
    | "run_closeout"
    | "run_verify"
    | "spawn_reviewer"
    | "view_conflict"
    | "create_worktree"
    | "bind_task"
    | "copy_context"
    // v0.7 design-integration additions:
    | "escalate_sandbox"              // approve with extended permission (Codex thread.approval kind=sandbox)
    | "unblock"                       // manual override of blocked_on_dep
    | "ask"                           // cross-session ASK <target>
    | "interrupt"                     // composer INTERRUPT → threads.cancel
    | "complete_override"             // override completion gate-block with reason
    | "attach_task"                   // drag/drop or explicit attach
    | "add_task_then_run"             // inline create from launcher (writes tracker first)
    | "swap_model_live"               // capability-gated mid-thread swap
    | "restart_with_new_model"        // successor spawn (default model swap path)
    | "restart_stricter_sandbox"      // restart with demoted sandbox
    | "restart_all_quiet"             // batched action on quiet_terminal sessions
    | "acknowledge"
    | "snooze";
  enabled: boolean;
  disabledReason?: string;
}
```

Attention items are projections over runtime/tracker/watcher state. Only operator interactions with attention items (`ack`, `snooze`, manual clear) are persisted as runtime events.

### 6.9 Tracker schema additions

Session Hub introduces new optional fields on tracker tasks. The additions are backward compatible: existing trackers without them keep working, and the tracker store accepts JSON with or without these fields.

#### 6.9.1 `task.repos`

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

#### 6.9.2 `task.verify`

```ts
interface TaskVerify {
  items: VerifyPackItem[]; // see §11.6.2
  notes?: string;
}
```

Optional, task-author-stamped verify items that get merged into the job's verify pack at job creation (§11.6).

#### 6.9.3 Migration

These fields are additive and unversioned. The tracker JSON schema validator accepts the new keys but does not require them. No existing tracker JSON requires rewriting. A future major version may promote them to required for specific task kinds; v0.4 keeps them optional.

Recommended order for adopters:

1. Update tracker schema validator to allow the new keys (no rewrite of stored JSON).
2. Add UI affordances in the existing tracker board for editing `repos` and `verify` on a task.
3. Backfill `repos.primary.root` for tasks tied to a single repo; leave others empty.
4. Add `allowed_paths` opportunistically as work surfaces overlap warnings.

#### 6.9.4 Validation constraints

The validator MUST enforce the following beyond shape:

**`task.repos`:**

- `secondary` array, max 16 entries.
- `TaskRepoRef.root` required when `TaskRepoRef` exists; non-empty string; absolute or workspace-relative path allowed; no NUL byte; max 1024 chars.
- `TaskRepoRef.worktree` optional string; same charset/length rules as `root`.
- `TaskRepoRef.branch` optional string; no NUL byte; max 256 chars.
- `TaskRepoRef.allowed_paths` optional `string[]`; max 256 patterns; each pattern non-empty, max 512 chars, repo-relative POSIX-style; must NOT start with `/`, must NOT contain `..`, must NOT contain NUL. Absolute paths and Windows-drive paths are rejected.

**`task.verify`:**

- `items` required when `task.verify` exists; array; max 128 items.
- `VerifyPackItem.id` required, regex `^[a-z0-9][a-z0-9_.:-]{0,63}$`, unique per `task.verify.items`.
- `VerifyPackItem.required` required boolean.
- Per-kind constraints:
  - `command.cmd` non-empty string, max 4096 chars; `command.cwd` optional repo-relative path (no absolute, no `..`, no NUL); `command.timeoutSec` optional positive integer 1..3600; `command.expectExit` optional integer (default 0).
  - `lint.tool` non-empty string, regex `^[a-zA-Z0-9_.:-]+$`; `lint.args` optional `string[]`, max 128 entries.
  - `skill_run.skillId` regex `^[a-z0-9][a-z0-9_.:-]{0,127}$`.
  - `human_approval.prompt` non-empty, max 2000 chars.
  - `dod_check.ref` non-empty, max 256 chars.

**Watcher semantics (§9.5):**

- If `allowed_paths` is absent, the watcher does not emit `outside_allowed_paths`.
- If `allowed_paths` is present, the watcher normalizes the changed file path relative to the repo root and matches against `allowed_paths` using one shared glob engine.

**Verify-pack composition collision (§11.6.1):**

- Earlier source wins on `id` collision: `task.verify.items` > profile defaults > workspace defaults.

### 6.10 Runtime ID format

Canonical IDs for every runtime object are lower-case ULID with a 3-letter type prefix, joined by an underscore.

```ts
type SessionId       = `ses_${string}`;
type JobId           = `job_${string}`;
type RuntimeEventId  = `evt_${string}`;
type SkillRunId      = `skr_${string}`;
type ContextPackId   = `ctx_${string}`;
type AttentionItemId = `att_${string}`;

const ID_ALPHABET    = "[0-9a-hjkmnp-tv-z]{26}";
const SESSION_ID_RE  = /^ses_[0-9a-hjkmnp-tv-z]{26}$/;
// equivalent regexes exist for the other prefixes
```

Examples:

```text
ses_01jv8q9f4x8y7z6w5v4t3s2r1q
job_01jv8qa1n7f9b9c2m3t4x5y6z7
evt_01jv8qbbk9p4c2a1z8x7m6n5q4
skr_01jv8qcd2k7h8m9n1p2q3r4s5t
ctx_01jv8qdr3m4n5p6q7r8s9t1v2w
att_01jv8qef4n5p6q7r8s9t1v2w3x
```

Helper:

```ts
const ID_ALPHABET_RE = "[0-9a-hjkmnp-tv-z]{26}";

export function makeRuntimeId(
  prefix: "ses" | "job" | "evt" | "skr" | "ctx" | "att"
): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export function isSessionId(value: string): boolean {
  return /^ses_[0-9a-hjkmnp-tv-z]{26}$/.test(value);
}
```

Rules:

- IDs are generated by the hub. Clients and agents never produce them.
- IDs are immutable.
- IDs are safe for URLs, JSON, filenames, and MCP args.
- Do not derive business logic from the ULID timestamp; use `startedAt` / `ts` fields.
- Reject client-provided IDs except in an explicit test-fixture mode.

UI display alias: cards MAY render a short alias derived from the last 4–6 characters of the canonical ID (e.g. `ses-K2WX`), expanded on collision among active sessions. The alias is display-only. APIs, file paths, MCP tools, event logs, and runtime references always use the canonical ID.

### 6.11 `SessionHubLayoutFile`

Single workspace-local file at `.runtime/layouts/session-hub.json`. Atomic overwrite; corrupt → default.

```ts
interface SessionHubLayoutFile {
  version: 1;
  global: {
    cardSizeDefault: "compact" | "normal" | "large";
    dockWidth?: number;
  };
  views: {
    hub?: HubLayout;
    triage?: TriageLayout;
    project?: Record<string, ProjectSessionStripLayout>;
  };
}

interface HubLayout {
  groupBy?: "project" | "urgency" | "custom" | "provider" | "repo_worktree" | "swimlane";
  collapsedGroups?: string[];
  pinnedSessionIds?: SessionId[];
  cardSizeOverride?: Record<SessionId, "compact" | "normal" | "large">;
}

interface TriageLayout {
  visibleKinds?: AttentionKind[];
  sortBy?: "severity" | "createdAt";
}

interface ProjectSessionStripLayout {
  collapsed?: boolean;
  pinnedSessionIds?: SessionId[];
}
```

There is no separate per-project layout file. Per-project state, if any, lives under `views.project[<slug>]`.

### 6.12 `DiffReviewRecord`

Metadata only. Diff content is computed on demand from git/worktree state — never persisted.

```ts
interface DiffReviewRecord {
  id: string;
  projectSlug: string;
  taskId?: string;
  jobId?: JobId;
  sessionId?: SessionId;
  baseRev?: number;
  baseGitSha?: string;
  status: "open" | "reviewed" | "changes_requested" | "approved" | "closed";
  evidenceRefs: RuntimeEventId[];
  createdAt: string;
  updatedAt: string;
}
```

Rationale (§23.2 closure 24): diff hunks may contain secrets, generated files, or large blobs. Git is authoritative for content; only review metadata and audit trail persist.

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

> **Illustrative table only.** The actual method names are loaded at runtime from the vendored Codex schema (§23.2 closure item 19; SH-9-12). Upstream Codex primitives are `Thread`, `Turn`, `Item`; representative shapes are `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, with streamed item notifications and `turn/completed`. Treat the names below as a placeholder map — wire to whatever the vendored schema exposes.

| Method (illustrative) | Direction | Purpose |
|---|---|---|
| `hello` | client → server | handshake, capability exchange |
| `threads.create` (≈ `thread/start`) | client → server | start new app-server thread for a session |
| `threads.resume` (≈ `thread/resume`) | client → server | reattach to an existing thread |
| `threads.list` | client → server | enumerate live threads after reconnect |
| `threads.send` (≈ `turn/start`) | client → server | send chat / instruction message |
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
    minutesSince(session.lastStructuredEventAt) > missingHeartbeatAfterMinutes
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

## 8A. Run Session and Attention Orchestration

### 8A.1 RunSessionService

`RunSessionService` owns the single funnel used by task-card, swimlane, Hub, CLI, and attach entry points. Entry points differ only in how they initialize the `RunSessionDraft`; all launches converge on the same job/session creation path.

```text
task card [+ RUN SESSION]       -> draft(task locked)
swimlane [+ NEXT IN LANE]       -> draft(best candidate preselected)
Hub [+ RUN]                     -> draft(candidate picker)
CLI session start/attach        -> draft(args prefilled)
existing session adopt/rebind   -> draft(attach mode)

launch draft
  -> validate expected tracker rev
  -> claim/start task if needed
  -> create JobRecord
  -> stamp VerifyPack
  -> generate start ContextPack
  -> create/start/attach SessionRecord
  -> broadcast session/job/attention projection
```

#### Task claim semantics

Task-backed launches use an expected tracker revision to avoid two sessions silently claiming the same task.

```http
POST /api/run-session/launch
{
  "draftId": "draft_123",
  "expectedTrackerRev": 42,
  "claimMode": "fail_if_active" | "join" | "force"
}
```

Response shape:

```ts
type RunLaunchResult =
  | { ok: true; mode: "created"; sessionId: string; jobId: string; taskClaimed: true }
  | { ok: true; mode: "joined"; sessionId: string; jobId: string; taskClaimed: false }
  | { ok: false; error: "task_claim_conflict"; activeJobId: string }
  | { ok: false; error: "stale_tracker_rev"; currentRev: number };
```

`force` always requires explicit human confirmation and creates an auditable runtime event.

### 8A.2 RunCandidateService

`RunCandidateService` ranks runnable tasks for `[+ NEXT IN LANE]` and Hub `[+ RUN]`. It reads tracker task state, dependencies, `next`, priority, repo metadata, verify metadata, active jobs, and session/worktree conflicts.

It returns candidates with explanation strings, not a black-box score only. The UI should show why a task was recommended.

### 8A.3 AttentionEngine

`AttentionEngine` is a projection service. It does not create durable tracker truth. It computes `AttentionItem[]` from:

- session status/warnings;
- job status and completion gates;
- app-server approvals;
- MCP blockers/heartbeats/context usage;
- watcher/git conflicts and outside allowed paths;
- raw tracker patches that mark tasks complete while job gates are missing;
- unbound active sessions;
- ack/snooze runtime events.

Priority order:

```text
Critical
1. approval_needed
2. conflict / outside_allowed_paths with active write risk

High
3. blocked
4. not_responding / missing_heartbeat
5. context_high with rollover pack ready

Medium
6. done_claimed_verify_missing
7. done_needs_closeout
8. verify_missing

Low
9. quiet_terminal
10. unbound_session
```

Generation rules:

- Raw stdio content never creates `approval_needed`, `blocked`, `done`, or `verify_missing`.
- Dumb terminal silence may create `quiet` with source `derived`.
- Missing heartbeat may create `not_responding` with source `reported` or `structured`, depending on tier.
- `context_high` requires structured app-server or MCP context usage.
- `outside_allowed_paths` comes from watcher/git evidence, not agent self-reporting.
- `done_claimed_verify_missing` appears when durable tracker state or structured job status says done while required gates lack evidence.

Clear rules:

- `approval_needed` clears on structured approval resolution or explicit human resolution.
- `blocked` clears on structured status change, human resolution, or job completion/cancel.
- `not_responding` clears on next structured heartbeat/event.
- `quiet` clears on next raw output for dumb-terminal sessions.
- `context_high` clears only when session rolls over, is archived, or structured context drops below threshold due to adapter-specific reset/restart.
- `done_needs_closeout` clears when closeout/handoff/archive gate is satisfied or overridden.
- `conflict` / `outside_allowed_paths` clear when git/worktree evidence no longer shows the conflict, or when human acknowledges with reason where the warning type permits acknowledgement.

### 8A.4 Attention strip and Triage projection

The Attention strip requests `GET /api/attention?scope=global&limit=5` and renders only high-signal active items. Triage requests the full ordered list and groups by severity/kind.

Attention items are deduped by `dedupeKey`, usually:

```text
kind + projectSlug + taskId? + jobId? + sessionId? + evidenceRef?
```

Ack/snooze are persisted as runtime events so the projection can survive reload. They do not mutate tracker tasks.

### 8A.5 MCP session contract

Every manual/attach/dumb-terminal session can generate a pasteable contract:

```text
You are attached to llm-tracker session {{sessionId}} and job {{jobId}}.
Use these tools:
- tracker_session_heartbeat every 5 minutes
- tracker_job_checkpoint after meaningful progress
- tracker_session_blocked when blocked
- tracker_session_context_usage if your runtime can measure context
- tracker_skill_run_complete when a required skill is complete
- tracker_session_handoff before stopping or rolling over

Do not mark complete until verify gates are satisfied.
```

The contract is a capability upgrade path, not a limitation: a low-capability session can still be operated manually while inviting the agent to report structured state.

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

```ts
interface RepoBurstEvent extends RuntimeEventBase {
  type: "repo.burst";
  projectSlug: string;
  repoRoot: string;
  fileCount: number;
  samplePaths: string[];
  activeSessionIds: string[];
  attribution: "ambiguous" | "unknown" | "mixed";
  reason: "maxBatchSize_exceeded" | "watcher_storm";
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

#### 11.5.1 UI-driven Complete enforcement (§23.2 #12)

Default enforcement: `sessionHub.completionGates.uiCompleteMode: block_required_missing`. The UI `[COMPLETE]` button does NOT silently succeed when required gates are missing — it opens the completion-gates panel and returns a structured result.

```ts
type JobCompleteResult =
  | { ok: true;  mode: "completed";              jobId: string }
  | { ok: false; mode: "gates_pending";
      missing: CompletionGate[];                              // every required gate with status !== "satisfied"
      requiresOverride: boolean;
      overridePromptUrl: string }
  | { ok: true;  mode: "completed_via_override";
      jobId: string;
      overrideEventId: string };                              // HumanOverrideEvent id
```

`mode: "gates_pending"` is HTTP 200 — it's a normal flow, not an error. Frontend renders the panel from `missing[]`. Calling `complete` again succeeds only if every required gate flips to `satisfied` OR the caller invokes the override endpoint with a reason.

`mode: "completed_via_override"` requires:

- non-empty `overrideReason` text,
- `HumanOverrideEvent` recorded with `{ jobId, gateIds[], reason, user, ts }`,
- each overridden gate carries `evidenceRef: <HumanOverrideEvent.id>` and `status: "overridden"`.

Direct tracker patches (`tracker_task_set_status: complete`) bypass this flow and produce a `done_claimed_verify_missing` AttentionItem on the active job, per §23.2 #12.

### 11.6 Verify pack

The verify pack is the concrete, immutable set of checks a job must satisfy before it can be marked complete. It is computed at job creation, stamped onto `JobRecord.completionGates`, and cannot be silently widened mid-run.

#### 11.6.1 Composition

A verify pack is assembled from three sources, in this precedence (later sources merge with earlier; earlier sources win on `id` collision):

1. **Task-level verify spec** — `task.verify.items` from the tracker (§6.9.2), if present. These are author-stamped per-task checks.
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

### 12.0 Run Session and attention endpoints

```http
GET    /api/run-candidates?projectSlug=<slug>&laneId=<laneId>
POST   /api/run-session/draft
GET    /api/run-session/drafts/:draftId
PATCH  /api/run-session/drafts/:draftId
POST   /api/run-session/launch

GET    /api/attention?scope=global|project&projectSlug=<slug>&limit=5
GET    /api/attention/:attentionId
POST   /api/attention/:attentionId/ack
POST   /api/attention/:attentionId/snooze
POST   /api/attention/:attentionId/clear
```

`POST /api/run-session/launch` is the only UI path that creates a task-backed job/session from the wizard. Task-card, swimlane, Hub, CLI, and attach flows all call into this endpoint after producing a draft.

Attention endpoints read the `AttentionEngine` projection. `ack`, `snooze`, and `clear` append runtime events; they do not patch tracker task state.

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

### 12.6 Attach / queue endpoints (v0.7 design integration)

```http
POST   /api/sessions/:sessionId/attach-task/preview   # 6-check preflight; never mutates
POST   /api/sessions/:sessionId/attach-task           # creates JobRecord (running) or queues it (JobQueuedEvent)
POST   /api/sessions/:sessionId/queue/:jobId/cancel   # cancel a queued (not-yet-started) successor
POST   /api/sessions/:sessionId/queue/reorder         # reorder queuedJobIds
POST   /api/sessions/:sessionId/bind-task             # bind a task to an untasked session → creates JobRecord
```

### 12.7 Restart / model swap endpoints (v0.7)

```http
POST   /api/sessions/:sessionId/restart               # body: { preset, model?, sandbox?, keepCtx? }
POST   /api/sessions/:sessionId/model/swap-live       # capability-gated; 409 if !modelSwapMidThread
POST   /api/sessions/scope/restart-quiet              # body: { dryRun? } → batched successor spawn
```

Restart `preset` enum: `soft | hard | model | sandbox | rollover | quiet_scope`. Each preset records a runtime event and the equivalent CLI.

### 12.8 Cross-session primitives (v0.7)

```http
POST   /api/sessions/:sessionId/ask                   # body: { targetSessionId, prompt }
POST   /api/sessions/:sessionId/interrupt             # provider threads.cancel; 409 if !turnInterrupt
POST   /api/jobs/:jobId/unblock                       # human override of blocked_on_dep
POST   /api/jobs/:jobId/complete-override             # required: { reason }
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
tracker_session_unblocked            # v0.7 — paired with tracker_session_blocked
tracker_session_handoff
tracker_session_context_usage
tracker_session_complete
tracker_session_list
tracker_session_context
tracker_session_broadcast
tracker_session_ask                  # v0.7 — cross-session targeted question
tracker_session_attach_task          # v0.7 — programmatic AttachTaskModal
tracker_session_interrupt            # v0.7 — provider threads.cancel (capability-gated)
```

### 13.2 Job tools

```text
tracker_job_start
tracker_job_status
tracker_job_checkpoint
tracker_job_complete
tracker_job_complete_override        # v0.7 — required: reason; emits HumanOverrideEvent
tracker_job_rollover
tracker_job_context_pack
tracker_job_skill_plan
tracker_job_unblock                  # v0.7 — manual override on blocked job
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
llm-tracker attention
llm-tracker run candidates --project <slug> --lane <laneId>
llm-tracker run session --project <slug> --task <taskId> --profile code-implementer --adapter codex-app-server

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
  | { type: "attention.updated"; items: AttentionItem[]; scope: "global" | "project" }
  | { type: "run-session.draft.updated"; draft: RunSessionDraft }
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
AppShell
  AttentionStrip
  TopNav

SessionHubPage
  SessionFilterBar
  SessionGroupList
    SessionGroup
      SessionCard
  RunSessionButton
  SessionDetailDock
    SessionSummaryTab
    SessionStdioTab
    SessionChatTab
    SessionContextTab
    SessionSkillsTab
    SessionEventsTab
    SessionAttentionTab
  ToolShelf
  RunSessionWizard
  RunCandidatePicker
  RolloverDialog
  ConflictBanner

ProjectBoardPage additions
  ProjectSessionStrip
  TaskSessionBadge
  TaskRunButton
  SwimlaneRunNextButton

TriagePage
  AttentionSeverityLane
  AttentionItemCard
  AttentionActionBar
```

### 16.2 Simple layout mechanics

- Use CSS grid/flex for groups.
- Card size is enum: `compact | normal | large` for the first operator-capable build.
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

```ts
interface AttentionStripViewModel {
  items: Array<Pick<AttentionItem,
    "id" | "kind" | "severity" | "title" | "source" | "recommendedActions"
  >>;
  overflowCount: number;
  collapsed: boolean;
}

interface RunSessionWizardViewModel {
  draft: RunSessionDraft;
  taskCandidates: RunCandidate[];
  selectedTaskLocked: boolean;
  canLaunch: boolean;
  launchDisabledReason?: string;
  preflightWarnings: RunPreflightWarning[];
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
[OPEN] [STDIO] [CHAT] [PING] [STOP] [RESUME] [ROLLOVER] [ARCHIVE]
```

Selected job:

```text
[CONTEXT] [SKILLS] [CHECKPOINT] [BLOCKED] [VERIFY] [CLOSEOUT] [COMPLETE]
```

Actions requiring missing capability are disabled with a short reason, not hidden. If direct execution is unavailable, the UI should offer the nearest manual, clipboard, or MCP-contract alternative.

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

### 20.4 RunSessionService

- task-card entry creates a draft with task locked;
- swimlane entry returns highest-fit runnable task with explanation strings;
- Hub entry returns cross-project candidates when no project is selected;
- launch with stale tracker rev returns `stale_tracker_rev`;
- launch against task with active job returns `task_claim_conflict` unless `join` or confirmed `force`;
- launch creates JobRecord, stamps VerifyPack, creates ContextPack, creates/attaches SessionRecord, and broadcasts projection updates;
- attach-existing mode can create manual/dumb session without process restart.

### 20.5 AttentionEngine

- app-server approval event creates `approval_needed` with source `structured`;
- MCP blocked status creates `blocked` with source `reported`;
- watcher/git outside allowed path creates `outside_allowed_paths` with source `watcher_git`;
- missing heartbeat creates `not_responding`;
- dumb terminal silence creates `quiet`, not `not_responding`;
- raw stdio text containing approval-like text never creates `approval_needed`;
- context usage over threshold creates `context_high` only from app-server/MCP usage events;
- tracker patch to complete while gates missing creates `done_claimed_verify_missing`;
- ack/snooze persists through projection rebuild;
- dedupeKey prevents duplicate attention items for repeated equivalent warnings.

### 20.6 Rollover

- builds pack without old session available;
- includes tracker brief/why/execute/verify;
- includes changed-since start rev;
- includes git evidence when repo exists;
- labels old-session handoff advisory.

### 20.7 WorkspaceWatcher

- emits repo change events;
- ignores configured directories;
- detects ambiguous write with shared worktree;
- detects same-file multi-session conflict;
- detects outside allowed paths;
- coalesces a burst of N rapid fs events on the same path into one `repo.change` event (§9.6);
- never enqueues more than `maxBatchSize` individual events for a single watcher burst — produces a `repo.burst` aggregate instead.

### 20.8 Skills/jobs

- profile creates expected skill plan;
- skill run via MCP marks gate satisfied;
- raw stdio containing `$lt:verify` text does not satisfy gate;
- human override requires reason;
- completion gate warnings appear;
- verify pack is stamped at job creation and is immutable thereafter;
- a patch to `task.verify` after the pack is stamped does NOT widen the in-flight job's gates;
- a gate cannot flip to `satisfied` without a corresponding `evidenceRef` pointing at a real RuntimeEvent.

### 20.9 UI

- 10+ session cards render cleanly;
- filters work;
- Attention strip renders high-signal items across Hub, project board, task detail, and Triage;
- Triage groups attention items by severity/kind;
- Project board Sessions strip shows only current-project sessions;
- task cards show `[+ RUN SESSION]` when runnable/unbound and `[OPEN SESSION]` when bound;
- card size changes (`compact | normal | large`) persist via the layout JSON;
- drag/drop group assignment persists;
- tool shelf actions are one-click;
- disabled actions show reason;
- layout state never enters `runtime-events.jsonl` (regression guard against `LayoutUpdatedEvent` reappearing);
- stdio capture indicator renders on every card whose adapter is writing raw stdio to disk.

### 20.10 Auth and stdio retention

- a state-mutating call without a valid `X-LT-Session-Token` is rejected with 401;
- token rotation immediately revokes the old token;
- stdio log over `maxBytes` rotates to a numbered segment;
- segment count above the retention bound deletes the oldest segments;
- read-only endpoints (list sessions, fetch context pack, view stdio) do NOT require the session token.

### 20.11 WebSocket coalescing

- rapid `session.output` chunks within the 50 ms window collapse into one WS message containing the chunk array;
- ordering within the chunk array matches arrival order;
- `layout.updated` debounces within 100 ms — a drag gesture produces one broadcast, not many.

---

## 21. Implementation plan

This plan targets an operator-capable personal build rather than a minimal public release.

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
- schemaVersion/idempotencyKey support;
- WebSocket runtime events;
- basic session CRUD.

### Phase 2 — Session presence + dumb/manual control

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

### Phase 3 — Run Session funnel + board integration

Files/modules:

```text
hub/run-session/service.js
hub/run-session/drafts.js
hub/run-session/candidates.js
hub/run-session/task-claim.js
ui/run-session/*
ui/project-board/ProjectSessionStrip.*
ui/project-board/TaskSessionBadge.*
```

Deliver:

- `[+ RUN SESSION]` task-card entry;
- `[+ NEXT IN LANE]` swimlane entry;
- Hub `[+ RUN]` entry;
- `RunSessionDraft` creation/update/launch endpoints;
- fit-ranked candidate picker with explanations;
- task claim semantics with expected tracker rev;
- task/session badges on cards;
- project board Sessions strip.

### Phase 4 — Attention strip + Triage

Files/modules:

```text
hub/attention/engine.js
hub/attention/projection.js
hub/attention/actions.js
ui/attention/AttentionStrip.*
ui/triage/TriagePage.*
```

Deliver:

- `AttentionEngine` projection;
- persistent Attention strip;
- Triage view grouped by severity/kind;
- ack/snooze/clear endpoints and runtime events;
- recommended actions for every attention item;
- source/evidence labels everywhere.

### Phase 5 — Jobs and skills

Files/modules:

```text
hub/jobs/registry.js
hub/jobs/profiles.js
hub/jobs/verify-pack.js              # verify pack composition + stamping (§11.6)
hub/skills/registry.js
hub/skills/gates.js
```

Tracker schema:

- accept new optional `task.repos` (with `allowed_paths`) and `task.verify` fields (§6.9);
- no migration of existing tracker JSON required.

Deliver:

- start job from task;
- skill plan generation;
- verify pack stamped at job creation, immutable thereafter;
- evidence-bound gate transitions (no UI-only flips to `satisfied`);
- tool shelf;
- context packs;
- gate warnings.

### Phase 6 — MCP reporting

Files/modules:

```text
bin/mcp-server.js additions
hub/runtime/mcp-events.js
hub/sessions/auth/mcp-token.js       # validate sessionToken argument on every mutation tool
```

Deliver:

- session/job/skill MCP tools;
- pasteable MCP session contract;
- explicit structured reports;
- `tracker_session_context_usage` for agents that want to participate in `context_high` detection;
- every state-mutating MCP tool validates the session token (§19.2);
- verified skill runs.

### Phase 7 — Workspace watcher/conflicts

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
- outside-allowed-path warnings;
- allowed-path checks driven by `task.repos.allowed_paths` (§6.9.1);
- worktree recommendation / create-worktree action where available.

### Phase 8 — Deterministic rollover

Files/modules:

```text
hub/context-packs/service.js
hub/context-packs/rollover.js
hub/context-packs/templates.js
```

Deliver:

- rollover pack;
- successor session links;
- prompt review UI;
- attention action for context-high rollover;
- predecessor/successor evidence summary.

### Phase 9 — Codex app-server adapter

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

## 22. Migration and compatibility

- Existing trackers require no migration.
- Existing CLI/MCP/project endpoints keep working.
- `.runtime` is created on demand.
- Runtime feature can be disabled with config flag.
- Direct tracker patches are not blocked by Session Hub; warnings are additive.
- Existing workflow skills remain valid and are registered as built-in skill definitions.
- The new optional task fields `task.repos` and `task.verify` (§6.9) are additive — schema validator accepts them, but no existing JSON requires rewriting.
- Adapters and agents written against pre-v0.4 endpoints will fail closed when they hit a state-mutating endpoint without a session token (§19.2). The v0.4 release notes call out the required header / argument.
- Existing layouts written into the old `runtime-events.jsonl` are not migrated; they were a v0.2-draft-only artifact never shipped, and the layout file (§5.1) becomes the sole source.

---

## 23. Open technical questions

### 23.1 Resolved in v0.4

- **Layout persistence** — atomic JSON overwrite at `.runtime/layouts/session-hub.json`; `LayoutUpdatedEvent` removed from the runtime event log.
- **Stale vs quiet** — single `quiet` ActivityState; cause carried by warning subtype (`quiet_terminal`, `missing_heartbeat`); the `stale` state is removed from the vocabulary entirely.
- **Context-high triggers** — only emitted for sessions whose tier reports structured context usage (app-server `thread.context_usage` or MCP `tracker_session_context_usage`).
- **Adapter ↔ hub auth** — session-scoped ephemeral token required on every state-mutating call (§19.2).
- **Verify pack** — concrete `VerifyPackItem` shape, immutable-after-stamp lifecycle, evidence-bound gate transitions (§11.6).
- **Tracker schema additions** — `task.repos` (incl. `allowed_paths`) and `task.verify` as additive, optional fields (§6.9).
- **Codex app-server protocol** — JSON-RPC over WebSocket, methods, event shapes, capability flags (§7.4.1–§7.4.6).
- **Watcher event coalescing** — debounced per `(repoRoot, path)` before queue enqueue (§9.6).
- **WebSocket stdio coalescing** — server batches over 50 ms; UI render throttled to 30 fps (§15.1).
- **Stdio retention** — 5 MB cap, rolling rotation, bounded segment retention; secrets caveat in §19.3.
- **Run Session funnel** — task-card, swimlane, Hub, CLI, and attach entries converge through `RunSessionDraft` and `RunSessionService`.
- **Run candidate scoring** — deterministic scoring with explanation strings for `[+ NEXT IN LANE]` and Hub `[+ RUN]`.
- **Attention model** — `AttentionEngine`, `AttentionItem`, ack/snooze events, Attention strip, and Triage projection.
- **Runtime event union** — added warning, repo burst, verify command, token audit/rotation, conflict ack, and attention ack/snooze events.
- **Skill phase naming** — replaced `on_stale` with `on_quiet` to match the unified quiet model.

### 23.2 Closed for operator-capable build

1. **Runtime event log split** — keep a single `runtime-events.jsonl` for now. Revisit only if the log exceeds 250 MB or cold projection rebuild exceeds 5 seconds. Watcher storms are already controlled through coalescing and `repo.burst`.

2. **Repo-root discovery for attached sessions** — attach/start flows should pass `cwd`, `repoRoot`, and `worktreePath` when available. CLI attach uses `process.cwd()` plus `git rev-parse --show-toplevel`. If repo discovery fails, the session still attaches but shows `repo unknown`, and watcher/conflict features degrade until the user sets repo/worktree explicitly via the session detail dock.

3. **App-server timing** — Codex app-server is **P0 for the operator-capable build**, but **not a boot-time dependency**. The Hub MUST start and manage sessions with dumb-terminal, manual, and MCP-tracked providers when app-server is unavailable. App-server features are capability-gated: structured chat, approvals, context usage, provider timeline, resume/fork, and direct context injection appear only when the provider advertises support.

4. **Activity thresholds** — defaults:
   - `heartbeatEveryMinutes: 5`
   - `missingHeartbeatAfterMinutes: 12`
   - `dumbTerminalQuietAfterMinutes: 10`
   - `dumbTerminalQuietEscalateAfterMinutes: 25`
   - `appServerDisconnectedWarningAfterSeconds: 60`

   `staleAfterMinutes` is renamed to `missingHeartbeatAfterMinutes`; there is no `stale` ActivityState. Dumb-terminal silence at the escalate threshold raises the existing `quiet_terminal` warning to high severity but never to `approval_needed`.

5. **Worktree recommendation** — when `multiple_sessions_same_worktree` fires, the conflict detector creates an `AttentionItem` whose primary action is `[Create worktree for this job]`. The Hub may also preselect dedicated worktree creation in Run Session preflight when `recommendOnTaskSessionStart` is on. The Hub MUST NOT silently create or move worktrees unless `trustedLocalMode.allowWorktreeCreationFromUI` is enabled.

6. **Default stdio capture** — live stdio viewing is enabled by default; disk capture is disabled by default. Workspace config may opt into capture per `trustedLocalMode.stdioCaptureToDiskDefault`. Session cards MUST show one of the labels `STDIO LIVE`, `STDIO CAPTURED`, `STDIO OFF` so the operator knows the current mode at a glance. When `captureToDisk: false`, the hub keeps an in-memory ring buffer of `stdio.memoryRingBytes` (default 256 KiB) for the live UI and creates no `.runtime/session-stdio/<sessionId>.log`. Toggling capture emits `SessionStdioCaptureChangedEvent` so the change is auditable.

7. **Verify-pack human approval notifications** — push-style, backed by the Attention projection. When a `human_approval` item becomes ready, the hub emits `verify.human_approval.requested`, the `AttentionEngine` creates an `AttentionItem`, and the WS broadcasts `attention.updated`. The UI fetches `/api/attention` on load and on reconnect. No polling-only model. Desktop notifications are off by default; the persistent Attention strip plus Triage is the surfacing mechanism. Use the label `HUMAN APPROVAL REQUIRED` only when the verify item is required and blocks completion; otherwise use `HUMAN REVIEW READY`.

8. **Snapshot debounce max-age** — keep `snapshotDebounceMs: 250`, but force flush after `snapshotMaxAgeMs: 5000` or `snapshotMaxEventsPending: 250`, and always flush on clean shutdown.

9. **Runtime ID format** — canonical IDs are lower-case ULID with type prefix (§6.10). Regex per type, e.g. `SessionId` is `^ses_[0-9a-hjkmnp-tv-z]{26}$`. The hub generates IDs; clients/agents never do. UI may render a short alias like `ses-K2WX` for visual scan, but every API, event log line, MCP arg, file path, and session token uses the canonical ID. Client-supplied IDs are rejected outside an explicit test-fixture mode.

10. **Tracker schema validator scope** — the validator MUST accept optional `task.repos` and `task.verify` (§6.9). Missing fields are valid; present-but-invalid fields fail validation on patch/write. Allowed-path globs are repo-relative only (no absolute paths, no `..`, no NUL); verify-item ids are unique per task and match `^[a-z0-9][a-z0-9_.:-]{0,63}$`. Verify-pack composition collision resolves earlier-source-wins (`task.verify.items` > profile defaults > workspace defaults). Existing tracker JSON without these keys remains valid without rewriting.

11. **Workspace config path** — deterministic lookup order: (1) `--config <path>` flag, (2) `LLM_TRACKER_CONFIG` env var, (3) `<workspaceRoot>/llm-tracker.config.yaml`, (4) `<workspaceRoot>/.llm-tracker/config.yaml`, (5) built-in defaults. Resolved config is exposed at `GET /api/workspace/config/session-hub` and via CLI `llm-tracker config session-hub`.

12. **UI completion gates default** — `uiCompleteMode: block_required_missing`. UI-driven `Complete` is blocked when required gates are missing; human override allowed but requires a recorded reason (creates a runtime event). Direct tracker patches remain allowed and produce a `done_claimed_verify_missing` attention item.

13. **Layout scope** — single workspace-local file at `.runtime/layouts/session-hub.json`. The file may carry per-view and per-project subsections (`views.hub`, `views.triage`, `views.project[<slug>]`), but there is no durable per-project layout truth and no separate per-project file. Shape in §6.11.

14. **CLI session-token transport** — the hub stores **only a token hash**. Launched child processes receive the cleartext token via environment variables: `LT_SESSION_ID`, `LT_JOB_ID`, `LT_SESSION_TOKEN`, `LT_MCP_URL`. Attach/manual flows additionally print a one-time pasteable contract that contains the same values. MCP mutating tools accept `sessionToken` as an argument; HTTP mutating calls use `X-LT-Session-Token`. Token rotates via `POST /api/sessions/:sessionId/token/rotate`; archive revokes; default `maxLifetimeMinutes: 1440`.

15. **Cross-project queue scope** — workspace-scope visibility, never autonomous scheduling. The Hub `[+ RUN]` picker ranks candidates across the current workspace. Multi-session launches require `requireHumanConfirmForMultiLaunch: true` and are capped at `maxInitialLaunches: 3`. The Triage / Attention strip lanes "Runnable now / Blocked / Needs review / Needs closeout / Quiet" aggregate across projects in the current workspace only.

16. **Attention ack/snooze/clear persistence** — runtime events only, never tracker patches. `attention.acknowledged` hides the item from the Attention strip but keeps it visible in Triage where relevant; `attention.snoozed` hides until `until` unless severity escalates; `attention.cleared` happens only when the source condition clears (the underlying warning/conflict/gate). None of these mutate durable tracker truth.

17. **Codex token provisioning** — `llm-tracker` does **not** provision OpenAI/Codex account tokens. The Codex provider uses the installed Codex CLI/app-server auth state. Remote app-server auth, if any, is read from workspace config/env. Hub session-scoped tokens (§19.2) are separate and still required for hub-side mutation.

18. **UI framework** — use the existing `llm-tracker` Browser UI framework. Session Hub does not introduce a framework migration. If an isolated UI package is required, default to React + Vite + TypeScript.

19. **Codex schema vendoring** — generate schemas from the installed Codex version and vendor under `vendor/codex-app-server/<version>/stable/` (or `experimental/` only when explicitly opted in). Generators: `codex app-server generate-ts --out vendor/codex-app-server/<version>/stable` and `codex app-server generate-json-schema --out vendor/codex-app-server/<version>/stable`. The hand-written method/event names in §7.4.3–§7.4.4 are illustrative; the running adapter loads names from the vendored schema. **Upstream Codex primitives are `Thread`, `Turn`, `Item`**; representative method shapes are `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, with streamed item notifications and `turn/completed`. SH-9-12 replaces placeholders during vendoring.

20. **`trustedLocalMode` per-flag defaults** — all powerful background automation is **off** by default; user-clicked actions can be powerful. Defaults shipped in the §25 YAML below.

21. **PTY library** — `node-pty` is the primary PTY backend. Fall back to `child_process.spawn` for non-interactive sessions or platforms where `node-pty` is unavailable. Provider capability flags reflect the fallback (e.g., `terminalResize: false` under the fallback path).

22. **Per-provider PTY wrappers** — do not build bespoke PTY wrappers in the first pass. `GenericPtyProviderAdapter` plus per-provider command templates covers Codex CLI / Claude Code / Kimi / Gemini at the `dumb_terminal` + MCP-overlay tier. Bespoke wrappers (PL-08) stay parking-lotted unless a structured surface appears.

23. **Timeline persistence** — no separate timeline database or append-only log. The timeline is a projection over `RuntimeEvent`s, normalized provider events, repo events, and selected tracker history. Normalized provider events that matter for audit/attention/gates/review are appended to `RuntimeEvent`s; the rest is rebuilt from those on demand. An optional snapshot cache at `.runtime/timeline.snapshot.json` is allowed later but is not authoritative.

24. **Diff persistence** — diff content is computed on demand from git/worktree state. Only `DiffReviewRecord` metadata + `evidenceRefs` persist. Diff hunks may contain secrets or large blobs and are NOT written to runtime storage. Shape in §6.12.

25. **App-server transport priority + fallback** — preferred Codex transport order: **stdio → unix → websocket** (websocket is upstream-experimental and only used when `providers.codex_app_server.transportPreference` explicitly enables it). Fallback table:
    - `thread/resume` unavailable → successor spawn via `thread/start`, labeled "successor spawn" rather than "thread reattach".
    - `thread/fork` unavailable → deterministic rollover pack + `thread/start`.
    - Structured approvals unavailable → no approval badge from this provider.
    - Context usage unavailable → no `context_high` from this provider.
    - Turn-level diff unavailable → `DiffReviewService` uses git/watcher only.
    - App-server unavailable → fall back to `GenericPtyProviderAdapter` (SH-9-13) or manual session.
    - Schema generation unavailable → disable Codex provider and surface a "provider setup required" attention item.

26. **Provider naming** — canonical vocabulary:
    - **Provider** — user-visible runtime integration (Codex app-server, Codex CLI, Claude Code, Generic PTY, Manual).
    - **ProviderAdapter** — internal implementation class.
    - **SessionTier** — capability/trust tier of the resulting session (`dumb_terminal`, `mcp_tracked`, `codex_app_server`, `hybrid`, `manual`).
    - **MCP reporting** is a capability overlay, not a standalone provider.
    - Renames during implementation: `CodexAppServerAdapter` → `CodexAppServerProviderAdapter`; `ProcessSessionAdapter` → `GenericPtyProviderAdapter`; `McpTrackedSessionAdapter` → `McpReportingOverlay`.
    - Config keys use `providers.*`, not `adapters.*`.

27. **Watcher backend** — default is `chokidar`. `ProjectWorkspaceWatcher` depends on a `WatcherBackend` interface; `ChokidarWatcherBackend` is the default implementation, `NodeFsWatchBackend` exists only as a fallback/config override. All backends normalize raw events to `add | change | unlink` before entering the existing coalescer (§9.6).

28. **Process kill escalation** — `[STOP]` sends `SIGINT` and waits `sigintGraceMs: 5000` before sending `SIGKILL`. Sequence: `session.stop.requested` → SIGINT → `process.signal_sent { signal: "SIGINT" }` → wait → if process is still alive → SIGKILL → `process.signal_sent { signal: "SIGKILL", reason: "sigint_grace_expired" }` → `process.exited` + `session.stopped` when observed. `[FORCE KILL]` skips the grace window but is only exposed in the session detail dock, not on the small card.

### 23.3 Closed for design integration (v0.7)

29. **Multi-task per session is a UI projection.** `SessionRecord.activeJobId` stays singular. New optional `SessionRecord.queuedJobIds: JobId[]` (ordered; first is next on activeJob completion). The large-card "bound tasks" panel is a `SessionTaskLedgerItem[]` view-model derived per render from JobRegistry + tracker queue + RunCandidateService. `SessionRecord.activeJobIds: array` is explicitly rejected. `now: {...}` and `spark: number[]` are also derived projections (SessionTimelineService), not stored.

30. **Model swap defaults to successor restart.** `sessionHub.modelSwap.defaultMode: successor_restart`. `[Restart with new model]` always creates a successor session/job using deterministic rollover context. Live mid-thread model swap is shown only when `providerCapabilities.modelSwapMidThread === true` and is labeled "Swap model live" — distinct from "Restart with new model". Top-level `[SWAP MODEL]` requires an unambiguous selection scope; without one it opens the picker for the next launch rather than acting.

31. **Triage labels may be more specific than ActivityState.** UI chips `NO_HEARTBEAT`, `BLOCKED_ON_DEP`, `QUIET`, `APPROVAL`, `CTX_HIGH` are display-only. Underlying states remain `quiet`/`blocked`/`waiting_for_approval`/`context_high` with appropriate warning subtypes (`missing_heartbeat`, dependency-reason payload, `quiet_terminal`). No new ActivityStates are introduced.

32. **`+ Add Task` writes durable tracker truth first.** The launcher may hold a transient `NewTaskFormDraft` (see §6.7) but a real tracker task must be created via the existing tracker Store/patch path before `RunSessionDraft.taskId` is populated. `NewTaskFromLauncherEvent` records the launcher provenance. Runtime-only "draft tasks" launchable as jobs are explicitly rejected.

33. **Untasked sessions allowed via the funnel.** `RunSessionDraft.mode: 'task_backed' | 'untasked' | 'attach_existing'`. `mode: 'untasked'` creates a `SessionRecord` with no `JobRecord`, raises an `unbound_session` AttentionItem after `untaskedSessions.unboundAttentionAfterMinutes`, and disables job-only actions (VERIFY, COMPLETE, skill gates). `[Bind task]` creates the first `JobRecord` and clears the attention. Auto-archive after `untaskedSessions.unboundAutoArchiveAfterHours` if still unbound.

34. **Single launch funnel.** `SessionBrief` / `RunSessionWizard` is the canonical launcher across task-card, swimlane, Hub, CLI, attach, and global `[+ NEW SESSION]` entry points. The parallel `StartSessionWizard` 5-step modal (in the design source) is removed; a CI guard ensures two-funnel implementations cannot land. The remaining differences between entries are `source` + `mode` + which fields are pre-locked.

35. **Multi-task attach is a queue, not parallel execution.** Dragging a task onto an active session opens `AttachTaskModal` (preflight + confirm). On confirm, if the session has an `activeJobId`, the attached task becomes a queued successor job: a new `JobRecord` is created with `status: 'queued'` and `predecessorJobId: <activeJobId>`, appended to `SessionRecord.queuedJobIds`, and a `JobQueuedEvent` is recorded. The session never has more than one `JobRecord` in `status: 'running'`. On `activeJob.completed`, the first queued job auto-starts after a 5 s grace (cancellable via `POST /api/sessions/:id/queue/:jobId/cancel`).

---

## 24. Appendix: minimal runtime event examples

### Session start

```json
{
  "schemaVersion": 1,
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
  "schemaVersion": 1,
  "id": "evt_002",
  "ts": "2026-05-22T16:38:00Z",
  "type": "session.warning",
  "source": "system",
  "workspace": "/Users/adil/.llm-tracker",
  "sessionId": "sess_001",
  "warning": {
    "kind": "quiet_terminal",
    "minutes": 8,
    "message": "No raw output recently; check terminal. Raw stdio is not parsed for approvals."
  }
}
```

### Skill run complete

```json
{
  "schemaVersion": 1,
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
  "schemaVersion": 1,
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

---

## 25. Appendix: workspace config defaults

These defaults close the §23.2 questions and are normative for the operator-capable build. They live under `sessionHub:` in the workspace config loaded by SH-0-03 / SH-0-07.

```yaml
sessionHub:
  activity:
    heartbeatEveryMinutes: 5
    missingHeartbeatAfterMinutes: 12
    dumbTerminalQuietAfterMinutes: 10
    dumbTerminalQuietEscalateAfterMinutes: 25
    appServerDisconnectedWarningAfterSeconds: 60
    contextHighPercent: 85

  stdio:
    liveTail: true
    captureToDisk: false
    promptOnFirstCapture: true
    memoryRingBytes: 262144
    maxBytes: 5242880
    rotatedSegments: 3

  runtimeStore:
    eventLogMode: single
    snapshotDebounceMs: 250
    snapshotMaxAgeMs: 5000
    snapshotMaxEventsPending: 250
    flushOnShutdown: true
    splitWhenLogExceedsMb: 250
    splitWhenColdRebuildExceedsMs: 5000

  worktrees:
    recommendOnSharedWorktree: true
    recommendOnTaskSessionStart: true
    autoCreateWithoutConfirmation: false
    allowTrustedAutoCreateOnLaunch: true
    defaultNamingPattern: "{projectSlug}/{taskId}-{shortTitle}"

  notifications:
    attentionPushWs: true
    desktopNotificationsDefault: false
    humanApprovalStyle: attention_item

  completionGates:
    uiCompleteMode: block_required_missing
    allowHumanOverride: true
    overrideRequiresReason: true
    warnOnDirectTrackerCompleteWithMissingGates: true

  crossProjectQueue:
    enabled: true
    scope: workspace
    requireHumanConfirmForMultiLaunch: true
    maxInitialLaunches: 3

  trustedLocalMode:
    enabled: false
    neverAutoApproveTerminalPrompts: true       # non-overridable

    # Background automation (all OFF by default)
    autoCreateWorktreeOnLaunch: false
    autoRolloverOnContextHigh: false
    autoRunVerifyCommands: false
    autoApproveProviderRequests: false
    autoLaunchCrossProjectQueue: false
    autoArchiveStoppedSessions: false
    stdioCaptureToDiskDefault: false

    # User-initiated powerful actions (ON by default)
    allowDirectContextInjectionOnUserLaunch: true
    allowStdinInjectionOnUserAction: true
    allowSessionRestartOnUserAction: true
    allowVerifyCommandRunOnUserAction: true
    allowWorktreeCreationFromUI: true
    allowProviderReviewFromUI: true
    requireConfirmationForCrossProjectLaunch: true

  providers:
    codex_cli:
      kind: generic_pty
      command: ["codex"]
      mcpContract: true

    claude_code:
      kind: generic_pty
      command: ["claude"]
      mcpContract: true

    kimi:
      kind: generic_pty
      command: ["kimi"]
      mcpContract: true

    gemini:
      kind: generic_pty
      command: ["gemini"]
      mcpContract: true

    codex_app_server:
      kind: structured_provider
      command: ["codex", "app-server", "--listen", "stdio://"]
      transportPreference: ["stdio", "unix"]      # "websocket" is upstream-experimental
      preferGeneratedSchema: true
      schemaVendorPath: "vendor/codex-app-server"
      fallbackProvider: "generic_pty"
      authMode: external_codex_auth
      hubSessionTokenEnv: LT_SESSION_TOKEN

  watcher:
    backend: chokidar          # chokidar | node_fs_watch
    usePolling: false
    atomic: true
    awaitWriteFinish: false
    coalesceMs: 200
    maxBatchSize: 500
    ignore:
      - ".git/**"
      - "node_modules/**"
      - "dist/**"
      - "build/**"
      - ".next/**"
      - "coverage/**"
      - "target/**"
      - ".tmp/**"
      - "vendor/**"
      - ".cache/**"

  processLifecycle:
    stopSignal: SIGINT
    sigintGraceMs: 5000
    forceKillSignal: SIGKILL

  # v0.7 design-integration additions:

  modelSwap:
    defaultMode: successor_restart       # vs live_when_capable
    showLiveSwapWhenCapable: true
    liveSwapKeepCtxDefault: true

  untaskedSessions:
    allowed: true
    unboundAttentionAfterMinutes: 5
    unboundAutoArchiveAfterHours: 72

  attach:
    requireConfirmation: true             # never auto-bind on drop
    contextOverflowWarnPercent: 0.85
    autoStartQueuedOnCompletionGraceSec: 5

  launcher:
    singleFunnel: true                    # CI guard: only SessionBrief/RunSessionWizard
    allowAddTaskInline: true              # opens NewTaskFormDraft; writes tracker before launch
    globalNewSessionPicker: ["pick_task", "untasked", "attach_existing"]
```

Notes:

- `appServerDisconnectedWarningAfterSeconds` produces a `disconnected` warning (§8.3) on the affected sessions; it is independent from `missingHeartbeatAfterMinutes`.
- `dumbTerminalQuietEscalateAfterMinutes` raises an existing `quiet_terminal` warning's severity from medium to high; it never converts the warning kind into `approval_needed`.
- `worktrees.autoCreateWithoutConfirmation` is false in the base default; `trustedLocalMode.allowWorktreeCreationFromUI` plus `worktrees.allowTrustedAutoCreateOnLaunch` together enable one-click creation in Run Session preflight.
- `notifications.humanApprovalStyle: attention_item` means a verify-pack `human_approval` item surfaces through the Attention strip + Triage and emits `verify.human_approval.requested` on the runtime event log; no modal popover is opened by default.
