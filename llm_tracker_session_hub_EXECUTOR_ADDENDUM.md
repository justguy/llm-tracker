# llm-tracker Session Hub — Executor Addendum

**File purpose:** implementation handoff for an LLM/coding agent executing Session Hub.  
**Complements:** `llm_tracker_session_hub_PRD_v0.4.md` and `llm_tracker_session_hub_TDD_v0.4.md`.  
**Status:** Addendum v0.1 — provider-runtime capabilities + execution guidance.  
**Primary outcome:** implement Shiori-like runtime richness without replacing llm-tracker’s tracker-native task/job/session model.

---

## 0. How to use this file

Read this after the PRD and TDD.

The PRD/TDD define the product and technical source of truth. This addendum clarifies how to add runtime-provider capabilities — sessions, threads, timelines, diffs, model/runtime selection, provider-native approvals, and review flows — while preserving llm-tracker’s stronger task-first workflow.

When there is a conflict, follow this precedence:

1. **Non-negotiable safety/trust rules** in the PRD/TDD.
2. **Existing llm-tracker durable project/task semantics.**
3. **The v0.4 PRD/TDD data model and endpoints.**
4. **This addendum.**
5. Provider-specific assumptions.

Provider-specific assumptions must be verified against the installed provider or checked-in provider schema before coding.

---

## 1. North star

Do not build a generic agent chat UI.

Build this:

```text
llm-tracker durable task/project truth
  + active local agent session control
  + provider-native runtime capabilities
  + attention routing
  + deterministic context movement
  + review/verify/closeout discipline
```

The primary object in the user experience remains:

```text
Project → Task → Job → Session → Skill Plan → Attention → Verify / Closeout
```

Provider threads, provider turns, provider events, provider file-change items, and provider review APIs are implementation details. They enhance a `SessionRecord` and `JobRecord`; they do not replace tracker tasks or jobs.

---

## 2. Capabilities to integrate

Add a provider-runtime layer inspired by tools that provide:

- desktop/browser control of local coding-agent sessions;
- project/workspace/branch-aware threads;
- long-running session visibility;
- readable activity timelines;
- generated diff / changed-file review;
- multiple local provider CLIs;
- structured approvals where provider support exists;
- reconnect/resume/fork where provider support exists;
- model/runtime pickers;
- review flows.

In llm-tracker, these become **capability-based enhancements** to the existing Hub, board, Triage, Run Session funnel, and session detail dock.

Do not copy provider UI or make provider threads the top-level workflow.

---

## 3. Non-negotiables to preserve

### 3.1 Raw stdio is display/control only

A raw terminal may produce:

```text
session.output
lastOutputAt
process.started
process.exited
stdin_written
```

It must not produce semantic state such as:

```text
approval_needed
blocked
command_completed
skill_succeeded
task_done
verify_passed
context_high
```

Semantic state may come only from:

```text
structured provider event
MCP / HTTP session-job-skill event
watcher/git evidence
human explicit action
```

### 3.2 Tracker truth remains durable truth

Runtime-provider data lives under `.runtime` and in `RuntimeStore` projection. Durable task/project writes still go through the existing tracker Store and merge/revision behavior.

Never write provider thread IDs, live process handles, raw provider event IDs, or transient runtime state into durable tracker task JSON unless the user or agent explicitly promotes a note/handoff into durable truth.

### 3.3 Provider events are evidence, not magic

Provider events may provide strong evidence for provider-native actions:

```text
provider approval request → approval_needed attention item
provider context usage → context_high attention item
provider command completed → timeline item, maybe verify evidence if tied to a verify item
provider file-change proposed → diff annotation
```

But provider-reported file paths do not clear conflict warnings. Git/watcher evidence remains authoritative for what changed locally.

### 3.4 Capability-based UX

Do not hide the whole workflow when a provider lacks capability. Disable only the physically impossible action and show a short reason.

Example:

```text
Dumb terminal session:
  enabled: STDIO, stdin, stop, restart, copy context, attach task, mark manual status
  disabled: structured approval, provider timeline, provider context usage
  still available: git diff, watcher conflicts, tracker context packs, manual closeout
```

---

## 4. Architecture addition: ProviderBroker

Add a provider-runtime layer below Session Hub:

```text
Browser UI / CLI / MCP
  → RunSessionService / SessionRegistry / JobRegistry
  → ProviderBroker
      → CodexAppServerProvider
      → GenericPtyProvider
      → ClaudeCodePtyProvider
      → KimiPtyProvider
      → GeminiPtyProvider
      → ManualProvider
  → ProviderEventNormalizer
  → RuntimeStore
  → AttentionEngine / TimelineService / DiffReviewService
```

The broker owns provider discovery, start/attach/resume/fork, event streaming, capability detection, and provider-specific transport handling.

The broker does **not** own durable task state.

### 4.1 Suggested module paths

Use existing repo conventions when names differ, but keep this separation:

```text
hub/providers/
  broker.ts
  registry.ts
  capabilities.ts
  provider-events.ts
  normalizer.ts
  provider-thread-ref.ts
  providers/
    generic-pty.ts
    manual.ts
    codex-app-server.ts
    claude-code-pty.ts
    kimi-pty.ts
    gemini-pty.ts

hub/timeline/
  session-timeline-service.ts
  timeline-model.ts

hub/diffs/
  diff-review-service.ts
  git-diff.ts
  provider-file-changes.ts
  changed-since.ts

hub/worktrees/
  worktree-service.ts
  branch-service.ts

hub/attention/
  attention-engine.ts
  attention-actions.ts

hub/run-session/
  run-session-service.ts
  run-candidates.ts
  run-session-draft.ts
```

If the repo is currently JS-only, use `.js` and JSDoc typedefs or the project’s existing type pattern. Do not introduce TypeScript migration unless the repo already uses it.

---

## 5. Provider capability model

Add capability flags. The UI should render actions from these flags, not from provider name checks.

```ts
interface ProviderCapabilities {
  structuredThread: boolean;
  structuredTurns: boolean;
  structuredItems: boolean;
  structuredApprovals: boolean;
  structuredFileChanges: boolean;
  structuredCommandEvents: boolean;
  structuredContextUsage: boolean;
  providerTimeline: boolean;
  providerDiffs: boolean;
  providerReview: boolean;
  modelList: boolean;
  skillList: boolean;
  threadResume: boolean;
  threadFork: boolean;
  turnSteer: boolean;
  turnInterrupt: boolean;
  rawStdio: boolean;
  stdinWrite: boolean;
  processLifecycle: boolean;
  directContextInjection: boolean;
}
```

Map these onto existing `SessionCapabilities` for card/tool behavior.

Example mapping:

```ts
function toSessionCapabilities(providerCaps: ProviderCapabilities): SessionCapabilities {
  return {
    rawStdio: providerCaps.rawStdio,
    stdinWrite: providerCaps.stdinWrite,
    processLifecycle: providerCaps.processLifecycle,
    structuredEvents: providerCaps.structuredThread || providerCaps.structuredTurns || providerCaps.structuredItems,
    structuredApprovals: providerCaps.structuredApprovals,
    structuredChat: providerCaps.structuredTurns,
    structuredCommands: providerCaps.structuredCommandEvents,
    structuredMcpCalls: false,
    explicitTrackerMcp: false,
    appServerChat: providerCaps.structuredTurns,
    directContextInjection: providerCaps.directContextInjection
  };
}
```

---

## 6. Provider interface

Start with this shape. Adjust to repo style.

```ts
interface RuntimeProvider {
  id: string;
  label: string;

  probe(): Promise<ProviderProbeResult>;
  capabilities(): ProviderCapabilities;

  listModels?(): Promise<ModelOption[]>;
  listSkills?(request: { cwd?: string; repoRoot?: string }): Promise<ProviderSkill[]>;

  start(request: ProviderStartRequest): Promise<ProviderThreadHandle>;
  attach?(request: ProviderAttachRequest): Promise<ProviderThreadHandle>;
  resume?(threadRef: ProviderThreadRef): Promise<ProviderThreadHandle>;
  fork?(threadRef: ProviderThreadRef, request: ProviderForkRequest): Promise<ProviderThreadHandle>;

  send?(threadRef: ProviderThreadRef, input: ProviderInput): Promise<void>;
  steer?(threadRef: ProviderThreadRef, input: ProviderInput): Promise<void>;
  interrupt?(threadRef: ProviderThreadRef): Promise<void>;

  approve?(request: ProviderApprovalDecision): Promise<void>;
  deny?(request: ProviderApprovalDecision): Promise<void>;

  streamEvents(threadRef: ProviderThreadRef): AsyncIterable<ProviderEvent>;
  stop?(threadRef: ProviderThreadRef): Promise<void>;
}
```

`GenericPtyProvider` can implement only start/attach/stop/stdio-ish lifecycle. `ManualProvider` can implement no process lifecycle and only creates advisory sessions.

---

## 7. Runtime provider references

Extend runtime session state with provider refs. Keep them in runtime only.

```ts
interface ProviderThreadRef {
  providerId: string;
  transport: "stdio" | "unix" | "websocket" | "pty" | "manual";
  threadId?: string;
  turnId?: string;
  processHandleId?: string;
  providerSessionId?: string;
  cwd?: string;
  repoRoot?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  resumedFromThreadId?: string;
  forkedFromThreadId?: string;
  schemaVersion?: string;
}
```

Add to `SessionRecord` runtime projection:

```ts
providerThread?: ProviderThreadRef;
providerCapabilities?: ProviderCapabilities;
```

If existing TDD already has provider/app-server fields, do not duplicate. Extend rather than replace.

---

## 8. Provider events and normalization

Normalize provider-specific events to provider-neutral events first, then to RuntimeEvents.

```ts
type ProviderEvent =
  | { kind: "thread.started"; providerId: string; threadRef: ProviderThreadRef; ts: string }
  | { kind: "thread.resumed"; providerId: string; threadRef: ProviderThreadRef; ts: string }
  | { kind: "thread.forked"; providerId: string; threadRef: ProviderThreadRef; parentThreadId?: string; ts: string }
  | { kind: "turn.started"; providerId: string; threadId: string; turnId: string; ts: string }
  | { kind: "turn.completed"; providerId: string; threadId: string; turnId: string; status: "succeeded" | "failed" | "cancelled"; ts: string }
  | { kind: "message"; providerId: string; threadId: string; role: "user" | "assistant" | "tool" | "system"; text: string; ts: string }
  | { kind: "command.started"; providerId: string; threadId: string; commandId: string; command: string; cwd?: string; ts: string }
  | { kind: "command.output"; providerId: string; threadId: string; commandId: string; stream: "stdout" | "stderr"; text: string; ts: string }
  | { kind: "command.completed"; providerId: string; threadId: string; commandId: string; exitCode?: number; durationMs?: number; ts: string }
  | { kind: "file_change.proposed"; providerId: string; threadId: string; proposalId: string; files: string[]; summary?: string; ts: string }
  | { kind: "file_change.applied"; providerId: string; threadId: string; proposalId: string; files: string[]; ts: string }
  | { kind: "approval.requested"; providerId: string; threadId: string; approvalId: string; title: string; detail?: string; ts: string }
  | { kind: "approval.resolved"; providerId: string; threadId: string; approvalId: string; decision: "approved" | "denied" | "cancelled"; ts: string }
  | { kind: "context.usage"; providerId: string; threadId: string; used: number; total: number; percent: number; ts: string }
  | { kind: "provider.error"; providerId: string; threadId?: string; code?: string; message: string; retryable?: boolean; ts: string };
```

Normalization rules:

```text
approval.requested
  → session.status waiting_for_approval
  → session.warning approval_needed
  → AttentionItem approval_needed

approval.resolved
  → warning.cleared approval_needed
  → AttentionItem cleared
  → status returns to last explicit state or active/idle

context.usage >= configured threshold
  → session.status context_high
  → session.warning context_high
  → AttentionItem context_high

file_change.proposed
  → TimelineItem file_change
  → DiffReview provider annotation
  → no conflict cleared, no git truth assumed

file_change.applied
  → TimelineItem file_change
  → wait for watcher/git evidence before showing authoritative changed files

command.completed
  → TimelineItem command
  → may satisfy a verify command gate only if commandId/itemId is bound to a stamped VerifyPackItem

message
  → TimelineItem message
  → may also appear in structured chat
  → never parse message text into status
```

---

## 9. Codex app-server integration guidance

Do not hardcode a guessed Codex app-server protocol.

Implementation steps:

1. Probe whether `codex app-server` is installed and available.
2. Prefer generated or checked-in protocol schema when available.
3. If the installed Codex can generate TypeScript/JSON schema, vendor the generated schema under a versioned path.
4. Implement adapter methods against the vendored schema.
5. Feature-detect methods/capabilities at runtime.
6. Degrade to `GenericPtyProvider` when app-server is unavailable.

Suggested adapter behavior:

```text
CodexAppServerProvider
  - starts or connects to a local app-server instance
  - performs initialization/handshake
  - records server version and capability flags
  - starts/resumes/forks threads when supported
  - starts turns / sends messages when supported
  - streams structured provider events
  - normalizes approvals/context/commands/file changes to RuntimeEvents
  - supports provider-native review only when advertised
```

Transport names and RPC method names must come from the installed provider or generated schema, not from this addendum.

---

## 10. Generic PTY provider

Implement this early because it gives every CLI a baseline runtime:

```text
GenericPtyProvider capabilities:
  rawStdio: true
  stdinWrite: true
  processLifecycle: true
  structured*: false unless paired with MCP contract
```

It supports:

```text
start process
attach to known process when feasible
capture stdout/stderr
write stdin on explicit user action
stop/restart
record exit code
show live/stdout history
```

It must not parse terminal text for semantics.

Provider-specific PTY providers such as Claude/Kimi/Gemini can initially wrap GenericPtyProvider with default command templates and model labels.

---

## 11. SessionTimelineService

Add a Shiori-style timeline as a projection, not as durable truth.

Inputs:

```text
RuntimeEvents
ProviderEvents
MCP job/session/skill events
watcher/git repo events
verify command events
human overrides
```

Output:

```ts
interface TimelineItem {
  id: string;
  sessionId: string;
  jobId?: string;
  taskId?: string;
  projectSlug?: string;
  kind:
    | "message"
    | "reasoning"
    | "command"
    | "file_change"
    | "approval"
    | "checkpoint"
    | "skill"
    | "verify"
    | "repo_change"
    | "warning"
    | "handoff"
    | "status";
  title: string;
  detail?: string;
  ts: string;
  source: "provider" | "mcp" | "http" | "watcher_git" | "derived" | "human" | "raw_stdio" | "system";
  confidence: "structured" | "reported" | "derived" | "manual" | "unknown";
  evidenceRef: string;
  actions?: TimelineAction[];
}
```

UI placement:

```text
Session large card: last 2–3 timeline items
Session detail dock: Summary | Timeline | Stdio | Chat | Diff | Context | Skills | Events
Attention item click: opens the relevant TimelineItem / evidence item
```

Rules:

- Raw stdio may produce raw-output timeline markers only if helpful, labeled `raw_stdio` and `derived`.
- Provider messages may appear as structured chat/timeline, but message text is still not parsed into semantic state.
- Every timeline item must link to its evidence source.

---

## 12. DiffReviewService

Add in-app changed-files/diff review, but keep git/watcher authoritative.

Inputs:

```text
provider file-change proposed/applied events
ProjectWorkspaceWatcher events
git status
git diff
git log since job start
tracker changed-since / history endpoints
allowed_paths from task.repos
```

Model:

```ts
interface DiffReview {
  id: string;
  projectSlug: string;
  taskId?: string;
  jobId?: string;
  sessionId?: string;
  baseTrackerRev?: number;
  baseGitSha?: string;
  headGitSha?: string;
  files: DiffFile[];
  providerItems: ProviderFileChangeRef[];
  watcherEvidence: string[];
  allowedPathWarnings: string[];
  conflictIds: string[];
  status: "open" | "reviewing" | "approved" | "changes_requested" | "merged" | "discarded";
}
```

Diff panel tabs:

```text
Changed since job start
Provider proposals
Git diff
Allowed paths
Conflicts
Reviewer notes
```

Rules:

- Provider file-change items explain intent.
- Git/watcher evidence proves what changed.
- Agent/provider self-reported file paths never clear `file_conflict` or `outside_allowed_paths` warnings.
- Diff review should be available even for dumb-terminal sessions by using git/watcher evidence.

---

## 13. WorktreeService

Multiple sessions across projects become much safer when worktrees are first-class.

Add a service that can:

```text
create a worktree for a task/job
bind a session to a worktree
show branch/worktree on every session card
detect multiple sessions in the same worktree
recommend worktree creation when conflict risk is high
archive/delete worktree after closeout when user confirms
```

Suggested UI actions:

```text
[CREATE WORKTREE]
[BIND WORKTREE]
[OPEN DIFF]
[VIEW CONFLICTS]
[ACKNOWLEDGE SHARED WORKTREE]
```

When `multiple_sessions_same_worktree` fires, show:

```text
Two sessions are active in this worktree. File attribution is ambiguous.
Recommended: create a separate worktree for one job.
```

---

## 14. Run Session funnel integration

All start/adopt paths must converge through one service.

Entry points:

```text
Task card [+ RUN SESSION]
  → task preselected and locked

Swimlane header [+ NEXT IN LANE]
  → highest-fit task preselected

Hub [+ RUN]
  → user chooses from fit-ranked candidates

CLI / attach
  → draft created from supplied args

Drag task onto session / drop zone
  → draft/preflight first, then binding/launch
```

Do not allow drag/drop to bypass preflight.

`RunSessionDraft` should include:

```text
projectSlug
taskId
entryPoint
profileId
providerId
model
sandbox
repoRoot
worktreePath
branch
contextPackPreview
verifyPackPreview
warnings
capabilityPreview
claimMode
expectedTrackerRev
```

Preflight must check:

```text
task already has active job
stale tracker revision
dependencies not satisfied
missing repo metadata
same worktree conflict risk
outside allowed paths risk
provider unavailable
capability mismatch
context injection not supported
verify pack missing/empty
```

The user can still proceed with explicit override where allowed, but overrides must be recorded.

---

## 15. AttentionEngine integration

Attention is the operator routing layer. It is a projection over runtime/tracker/watcher/provider state.

Attention kinds should include at least:

```ts
type AttentionKind =
  | "approval_needed"
  | "blocked"
  | "conflict"
  | "outside_allowed_paths"
  | "sandbox_escape_requested"
  | "not_responding"
  | "quiet"
  | "context_high"
  | "done_needs_closeout"
  | "done_claimed_verify_missing"
  | "verify_missing"
  | "unbound_session"
  | "provider_error";
```

Priority order:

```text
critical:
  approval_needed
  sandbox_escape_requested
  outside_allowed_paths
  conflict

high:
  blocked
  not_responding / missing_heartbeat
  context_high when rollover pack is ready

medium:
  done_claimed_verify_missing
  done_needs_closeout
  verify_missing
  provider_error if retryable=false

low:
  quiet_terminal
  unbound_session
  idle too long
```

Every `AttentionItem` must have:

```text
source/evidence
recommended actions
clear condition
ack/snooze lifecycle
```

Example:

```ts
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
  source:
    | "structured"
    | "reported"
    | "derived"
    | "manual"
    | "watcher_git"
    | "provider"
    | "unknown";
  evidenceRef?: string;
  createdAt: string;
  updatedAt: string;
  dedupeKey: string;
  clearCondition: string;
  recommendedActions: AttentionAction[];
  acknowledgedAt?: string;
  snoozedUntil?: string;
  clearedAt?: string;
}
```

---

## 16. API additions

Use existing routing conventions, but add these surfaces if absent.

### 16.1 Provider APIs

```http
GET  /api/providers
GET  /api/providers/:providerId/capabilities
GET  /api/providers/:providerId/models
GET  /api/providers/:providerId/skills?cwd=
POST /api/providers/:providerId/probe
```

### 16.2 Run Session APIs

```http
GET  /api/projects/:slug/run-candidates?lane=&limit=
POST /api/run-session/draft
PATCH /api/run-session/draft/:draftId
POST /api/run-session/draft/:draftId/refresh-context
POST /api/run-session/draft/:draftId/launch
POST /api/run-session/draft/:draftId/copy-prompt
```

### 16.3 Attention APIs

```http
GET  /api/attention
POST /api/attention/:attentionId/ack
POST /api/attention/:attentionId/snooze
POST /api/attention/:attentionId/clear
```

`ack`, `snooze`, and `clear` append runtime events. They do not patch tracker task truth.

### 16.4 Timeline / diff / provider-action APIs

```http
GET  /api/sessions/:sessionId/timeline
GET  /api/sessions/:sessionId/diff
POST /api/sessions/:sessionId/provider/approve
POST /api/sessions/:sessionId/provider/deny
POST /api/sessions/:sessionId/provider/interrupt
POST /api/sessions/:sessionId/provider/steer
POST /api/sessions/:sessionId/provider/fork
POST /api/sessions/:sessionId/provider/review
```

Each mutating endpoint must validate existing hub auth plus the session-scoped token rules from the TDD where applicable.

---

## 17. UI integration requirements

### 17.1 Navigation surfaces

Implement or preserve these four projections over the same runtime state:

```text
Hub
  all sessions across all projects, grouped by project/status/agent/custom grouping

Project board strip
  this project's sessions above swimlanes; task cards show inline session badges

Triage
  attention-first view grouped by urgency/severity/kind

Attention strip
  persistent global banner showing only active high-signal attention items
```

Add Triage to nav if not already present, or make the Attention strip open Triage.

### 17.2 Run Session / Launch Brief screen

This screen should be the unified launch funnel, not a generic prompt editor.

It should show:

```text
selected task / candidate list
profile
provider/runtime
model
sandbox
repo/worktree
context pack preview
verify pack preview
dependency/DoD evidence
capability preview
conflict scan
CLI equivalent
launch / copy prompt / save brief
```

When launched from a task card, task selection is preselected and locked unless the user explicitly changes entry mode.

### 17.3 Capability preview

Show provider capabilities before launch.

Example:

```text
Runtime: Codex app-server
✓ structured chat
✓ structured approvals
✓ provider timeline
✓ provider file changes
✓ context usage
✓ thread resume/fork
✓ provider review
✓ direct context injection
```

Example:

```text
Runtime: Generic terminal
✓ raw stdio
✓ stdin
✓ stop/restart
○ structured approvals unavailable
○ context usage unavailable unless reported via MCP
○ provider file changes unavailable; git diff still available
```

### 17.4 Session card actions

A normal card should support capability-based action rendering:

```text
[OPEN] [CHAT] [TIMELINE] [STDIO] [DIFF] [CTX] [REVIEW] [STOP] [ROLLOVER]
```

Disabled action example:

```text
[CHAT disabled] reason: provider has no structured chat
```

### 17.5 Evidence drill-down

Every attention badge and critical status chip must open an evidence panel:

```text
source
confidence
event id / tracker rev / provider event id / conflict id
timestamp
why it exists
recommended action
clear condition
```

---

## 18. Implementation order

This sequence is optimized for solving the operator problem, not for public MVP minimalism.

### Step 0 — Repo inventory

Before coding, inspect the repository and write a short implementation note in the first PR/commit message:

```text
existing server framework
existing UI framework
existing store/revision implementation
existing CLI/MCP structure
current type/schema style
current test runner
current routing patterns
current WebSocket patterns
```

Do not introduce a new framework or database.

### Step 1 — Contracts and schema guards

Add/confirm:

```text
schemaVersion on RuntimeEvent, snapshots, context packs, verify packs
idempotencyKey support for mutating MCP/HTTP/provider events where retries can duplicate events
session.warning and warning.cleared events
repo.burst event
provider thread ref runtime fields
provider capability model
AttentionItem lifecycle events
```

If v0.4 already has any of these, reuse the existing implementation and fill gaps only.

### Step 2 — ProviderBroker + GenericPtyProvider

Deliver:

```text
provider registry
provider probe endpoint
capability endpoint
GenericPtyProvider start/stop/stdio
providerThreadRef stored in runtime projection
capability-based UI action enable/disable
```

Acceptance:

```text
can start a terminal-backed session through ProviderBroker
session card labels provider/tier/capabilities
no semantic status is inferred from raw output
```

### Step 3 — RunSessionService + launch preflight

Deliver:

```text
RunSessionDraft
run candidates
preflight warnings
task claim semantics
Launch Brief screen wired to draft/launch APIs
capability preview
context/verify pack preview
```

Acceptance:

```text
Task card [+ RUN SESSION] opens locked task launch brief
Swimlane [+ NEXT IN LANE] picks a fit-ranked candidate
Hub [+ RUN] opens candidate picker
Drag/drop goes through draft/preflight
```

### Step 4 — AttentionEngine and Triage

Deliver:

```text
AttentionEngine projection
Attention strip
Triage page
ack/snooze/clear events
recommended actions
source/evidence drill-down
```

Acceptance:

```text
structured approval appears as approval_needed
missing heartbeat appears as not_responding
quiet terminal appears as quiet and says check terminal
context_high only appears from structured context usage
conflict/outside_allowed_paths comes from watcher/git
```

### Step 5 — SessionTimelineService

Deliver:

```text
session timeline endpoint
provider/runtime/MCP/watcher timeline projection
timeline tab in session detail
last timeline items on large card
attention item opens relevant timeline/evidence
```

Acceptance:

```text
commands/messages/approvals/checkpoints/skills/repo changes appear in time order
source/confidence labels display
raw stdio remains raw/derived only
```

### Step 6 — DiffReviewService

Deliver:

```text
changed since job start
git diff panel
provider file-change annotations if available
allowed-path warnings
conflict display
spawn reviewer / run verify / closeout actions
```

Acceptance:

```text
diff works for dumb terminal sessions via git/watcher
provider file-change item does not clear conflicts
allowed paths use task.repos.allowed_paths
```

### Step 7 — CodexAppServerProvider

Deliver:

```text
probe installed Codex app-server
load/generated schema if available
structured thread start/resume/fork where available
structured messages/events
structured approvals
structured context usage
provider-native review when available
fallback to GenericPtyProvider
```

Acceptance:

```text
provider capability flags reflect actual server capability
approval events create attention items
context usage creates context_high only when supported
adapter survives disconnect/reconnect without corrupting RuntimeStore
```

### Step 8 — WorktreeService

Deliver:

```text
create/bind worktree
show worktree/branch on cards
detect same-worktree ambiguity
recommend worktree creation
archive worktree after closeout with confirmation
```

Acceptance:

```text
multiple sessions in same worktree produce clear warning
creating a worktree updates session/job runtime metadata
conflict risk decreases when worktrees are unique
```

---

## 19. Test checklist

Add or update tests for these behaviors.

### 19.1 ProviderBroker

```text
provider probe returns capability flags
unavailable provider degrades cleanly
start session records providerThreadRef
provider event retries are idempotent where idempotencyKey is present
provider errors create warning/attention but do not patch tracker truth
```

### 19.2 GenericPtyProvider

```text
captures stdout/stderr
writes stdin only on explicit action
stop/restart works
raw terminal text containing “approve”, “blocked”, “done”, or “verify passed” creates no semantic status
quiet timeout creates quiet_terminal only
```

### 19.3 AttentionEngine

```text
approval_requested provider event → approval_needed
approval_resolved → warning/attention cleared
MCP blocked → blocked
missing heartbeat → not_responding
raw stdio silence → quiet_terminal
context usage >= threshold → context_high
context usage unavailable → never context_high
outside allowed paths → outside_allowed_paths from watcher/git
```

### 19.4 Run Session funnel

```text
task card launch locks selected task
hub launch allows candidate selection
swimlane launch chooses highest-fit candidate
stale tracker rev blocks or requires override
active job conflict blocks or requires explicit force/join mode
drag/drop opens or creates draft/preflight
```

### 19.5 Timeline

```text
provider events and runtime events merge in time order
each item has evidenceRef
raw stdio timeline markers are labeled raw_stdio/derived
clicking an attention item opens relevant evidence/timeline item
```

### 19.6 Diff review

```text
git diff collected since job start
provider file-change proposals annotate diff
provider file reports do not clear conflict warnings
allowed-path violations surface
reviewer job can be spawned with changed-since context
```

### 19.7 Codex app-server

```text
capabilities reflect handshake/schema
structured approval creates approval attention
context usage creates context_high only when supported
disconnect adds warning, reconnect reconciles threads if supported
fallback path uses GenericPtyProvider
```

---

## 20. Feature flags / config

Add config flags so the operator can enable richer behavior without destabilizing the core.

```yaml
sessionHub:
  enabled: true
  attentionStrip: true
  triage: true
  runSessionFunnel: true

providers:
  generic_pty:
    enabled: true

  codex_app_server:
    enabled: true
    preferGeneratedSchema: true
    transportPreference: ["stdio", "unix", "websocket"]
    fallbackProvider: "generic_pty"

trustedLocalMode:
  allowAutoContextInjection: true
  allowProviderReviewFromUI: true
  allowWorktreeCreationFromUI: true
  allowVerifyCommandRunFromUI: false
  requireConfirmationForCrossProjectLaunch: true
  neverAutoApproveTerminalPrompts: true

stdio:
  liveTail: true
  captureToDisk: false
  maxBytes: 5242880
  rotatedSegments: 3
```

For a personal operator tool, powerful UI actions are acceptable behind explicit local configuration. Keep `neverAutoApproveTerminalPrompts: true`.

---

## 21. Acceptance criteria for this addendum

This addendum is implemented when:

```text
1. ProviderBroker exists and at least GenericPtyProvider works.
2. Provider capabilities drive UI actions.
3. Run Session funnel starts task-backed jobs from task card, swimlane, Hub, CLI, and attach paths.
4. Attention strip and Triage route operator focus from structured/runtime/watcher evidence.
5. Session timeline merges provider/runtime/MCP/watcher events with source labels.
6. Diff review shows git/watcher changes and provider file-change annotations where available.
7. Codex app-server support is capability-detected and schema/protocol-verified, not hardcoded from assumptions.
8. Raw stdio never creates semantic state.
9. Provider thread/runtime data stays in `.runtime`; tracker JSON remains durable task truth.
10. Existing CLI/MCP/project flows keep working.
```

---

## 22. Anti-patterns to avoid

Do not:

```text
- build a separate Shiori clone beside llm-tracker;
- make provider threads the top-level product object;
- parse terminal output to infer approvals/progress;
- write provider runtime IDs into durable task JSON by default;
- clear watcher/git conflicts from provider self-reports;
- block dumb terminal users from task/job/rollover/verify flows;
- hide disabled actions with no explanation;
- introduce a database or cloud dependency;
- rewrite existing tracker Store or MCP architecture unnecessarily;
- implement Codex app-server against guessed method names without probing/schema validation.
```

---

## 23. Quick execution prompt for the coding agent

Use this paragraph as the implementation instruction if you need a compact launch prompt:

```text
Implement the Session Hub provider-runtime addendum. Preserve llm-tracker’s durable tracker truth and RuntimeStore event model. Add ProviderBroker, provider capabilities, GenericPtyProvider, RunSessionDraft/RunSessionService integration, AttentionEngine/Triage/Attention strip wiring, SessionTimelineService, DiffReviewService, and capability-based UI actions. Add CodexAppServerProvider only by probing/generating/using the installed protocol schema and degrade to GenericPtyProvider if unavailable. Never infer semantic state from raw stdio. Provider events may create structured runtime evidence; watcher/git remains authoritative for local file changes. Keep all runtime/provider thread state in `.runtime`. Add tests for raw-stdio non-inference, provider event normalization, attention lifecycle, run-session preflight, timeline evidence refs, and diff review conflict behavior.
```

---

## 24. Reference links for the executing agent

- ShioriCode repository / README: https://github.com/shiorihq/ShioriCode
- OpenAI Codex app-server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

Treat external docs as mutable. Verify current behavior from the installed package or checked-in generated schema before implementing provider-specific adapters.
