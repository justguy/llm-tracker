# Program Manager MCP Integration Review

Date: 2026-05-19

## Recommendation

Integrate Program Manager MCP capabilities with `llm-tracker`, but do not merge the two data models or make PMO a second writer for task state.

The right target is a combined agent-facing experience:

- `tracker_*` tools remain the authority for task execution, task status, assignee state, board structure, history, and tracker file writes.
- PMO tools remain the authority for program/project identity, integration lifecycle, cross-project coordination items, evidence pointers, receipt obligations, and reconciliation.
- A bridge maps tracker projects/tasks into PMO pointer refs and lets agents move from task execution to program evidence without re-entering context manually.

This gives agents one coherent workflow while preserving each system's strongest boundary.

## Decision Summary

Do:

- Add a live read-only Tracker adapter for PMO.
- Add optional PMO tool exposure from `llm-tracker mcp`, preferably behind an explicit opt-in.
- Namespace PMO tools when exposed from the tracker MCP so agents do not see generic `manage_*` names without context.
- Add a receipt/evidence bridge after tracker execution, but make PMO writes explicit or outbox-backed.
- Keep Program Manager's pointer-only evidence policy.

Do not:

- Store tracker task truth in PMO as authoritative task state.
- Let PMO call tracker mutation tools directly.
- Let tracker file patches mutate PMO synchronously without an idempotent receipt/outbox plan.
- Collapse `dependencies[]` and PMO integration/dependency edges into one field.
- Ship a combined MCP before PMO profile enforcement and the static tracker adapter gap are handled.

## Current Systems

### LLM Tracker

Repo: `llm-project-tracker`

Primary purpose:

- Local/file-backed task tracker for LLM agents and humans.
- Hub-authoritative task merge, validation, history, and UI.
- MCP tools/resources/prompts focused on bounded agent execution.

Current MCP entry points:

- Server: `bin/mcp-server.js`
- Tool factory: `bin/mcp-tools.js`
- Read tools: `bin/mcp-read-tools.js`
- Write tools: `bin/mcp-write-tools.js`
- Resources: `bin/mcp-resources.js`
- Prompts: `bin/mcp-prompts.js`

Current MCP capabilities:

- Read workspace contract: `tracker_help`
- Project status: `tracker_projects_status`, `tracker_project_status`
- Task selection/context: `tracker_next`, `tracker_search`, `tracker_fuzzy_search`, `tracker_brief`, `tracker_why`
- Execution loop: `tracker_execute`, `tracker_verify`, `tracker_handoff`
- Board intelligence: `tracker_blockers`, `tracker_hygiene`, `tracker_changed`, `tracker_history`, `tracker_decisions`
- Writes: `tracker_patch`, swimlane create/update/move/delete, `tracker_start`, `tracker_pick`, `tracker_undo`, `tracker_redo`, `tracker_reload`

Runtime shape:

- Uses `@modelcontextprotocol/sdk`.
- Exposes tools, resources, and prompts.
- Reads/writes tracker workspace files under `trackers/<slug>.json`.
- Can write through the running hub or direct file-backed `Store.applyPatch`.

### Program Manager MCP

Repo: `../ProgramManagerMCP`

Primary purpose:

- Stateful PMO memory, guidance, dependency intelligence, and receipt ledger.
- Shared program knowledge across projects and agents.
- Passive analyst/planner/reconciler, not a downstream executor.

Public MCP surface:

- `pmo_help`
- `manage_projects`
- `manage_integrations`
- `manage_evidence_items`
- `pmo_macro`

Important legacy tools remain callable inside its gateway, but are not listed as the public surface.

Current PMO capabilities:

- Program/project memory and metadata pointers.
- Integration lifecycle, producer/consumer participation, blockers, gaps, decisions, learnings, tracker refs, and inbox.
- Pointer-only evidence and artifact registry.
- Macros for catch-up, impact simulation, unblock planning, drift detection, and reconciliation-oriented workflows.
- Receipt ledger concepts: expected receipts, observed receipts, action ledger entries, reconciliation findings.
- Adapter registry with read-only adapters and side-effect posture enforcement.

Runtime shape:

- Package: `cp-program-manager`
- Private TypeScript package.
- Primary store: Neo4j shared PMO knowledge graph.
- Local in-memory repository is test/fixture only.
- Current server is a custom stdio JSON-RPC implementation rather than the MCP SDK.
- The server can degrade so `pmo_help` remains callable when shared PMO storage is missing.

Important current gap:

- The documented `PMO_MCP_VIEW_PROFILE` behavior is not server-enforced yet.
- The README shows a `summary_agent` actor role, but the server's allowed actor roles do not include `summary_agent`.
- The current `TrackerAdapterStub` is static fixture data, not a live adapter over `llm-tracker`.

## Data Model Comparison

### LLM Tracker Data Model

Tracker project files are local JSON documents. The core persisted shape is:

- `meta`
  - `name`
  - `slug`
  - `swimlanes[]`
  - `priorities[]`
  - `scratchpad`
  - `rev`
  - `updatedAt`
  - `deleted_tasks`
- `tasks[]`
  - `id`
  - `title`
  - `kind`: `task` or `group`
  - `parent_id`
  - `goal`
  - `status`: currently task lifecycle values such as `not_started`, `in_progress`, `blocked`, `complete`, `deferred`
  - `placement`: `swimlaneId`, `priorityId`
  - `dependencies[]`
  - `assignee`
  - `reference` / `references[]`
  - `effort`
  - `related[]`
  - `comment`
  - `blocker_reason`
  - `definition_of_done[]`
  - `constraints[]`
  - `expected_changes[]`
  - `allowed_paths[]`
  - `approval_required_for[]`
  - `repos`
  - `context`
  - `updatedAt`
  - `rev`

Derived tracker fields are not persisted as schema truth:

- `actionability`
- `actionable`
- `ready`
- `blocked_by`
- `blocking_on`
- `blocked_kind`
- `decision_required`
- `decision_reason`
- `not_actionable_reason`
- `requires_approval`
- `external_dependencies`
- `traceability`
- `lastTouchedRev`

Tracker dependency semantics:

- `dependencies[]` is blocker graph state.
- Local dependencies point to task ids.
- Cross-project dependencies use `<otherSlug>:<taskId>`.
- Group containment uses `kind: "group"` plus `parent_id`, not `dependencies[]`.

Tracker reference semantics:

- `reference` and `references[]` must use repo-relative `path:line` or `path:line-line`.
- Bare URLs are invalid in tracker references.
- `context` is intentionally flexible and is used for traceability keys, tags, notes, and task-specific metadata.

### Program Manager Data Model

PMO data is graph/ledger-oriented and pointer-ref based.

Core identity records:

- `Portfolio`
- `Program`
- `Project`
- `IntegrationPointRecord`

Program/project records include:

- `portfolioId`
- `programId`
- `projectId`
- `name`
- `goal`
- `projectRole`
- `repoRef`
- `trackerRef`
- `adapterRef`
- status fields

Integration records include:

- `integrationPointId`
- `portfolioId`
- `producerProjectId`
- `consumerProjectIds[]`
- `purpose`
- `artifactRefs[]`
- `evidenceRefs[]`
- `projectRoles`
- `coordinationItems[]`
- `statusHistory[]`
- `idempotencyKeys[]`

Integration coordination items include:

- `itemId`
- `itemType`: `artifact`, `blocker`, `conflict`, `decision`, `gap`, `goal`, `learning`, `response`, `tracker_ref`
- `integrationPointId`
- `affectedProjectIds[]`
- `blockedProjectId`
- `blockedOnRefs[]`
- `clearanceCriteria[]`
- `ownerProjectId`
- `reporterProjectId`
- `projectId`
- `status`
- `summary`
- `trackerRefs[]`
- `evidenceRefs[]`
- `artifactRefs[]`

Evidence and artifact records include:

- `evidenceRef`
- `artifactRef`
- `kind` / `evidenceType`
- `storageUri`
- `contentHash`
- `classification`
- `redactionStatus`
- `retentionPolicyRef`
- `attachesToRefs[]`

Ledger and reconciliation records include:

- `ExpectedReceipt`
- `ObservedReceipt`
- `ActionLedgerEntry`
- `ReceiptReconcileRecord`
- `ProgramEvent`
- deterministic hashes and idempotency keys

PMO ref semantics:

- Most PMO identity values are URI-like refs such as:
  - `portfolio://default`
  - `program://agentic-os`
  - `project://hoplon`
  - `integration://agentic-os/shared-flow`
  - `tracker://program-manager-mcp/PMO-001`
  - `evidence://...`
  - `artifact://...`
- PMO is pointer-only. It should not store raw logs, screenshots, transcripts, product rows, credentials, secrets, or unbounded diffs.

## Source Of Truth Matrix

| Concern | Authority | Notes |
| --- | --- | --- |
| Task lifecycle status | LLM Tracker | PMO may observe or reference status, but should not own it. |
| Task assignee/claim | LLM Tracker | `tracker_start` and `tracker_pick` own this. |
| Board lanes/priorities | LLM Tracker | PMO should not model tracker swimlanes as PMO state except as observed metadata. |
| Task blocker graph | LLM Tracker | `dependencies[]` is execution blocking. |
| Cross-project program dependency | PMO | PMO should model integration/contract dependency and evidence obligations. |
| Program/project identity | PMO | Tracker slug can be linked by `trackerRef`, but it is not the PMO project id. |
| Integration participation | PMO | Producer/consumer roles belong in `manage_integrations`. |
| Project-local task context | LLM Tracker | `brief`, `why`, `execute`, `verify`, `handoff` are tracker-native. |
| Program-level decision | PMO | Tracker comments can feed decisions, but PMO owns durable cross-project decisions. |
| Execution receipt requirement | PMO | PMO can expect/reconcile receipts without executing downstream work. |
| Test or artifact evidence pointer | PMO | Store pointer, digest, classification, retention; not raw content. |
| Repo/code state | Owning repo | Both systems should reference commits/files; neither replaces git. |

## Interaction Model

### Current Tracker-Only Agent Flow

1. Read `tracker_help` or `tracker://help`.
2. Call `tracker_projects_status` or `tracker_project_status`.
3. Call `tracker_next`.
4. Call `tracker_brief`, `tracker_why`, or `tracker_execute`.
5. Start/claim with `tracker_start` or `tracker_pick`.
6. Execute through repo-native tools.
7. Update tracker with `tracker_patch`.
8. Verify with `tracker_verify`.
9. Handoff with `tracker_handoff` when needed.

### Current PMO-Only Agent Flow

1. Call `pmo_help`.
2. Use `manage_projects` to list/upsert PMO program/project records.
3. Use `manage_integrations` to get/upsert integration records and participation.
4. Use `pmo_macro` for catch-up, impact simulation, unblock planning, drift detection, or reconciliation.
5. Use project-native tools for actual execution.
6. Use `manage_evidence_items` and receipt/reconciliation paths for pointer-only proof.

### Recommended Combined Flow

For normal task execution:

1. Agent calls `tracker_help`.
2. If PMO is enabled, agent also calls `pmo_help` or a combined `tracker_pmo_context` helper.
3. Agent calls `tracker_next` and `tracker_execute`.
4. If the task touches cross-project integration, contract behavior, shared evidence, or a PMO-linked tracker ref, agent calls `pmo_macro` catch-up or impact simulation.
5. Agent claims the task through `tracker_start` or `tracker_pick`.
6. Agent executes with repo-native tools.
7. Agent writes task state through `tracker_patch`.
8. Agent verifies through `tracker_verify`.
9. If PMO expected a receipt, agent registers pointer-only evidence and submits/reconciles a PMO receipt.
10. Agent runs PMO drift detection when integration evidence may have changed.

The combined flow should be explicit. Tracker writes should not silently become PMO writes unless an idempotent outbox is present.

## Integration Options

### Option A: Keep MCPs Separate, Improve Instructions

Description:

- Keep `llm-tracker mcp` and Program Manager MCP registered separately.
- Update docs/prompts/skills to tell agents when to call each.

Pros:

- Lowest implementation cost.
- Preserves current boundaries.
- No packaging or runtime coupling.

Cons:

- Agents still see two MCPs.
- Human context remains split.
- No automatic mapping from tracker task refs to PMO evidence/receipts.

Assessment:

- Good immediate operating model.
- Not enough if the goal is one coherent capability surface.

### Option B: Live PMO Adapter Over Tracker, Still Separate MCPs

Description:

- Implement a real Program Manager `TrackerAdapter` that reads `llm-tracker` workspace state.
- PMO can observe tracker projects/tasks, status, dependencies, decisions, history, and refs.
- MCPs remain separately registered initially.

Pros:

- Solves the current static adapter gap.
- Keeps PMO read-only toward tracker.
- Gives PMO real tracker freshness and receipt context.
- Low risk relative to co-hosting.

Cons:

- Still requires two MCP registrations.
- Agents still need workflow guidance.

Assessment:

- Best first engineering slice.
- Required before any deeper integration is meaningful.

### Option C: Co-Host PMO Tools In `llm-tracker mcp`

Description:

- Add optional PMO tools to the tracker MCP server.
- Keep `tracker_*` and PMO surfaces separate but available from one server.
- Use namespaced aliases such as `pmo_manage_projects`, `pmo_manage_integrations`, and `pmo_manage_evidence_items` instead of bare `manage_*` names in the combined server.

Pros:

- One MCP registration can cover task execution plus PMO context.
- Agent workflow becomes simpler.
- Tracker can offer a joined context helper.

Cons:

- Adds Neo4j/env/runtime concerns to tracker MCP startup.
- Program Manager currently uses a custom stdio server and `.ts` runtime import strategy.
- PMO profiles are documented but not enforced.
- Needs careful namespacing and authz behavior.

Assessment:

- Good target after Option B and PMO profile enforcement.
- Should be optional and fail-soft so tracker still works without PMO.

### Option D: Merge State Models

Description:

- Put PMO program/integration/evidence fields directly into tracker schema or make PMO own task state.

Pros:

- Superficially simpler model.

Cons:

- Creates two authorities for task state or bloats tracker files with graph/ledger concepts.
- Breaks PMO's passive analyst boundary.
- Makes local tracker workflows depend on PMO graph/Neo4j semantics.
- Increases merge conflict and migration risk.

Assessment:

- Not recommended.

## Recommended Architecture

Use a bridge architecture:

1. Keep tracker as the execution database.
2. Keep PMO as the program coordination graph and ledger.
3. Add a read-only tracker adapter in PMO.
4. Add an optional PMO client layer in `llm-tracker mcp`.
5. Add explicit receipt/evidence bridge calls.

### Tool Naming In A Combined MCP

Current Program Manager tool names include generic names:

- `manage_projects`
- `manage_integrations`
- `manage_evidence_items`

If these are exposed from inside `llm-tracker mcp`, use namespaced aliases:

- `pmo_help`
- `pmo_manage_projects`
- `pmo_manage_integrations`
- `pmo_manage_evidence_items`
- `pmo_macro`

Reason:

- MCP tool names become one global list inside a co-hosted server.
- Generic `manage_*` names are clear inside the Program Manager MCP but less clear beside tracker tools.
- Namespacing preserves agent intent and reduces accidental misuse.

Compatibility option:

- Keep bare `manage_*` only when the Program Manager MCP runs as its own server.
- In the co-hosted tracker MCP, expose only the namespaced aliases unless there is a strong compatibility need.

### Suggested New Tracker MCP Helpers

Add a small bridge surface rather than forcing agents to assemble all calls manually:

- `tracker_pmo_context`
  - Input: `slug`, optional `taskId`, optional `integrationRef`
  - Output: tracker project/task status plus PMO project/integration/evidence summary.
  - Read-only.

- `tracker_pmo_register_evidence`
  - Input: `slug`, `taskId`, `evidenceRef`, `artifactRef`, `contentHash`, `summary`, optional `attachesToRefs`
  - Writes PMO only.
  - Should not alter tracker task state.

- `tracker_pmo_reconcile`
  - Input: `slug`, optional `taskId`, optional `targetRefs`
  - Runs PMO drift/reconciliation for the relevant refs.
  - Read or PMO-ledger write depending on macro/action used.

These helpers are optional. The first integration can expose the raw PMO tools only.

### Ref Mapping

Use deterministic refs:

| Tracker object | PMO pointer ref |
| --- | --- |
| Project slug `my-project` | `project://my-project` or configured PMO project id |
| Tracker project | `tracker://my-project` |
| Tracker task `task-123` | `tracker://my-project/task-123` |
| Tracker revision | `artifact://llm-tracker/my-project/rev/<rev>` or source cursor |
| History event | `artifact://llm-tracker/my-project/history/<rev>` |
| Repo file reference | Keep tracker `path:line`; PMO evidence can point to `artifact://...` or repo refs |

Important:

- Do not assume tracker slug always equals PMO project id. Store explicit mappings through PMO `trackerRef` and project metadata.
- PMO already has normalization guidance for slug-shaped inputs, but the bridge should generate canonical refs directly.

### Read-Only Tracker Adapter Responsibilities

The live PMO adapter should read from tracker APIs/modules and produce PMO observations:

- projects from `listProjectEntries`
- project summaries from `projectStatusPayload`
- task summaries from `summarizeTask`
- task context from `brief` / `execute` payload builders
- blockers from `getBlockersPayload`
- decisions from `getDecisionsPayload`
- recent changes from `getChangedPayload` or history
- source cursor from tracker `meta.rev` plus file path/hash

Adapter output should include:

- `adapterId`: probably `llm-tracker-local`
- source cursor: tracker workspace + project rev or digest
- observations: `tracker_project`, `tracker_task`, `task_dependency`, `decision_note`, `blocker`, `evidence_pointer`
- evidence refs: `tracker://...` refs and optional artifact refs
- redaction summary: no raw task comments beyond bounded summaries

Adapter must not:

- call `tracker_patch`
- call `tracker_start`
- call `tracker_pick`
- write tracker files
- infer PMO integration closure from tracker prose alone

## Phased Implementation Plan

### Phase 0: Decision And Contract

Deliverables:

- This document.
- A short implementation task list in the tracker if the decision is to proceed.
- Explicit naming decision for co-hosted PMO tools.

Exit criteria:

- Agreement that tracker remains task authority.
- Agreement that PMO remains program/evidence/receipt authority.
- Agreement that PMO writes are explicit and pointer-only.

### Phase 1: Live Read-Only Tracker Adapter In Program Manager

Deliverables:

- Replace or supplement `TrackerAdapterStub` with a live adapter.
- Adapter config accepts tracker workspace path and project mappings.
- Adapter emits deterministic `tracker://` refs.
- Tests with fixture tracker projects.

Suggested implementation paths:

- In `ProgramManagerMCP`:
  - `control-plane/packages/program-manager/src/adapters/`
  - `control-plane/packages/program-manager/tests/adapter-stubs.test.js`
  - `control-plane/packages/program-manager/tests/program-tools.test.js`
- In `llm-project-tracker`:
  - export or stabilize read helper APIs if needed.

Exit criteria:

- PMO catch-up and drift macros can observe real tracker task refs.
- Adapter is read-only and circuit-protected.
- No Program Manager code writes tracker files.

### Phase 2: Optional PMO Tools In `llm-tracker mcp`

Deliverables:

- `llm-tracker mcp` can expose PMO tools when enabled by env/config.
- Tracker starts normally when PMO is not configured.
- PMO unavailable state returns useful guidance, not tracker startup failure.
- Co-hosted tool names are namespaced.

Possible implementation strategies:

- Subprocess bridge first:
  - Start or connect to Program Manager MCP as a child stdio process.
  - Proxy calls with namespaced aliases.
  - Least invasive and preserves Program Manager runtime.

- In-process service later:
  - Extract Program Manager service/gateway as a normal importable package.
  - Avoid custom runtime `.ts` stripping in the combined path.
  - Better performance and testability after packaging cleanup.

Exit criteria:

- `tools/list` includes tracker tools plus PMO tools only when enabled.
- `tracker_help` or resource docs explain the combined flow.
- PMO storage failure does not break tracker-only usage.

### Phase 3: Evidence And Receipt Bridge

Deliverables:

- Optional bridge after `tracker_patch` or `tracker_verify`.
- Idempotent PMO evidence/receipt submission.
- Outbox or retry behavior for PMO write failure.

Recommended write policy:

- Default: no implicit PMO write.
- Agent can call an explicit PMO bridge tool after verification.
- If automatic bridge is later desired, use an outbox:
  - write tracker state first
  - enqueue PMO receipt intent with idempotency key
  - retry until PMO accepts or marks blocked

Exit criteria:

- Tracker task closure can be linked to PMO evidence without duplicating raw logs.
- PMO receipt failures do not corrupt tracker state.
- Duplicate submissions are harmless.

### Phase 4: UI And Operator Experience

Deliverables:

- Optional PMO panel in the tracker UI:
  - linked PMO project
  - integrations
  - open PMO blockers/gaps
  - expected receipts
  - drift findings
  - evidence status
- Links from task cards to PMO refs when available.

Exit criteria:

- Human can see task execution state and program coordination state in one UI.
- UI does not imply PMO owns tracker task status.

### Phase 5: Packaging Consolidation If Still Needed

Deliverables:

- Decide whether Program Manager should remain separate package/server or become a dependency/plugin.
- Normalize MCP server implementation if co-hosting becomes permanent.
- Confirm open-source/private package constraints.

Exit criteria:

- Combined install/registration story is clean.
- Runtime dependencies are documented.
- PMO shared-store credentials remain host-owned and out of prompts.

## Risks And Mitigations

### Risk: Two Writers For Task Truth

Problem:

- If PMO starts updating tracker tasks, agents will see conflicting state transitions and unclear audit boundaries.

Mitigation:

- PMO adapters must stay read-only toward tracker.
- Only `tracker_*` tools mutate tracker files.
- PMO stores `trackerRefs[]`, evidence pointers, and receipts, not authoritative task fields.

### Risk: Tool Surface Confusion

Problem:

- In a combined MCP, bare `manage_projects` and `manage_integrations` are ambiguous beside tracker project tools.

Mitigation:

- Use `pmo_manage_*` aliases in the combined server.
- Keep `tracker_*` for tracker operations.
- Update `tracker_help`, MCP resources, prompts, and skills.

### Risk: PMO Runtime Coupling Breaks Tracker Startup

Problem:

- Tracker is local-first. Program Manager expects Neo4j for real state.

Mitigation:

- Make PMO integration opt-in.
- Use fail-soft degraded behavior.
- Keep tracker-only startup independent of PMO configuration.

### Risk: PMO Profiles Are Documented But Not Enforced

Problem:

- Current PMO docs describe summary/operator/executor/auditor profiles, but server-side handling is not implemented yet.

Mitigation:

- Implement and test profile enforcement before broad co-hosted exposure.
- Until then, expose only a conservative PMO profile through tracker or require Program Manager's own authz.

### Risk: Static Tracker Adapter Gives False Confidence

Problem:

- Current `TrackerAdapterStub` contains hard-coded fixture observations.

Mitigation:

- Do not treat current PMO tracker observations as live tracker truth.
- Build the live read-only adapter before any integration decision depends on PMO seeing tracker state.

### Risk: Transaction Boundary Across File Store And Neo4j

Problem:

- Tracker writes are file/hub mutations. PMO writes are Neo4j graph/ledger mutations. There is no shared transaction.

Mitigation:

- Prefer explicit post-write PMO calls.
- Use idempotency keys.
- If automation is needed, use an outbox/retry pattern.

### Risk: Evidence Payload Creep

Problem:

- Agents may try to paste logs, screenshots, or long transcripts into PMO evidence.

Mitigation:

- Keep PMO pointer-only schema.
- Store artifact refs, hashes, and summaries only.
- Let tracker references and repo files carry local implementation context.

## Decision Checklist

Proceed with Phase 1 if all are true:

- You want PMO to reason over real tracker task state.
- PMO should remain passive/read-only toward tracker.
- Shared PMO storage is available or degraded mode is acceptable.
- Tracker refs can be canonicalized as `tracker://<slug>/<taskId>`.

Proceed with Phase 2 if all are true:

- The live tracker adapter exists.
- PMO profile enforcement is implemented or the exposed co-hosted profile is intentionally limited.
- Tracker MCP startup remains healthy without PMO configuration.
- Tool names are namespaced in the combined server.

Proceed with Phase 3 if all are true:

- Receipt/evidence semantics are agreed.
- Idempotency keys are deterministic.
- PMO write failure handling is explicit.
- Tracker task closure does not depend on PMO being available unless the task's DoD says so.

Do not proceed with state-model merge unless:

- The goal changes from local tracker execution to a graph-first PMO tracker replacement.
- You accept a major migration and source-of-truth change.

## Suggested Immediate Next Tasks

1. Add tracker tasks for a Phase 1 live PMO Tracker adapter.
2. Fix Program Manager profile enforcement or narrow the PMO tool exposure plan.
3. Prototype a read-only bridge that maps one tracker project into PMO refs.
4. Add one end-to-end smoke:
   - create/open tracker task
   - PMO observes task ref
   - agent verifies task
   - PMO records pointer-only evidence
   - PMO drift/reconciliation sees the receipt

## Final Position

The capabilities go hand-in-hand, but the value comes from orchestration, not from collapsing ownership.

LLM Tracker should stay the local execution system. Program Manager should become the program-level context, integration, and evidence layer over it. The integration should make the agent workflow feel like one system while the implementation keeps two explicit authorities.
