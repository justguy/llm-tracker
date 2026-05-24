# Session Hub v0.4 — Execution Task Breakdown

**Companion to:** `llm_tracker_session_hub_PRD_v0.4.md`, `llm_tracker_session_hub_TDD_v0.4.md`
**Also reads:** `llm_tracker_session_hub_EXECUTOR_ADDENDUM.md` v0.1 (provider-runtime layer, timeline, diff, worktree)
**Status:** Draft v0.6 — addendum integrated; **all 28 open questions closed** (TDD §23.2 + §25 + §6.9.4 + §6.10 + §6.11 + §6.12). Ready for execution.
**Scope:** an operator-capable personal build per PRD §12 / TDD §21
**Precedence on conflict** (addendum §0): safety rules → existing tracker semantics → v0.4 PRD/TDD → addendum → provider-specific assumptions.

---

## 0. Conventions

### 0.1 Task ID

`SH-<phase>-<seq>` where `<phase>` is `0` (cross-cutting) or `1..9` (TDD §21 phases), and `<seq>` is a two-digit sequence. IDs are stable; deleted tasks are tombstoned, not renumbered.

### 0.2 Task fields

- **Title** — short imperative.
- **Phase** — TDD phase id and name.
- **Depends on** — other `SH-*` task IDs; `—` if none.
- **Allowed paths** — globs the task is permitted to touch (advisory; `*` for cross-cutting docs).
- **DoD** — bullet list of concrete acceptance checks.
- **Evidence** — what artifact proves DoD (test name, endpoint, file, screenshot, MCP tool name).
- **Gaps** — open questions blocking this task; each tagged `BLOCKING` or `ADVISORY`.

### 0.3 Status

`not_started | in_progress | complete | deferred | blocked`. Tracked here only until promoted to the llm-tracker project (planned once gaps below are resolved).

### 0.4 Approval gates

Tasks marked **APPROVAL** require explicit operator sign-off before merging to `main`, typically because they change durable schema, security posture, or the public CLI/MCP surface.

---

## 1. Open gaps to resolve

These come from PRD §15.2 / TDD §23.2 plus design holes I noticed while breaking the work down. **BLOCKING** items must be answered before the named phase starts; **ADVISORY** items can be deferred but should be answered before tasks tagged with them complete.

### 1.0 Closed (TDD §23.2 / §25 / §6.9 / §6.10)

- **G-01 — Runtime ID format.** Canonical lower-case ULID with type prefix; `SessionId` matches `^ses_[0-9a-hjkmnp-tv-z]{26}$`; prefixes also for `job_`, `evt_`, `skr_`, `ctx_`, `att_`. Hub generates IDs; clients never do. UI may render short alias `ses-K2WX`. See TDD §6.10. Unblocks SH-1-01.
- **G-03 — Stdio capture default.** Disk capture **OFF** by default; live tail **ON** via in-memory ring buffer (`memoryRingBytes: 262144`). Cards show `STDIO LIVE | STDIO CAPTURED | STDIO OFF`. Toggling capture emits `SessionStdioCaptureChangedEvent`. See SH-2-04 / SH-2-05 / SH-2-23.
- **G-04 — Activity thresholds.** Defaults: `heartbeatEveryMinutes: 5`, `missingHeartbeatAfterMinutes: 12`, `dumbTerminalQuietAfterMinutes: 10`, `dumbTerminalQuietEscalateAfterMinutes: 25`, `appServerDisconnectedWarningAfterSeconds: 60`. `staleAfterMinutes` is renamed `missingHeartbeatAfterMinutes`. See SH-2-10.
- **G-06 — App-server timing.** P0 for operator-capable build but **not** a boot-time dependency. Hub starts and runs without it; SH-9-13 fallback to GenericPty is non-negotiable. Phase 9 stays in the operator-capable build.
- **G-09 — Tracker schema validator.** Optional validator support for `task.repos` and `task.verify` added per TDD §6.9.4. Missing fields valid; present-but-invalid fields fail on patch/write. `allowed_paths` is repo-relative-only (no absolute, no `..`, no NUL). Verify-item ids unique per task, regex `^[a-z0-9][a-z0-9_.:-]{0,63}$`. Composition collision: `task.verify.items > profile defaults > workspace defaults`. Unblocks SH-5-07, SH-7-05, SH-5-04.
- **G-12 — Snapshot debounce max-age.** Keep 250 ms debounce; force flush on `snapshotMaxAgeMs: 5000`, on `snapshotMaxEventsPending: 250`, and on clean shutdown. See SH-1-06.
- **G-13 — Single vs split log.** Keep single `runtime-events.jsonl`. Revisit only when log exceeds 250 MB or cold rebuild exceeds 5 s.
- **G-14 — Repo-root discovery.** Attach/start passes `cwd`, `repoRoot`, `worktreePath` when available; CLI uses `process.cwd()` + `git rev-parse --show-toplevel`. Failure leaves session attached with `repo unknown` label and a `[Set repo/worktree]` affordance; no parent-dir crawling. See SH-2-12, SH-2-22.
- **G-15 — Worktree auto-creation.** Recommend, never silent. `[Create worktree for this job]` attention action on `multiple_sessions_same_worktree`; Run Session preflight may preselect dedicated worktree creation when `recommendOnTaskSessionStart` is on. Trusted auto-create only when both `trustedLocalMode.allowWorktreeCreationFromUI` and `worktrees.allowTrustedAutoCreateOnLaunch` are set.
- **G-16 — `human_approval` notification style.** Push-style WS event backed by Attention projection. Verify pack emits `verify.human_approval.requested`; Attention strip + Triage surface the item; no blocking modal by default. Label `HUMAN APPROVAL REQUIRED` (when required + blocking) vs `HUMAN REVIEW READY`.
- **G-02 — Workspace config path.** Deterministic lookup: `--config <path>` → `LLM_TRACKER_CONFIG` env → `<workspaceRoot>/llm-tracker.config.yaml` → `<workspaceRoot>/.llm-tracker/config.yaml` → built-in defaults. Resolved config exposed at `GET /api/workspace/config/session-hub` and CLI `llm-tracker config session-hub`. See TDD §23.2 #11, SH-0-03.
- **G-05 — Gate enforcement default.** `uiCompleteMode: block_required_missing`. UI-driven Complete blocks when required gates are missing; human override allowed with recorded reason. Direct tracker patches still allowed but produce `done_claimed_verify_missing` attention item. See TDD §23.2 #12, §25, SH-5-05.
- **G-07 — Layout scope.** Single workspace-local file `.runtime/layouts/session-hub.json` with per-view + per-project subsections; no separate per-project file. See TDD §6.11 + §23.2 #13, SH-2-08.
- **G-08 — CLI session-token transport.** Hub stores hash only. Cleartext token to child processes via env vars (`LT_SESSION_ID`, `LT_JOB_ID`, `LT_SESSION_TOKEN`, `LT_MCP_URL`). Attach/manual prints a one-time pasteable contract. MCP arg `sessionToken`; HTTP header `X-LT-Session-Token`; `maxLifetimeMinutes: 1440`. See TDD §23.2 #14, §19.2, SH-2-06.
- **G-17 — Cross-project queue.** Workspace-scope visibility only; multi-launch requires human confirmation; `maxInitialLaunches: 3`. No autonomous scheduling. See TDD §23.2 #15, §25, SH-3-08.
- **G-18 — Attention ack/snooze/clear persistence.** Runtime events only (`attention.acknowledged`, `attention.snoozed`, `attention.cleared` added to RuntimeEvent union §6.6); never tracker patches; ack/snooze/clear don't clear the underlying warning. See TDD §23.2 #16, SH-4-05.
- **G-19 — Codex token provisioning.** `llm-tracker` does not provision OpenAI/Codex tokens. Codex provider uses installed Codex CLI/app-server auth state; hub session tokens are separate. See TDD §23.2 #17, §25 `providers.codex_app_server.authMode: external_codex_auth`.
- **G-20 — UI framework.** Use existing `llm-tracker` Browser UI framework. Do not migrate as part of Session Hub. New isolated UI packages default to React + Vite + TypeScript. See TDD §23.2 #18.
- **G-21 — Codex schema source.** Schemas generated from installed Codex via `codex app-server generate-ts` / `generate-json-schema` and vendored at `vendor/codex-app-server/<version>/stable/`. Hand-written §7.4 names are illustrative; SH-9-12 replaces them at vendoring time. See TDD §23.2 #19, SH-9-12.
- **G-22 — `trustedLocalMode` per-flag defaults.** All background automation **off** by default; user-clicked actions stay powerful. Full per-flag block in TDD §25. `neverAutoApproveTerminalPrompts: true` non-overridable. See TDD §23.2 #20, SH-0-07.
- **G-23 — PTY library.** `node-pty` primary; `child_process.spawn` fallback when unavailable; capability flags reflect fallback (`terminalResize: false` etc.). See TDD §23.2 #21, SH-2-17.
- **G-24 — Per-provider PTY wrappers.** Use `GenericPtyProviderAdapter` plus command templates (codex_cli, claude_code, kimi, gemini in TDD §25). No bespoke wrappers; PL-08 stays parked. See TDD §23.2 #22, SH-2-17, SH-2-18.
- **G-25 — Timeline persistence.** No separate database/log; projection over RuntimeEvents + normalized provider events + repo events + selected tracker history. Optional `.runtime/timeline.snapshot.json` cache later, not authoritative. See TDD §23.2 #23, SH-4A-01.
- **G-26 — Diff persistence.** Compute diff content on demand from git/worktree; persist only `DiffReviewRecord` metadata + `evidenceRefs`. Shape in TDD §6.12. See TDD §23.2 #24, SH-7A-01.
- **G-27 — App-server transport priority + fallback.** Transport: stdio → unix → websocket (last is upstream-experimental, requires explicit opt-in). Full fallback table in TDD §23.2 #25. See SH-9-13.
- **G-28 — Provider naming.** Provider = user-visible integration; ProviderAdapter = internal class; SessionTier = capability/trust tier; MCP reporting = overlay. Renames: `CodexAppServerAdapter` → `CodexAppServerProviderAdapter`, `ProcessSessionAdapter` → `GenericPtyProviderAdapter`, `McpTrackedSessionAdapter` → `McpReportingOverlay`. Config keys `providers.*`. See TDD §23.2 #26.
- **G-10 — Watcher backend.** Default `chokidar`. `ProjectWorkspaceWatcher` depends on a `WatcherBackend` interface; `ChokidarWatcherBackend` default, `NodeFsWatchBackend` fallback/config override. All backends normalize to `add | change | unlink` before the coalescer. Config knobs (`usePolling`, `atomic`, `awaitWriteFinish`, `coalesceMs`, `maxBatchSize`, `ignore`) in TDD §25. See TDD §23.2 #27, SH-7-01.
- **G-11 — Process kill escalation.** `[STOP]` → `SIGINT` → wait `sigintGraceMs: 5000` → `SIGKILL`. Every signal recorded as `process.signal_sent`. `[FORCE KILL]` skips the grace window but is exposed only in the session detail dock. See TDD §23.2 #28 + §25 `processLifecycle`, SH-2-03.

### 1.1 BLOCKING

_(empty — all foundational gaps closed)_

### 1.2 ADVISORY

_(empty — all advisory gaps closed)_

---

## 2. Cross-cutting prerequisites (Phase 0)

### SH-0-01 — Repository scaffolding for `hub/` subtree
- **Phase:** 0 (Cross-cutting)
- **Depends on:** —
- **Allowed paths:** `hub/**`
- **DoD:**
  - Top-level `hub/` directory created with subfolders mirroring TDD §21: `runtime/`, `sessions/`, `jobs/`, `skills/`, `workspaces/`, `conflicts/`, `attention/`, `run-session/`, `context-packs/`.
  - Each subfolder gets an `index.js` placeholder so wiring tests fail loud, not silent.
  - `package.json` exports map updated if applicable.
- **Evidence:** `git diff --stat` shows new tree; lint passes; `npm test` does not regress.
- **Gaps:** none.

### SH-0-02 — Logging + audit event interfaces
- **Phase:** 0
- **Depends on:** SH-0-01
- **Allowed paths:** `hub/logging/**`
- **DoD:** central `log.audit()` and `log.debug()` exports; audit events carry timestamp, source, action, subject. Used by token reject, gate override, force-claim, etc.
- **Evidence:** unit test asserts that calling `tokens.validate` on a bad token writes a structured audit line.
- **Gaps:** none.

### SH-0-03 — Workspace config loader + JSON schema
- **Phase:** 0
- **Depends on:** SH-0-01
- **Allowed paths:** `hub/config/**`, `schema/workspace.schema.json`, `hub/api/workspace-config.js`, `hub/cli/config.js`
- **DoD:**
  - Lookup order (TDD §23.2 #11): (1) `--config <path>` flag, (2) `LLM_TRACKER_CONFIG` env, (3) `<workspaceRoot>/llm-tracker.config.yaml`, (4) `<workspaceRoot>/.llm-tracker/config.yaml`, (5) built-in defaults.
  - Validates against schema; applies defaults from TDD §25 (`activity`, `stdio`, `runtimeStore`, `worktrees`, `notifications`, `completionGates`, `crossProjectQueue`, `trustedLocalMode`, `providers`).
  - Resolved config exposed at `GET /api/workspace/config/session-hub` and CLI `llm-tracker config session-hub`.
  - Missing config file yields defaults; malformed file fails startup with a clear, line-anchored error.
- **Evidence:** unit tests for each lookup-order rung; defaults regression test pins every §25 value; HTTP/CLI surface tests.
- **Gaps:** none.

### SH-0-04 — CI matrix update
- **Phase:** 0
- **Depends on:** SH-0-01
- **Allowed paths:** `.github/workflows/**`, `package.json`
- **DoD:** CI runs new `hub/**` test files on Node 18/20 across macOS + Linux runners. The Node 18 websocket fix (commit 5cc5d17) stays green.
- **Evidence:** CI green on a no-op `hub/` PR.
- **Gaps:** none.

### SH-0-05 — Capture/secrets caveat user-facing docs
- **Phase:** 0
- **Depends on:** —
- **Allowed paths:** `docs/session-hub/**`
- **DoD:** new doc explains stdio capture, retention, secrets risk, and how to disable capture per workspace. Referenced by SH-2-05 tooltip.
- **Evidence:** file present; link from README; UI tooltip target verified manually.
- **Gaps:** G-03 ADVISORY (final default tone depends on choice).

### SH-0-06 — Repository inventory PR
- **Phase:** 0
- **Depends on:** —
- **Allowed paths:** `docs/session-hub/repo-inventory.md`
- **DoD:** first PR/commit reports server framework, UI framework, store/revision implementation, CLI/MCP structure, type/schema style, test runner, routing patterns, WS patterns (addendum §18 Step 0). Confirms no new framework or database is being introduced.
- **Evidence:** doc present; PR description matches the list.
- **Gaps:** none.

### SH-0-07 — Feature flags + `trustedLocalMode` config
- **Phase:** 0
- **Depends on:** SH-0-03
- **Allowed paths:** `hub/config/defaults.js`, `schema/workspace.schema.json`
- **DoD:**
  - Workspace config schema implements every TDD §25 block verbatim, including `completionGates`, `crossProjectQueue`, `trustedLocalMode`, and `providers`.
  - `neverAutoApproveTerminalPrompts: true` is non-overridable; lint rule blocks PRs that flip it.
  - `trustedLocalMode` defaults per TDD §23.2 #20: every background-automation flag false; user-initiated action flags true (`allow*OnUserAction`, `allow*FromUI`); `requireConfirmationForCrossProjectLaunch: true`; `stdioCaptureToDiskDefault: false`.
- **Evidence:** schema validation tests; defaults round-trip; lint rule integration test for the non-overridable flag; tests that a `trustedLocalMode` config with `autoApproveProviderRequests: true` AND `neverAutoApproveTerminalPrompts: false` is rejected at load time.
- **Gaps:** none.

### SH-0-08 — Addendum precedence note
- **Phase:** 0
- **Depends on:** —
- **Allowed paths:** `docs/session-hub/precedence.md`
- **DoD:** short reference for executors: precedence order matches addendum §0 (safety rules → existing tracker → v0.4 PRD/TDD → addendum → provider-specific). Linked from README and PR template.
- **Evidence:** file present; README link works.
- **Gaps:** none.

---

## 3. Phase 1 — Runtime foundation

### SH-1-01 — `RuntimeStore` skeleton + ID generator
- **Phase:** 1 (Runtime foundation)
- **Depends on:** SH-0-01
- **Allowed paths:** `hub/runtime/store.js`, `hub/runtime/paths.js`, `hub/runtime/queue.js`, `hub/runtime/ids.js`
- **DoD:**
  - `RuntimeStore` class with single async write queue; all `append()` calls serialize through it.
  - ID generator `makeRuntimeId(prefix)` per TDD §6.10: lower-case ULID with type prefix (`ses_`, `job_`, `evt_`, `skr_`, `ctx_`, `att_`); typed brand exports `SessionId`, `JobId`, `RuntimeEventId`, `SkillRunId`, `ContextPackId`, `AttentionItemId`.
  - `isSessionId(s)` / equivalent guards exported and used at API/MCP boundaries.
  - Client-supplied IDs are rejected outside an explicit test-fixture mode (a single named flag, asserted by a unit test).
  - File paths derived from workspace root + `paths.js`; canonical IDs are safe for URLs, JSON, filenames, and MCP args.
- **Evidence:**
  - Unit test issues 100 parallel `append()` calls; resulting JSONL preserves arrival order and produces zero ID collisions.
  - Property test: 10 000 generated IDs match the per-prefix regex, are unique, and round-trip through `JSON.parse(JSON.stringify(...))`, URL encoding, and `path.join`.
  - Test asserting that `POST /api/sessions` with a client-supplied `id` is rejected (400 + audit event) outside test mode.
- **Gaps:** none.

### SH-1-02 — RuntimeEvent schema + validator
- **Phase:** 1
- **Depends on:** SH-1-01
- **Allowed paths:** `hub/runtime/events.js`, `schema/runtime-events.schema.json`
- **DoD:**
  - JSON Schema for the union types in TDD §6.6.
  - `validateRuntimeEvent(event)` throws on malformed events with field-level message.
  - `schemaVersion: 1` enforced.
- **Evidence:** schema fixtures for every union member; reject test for unknown `type`, missing `ts`, wrong `schemaVersion`.
- **Gaps:** none.

### SH-1-03 — Idempotency key dedupe
- **Phase:** 1
- **Depends on:** SH-1-01, SH-1-02
- **Allowed paths:** `hub/runtime/idempotency.js`, `hub/runtime/store.js`
- **DoD:**
  - When `idempotencyKey` present, dedupe by `(sessionId?, jobId?, source, idempotencyKey)` within a configurable window (default 5 min).
  - Retried call returns the prior `eventId` and `rev`, does not append.
- **Evidence:** unit test: send same heartbeat twice → one row in JSONL, identical return value.
- **Gaps:** none.

### SH-1-04 — JSONL append + atomic snapshot write
- **Phase:** 1
- **Depends on:** SH-1-01
- **Allowed paths:** `hub/runtime/snapshots.js`, `hub/runtime/atomic.js`
- **DoD:**
  - `atomicWriteJson(path, obj)` follows TDD §5.5 (temp file → fsync → rename → fsync dir where supported).
  - JSONL appends use a single write call ending in `\n`; partial writes recover gracefully.
- **Evidence:** crash-injection test (kill before rename) leaves no half-written snapshot; corrupt-line test stops replay at last valid line and emits warning.
- **Gaps:** none.

### SH-1-05 — In-memory projection
- **Phase:** 1
- **Depends on:** SH-1-02
- **Allowed paths:** `hub/runtime/projection.js`
- **DoD:**
  - `RuntimeProjection.apply(event)` updates sessions/jobs/skillRuns indices.
  - `toSnapshots()` returns the three derived snapshots.
  - Idempotent: replaying the same event twice produces the same state (helpful for rebuild).
- **Evidence:** golden-fixture replay test → expected snapshot JSON.
- **Gaps:** none.

### SH-1-06 — Snapshot debouncer with max-age + max-pending
- **Phase:** 1
- **Depends on:** SH-1-04, SH-1-05
- **Allowed paths:** `hub/runtime/debounce.js`, `hub/runtime/store.js`
- **DoD:**
  - 250 ms debounce per TDD §5.3.
  - Force flush after `snapshotMaxAgeMs: 5000` even when events keep arriving (TDD §25).
  - Force flush after `snapshotMaxEventsPending: 250` events queued without a flush (TDD §25).
  - Always flush on clean shutdown (`flushOnShutdown: true`).
- **Evidence:** simulated 1 kHz event stream produces ≥ 1 snapshot per 5 s; burst test confirms 250-events-pending forces an interim flush; SIGINT/SIGTERM test confirms shutdown flush.
- **Gaps:** none.

### SH-1-07 — Startup rebuild
- **Phase:** 1
- **Depends on:** SH-1-04, SH-1-05
- **Allowed paths:** `hub/runtime/startup.js`
- **DoD:**
  - Load snapshots if valid, replay JSONL from snapshot watermark, otherwise full rebuild.
  - Corrupt snapshot triggers full rebuild with warning.
  - Corrupt JSONL line halts at last valid event and writes recovery warning.
- **Evidence:** four unit tests (clean, snapshot-only, jsonl-corruption, snapshot-corruption).
- **Gaps:** none.

### SH-1-08 — WebSocket broadcast pipeline
- **Phase:** 1
- **Depends on:** SH-1-01
- **Allowed paths:** `hub/runtime/ws.js`, existing WS server code
- **DoD:**
  - Every appended event → `{ type: "runtime.event", event }` broadcast.
  - Snapshot delivered to new clients on connect.
  - Backpressure: a slow client cannot stall the write queue.
- **Evidence:** WS integration test with one fast and one slow client; fast client receives every event; slow client is dropped after threshold, not blocking append.
- **Gaps:** none.

### SH-1-09 — Basic session CRUD endpoints
- **Phase:** 1
- **Depends on:** SH-1-01, SH-1-02
- **Allowed paths:** `hub/api/sessions.js`
- **DoD:**
  - `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id`, `PATCH /api/sessions/:id`.
  - POST/PATCH route through `RuntimeStore.append`; no direct snapshot mutation.
- **Evidence:** HTTP integration tests; lint forbids direct snapshot writes via custom ESLint rule.
- **Gaps:** none.

### SH-1-10 — Phase 1 acceptance test suite
- **Phase:** 1
- **Depends on:** SH-1-01 … SH-1-09
- **Allowed paths:** `hub/runtime/__tests__/**`
- **DoD:** acceptance test scenarios from TDD §20.1 all pass; coverage report ≥ 85% for `hub/runtime/**`.
- **Evidence:** CI green; coverage badge / output captured.
- **Gaps:** none.

---

## 4. Phase 2 — Session presence + dumb/manual control

### SH-2-01 — `SessionRegistry`
- **Phase:** 2 (Session presence + dumb/manual control)
- **Depends on:** SH-1-09
- **Allowed paths:** `hub/sessions/registry.js`
- **DoD:** CRUD over `SessionRecord` backed by RuntimeStore events; capability tier computed from adapter.
- **Evidence:** unit tests for create/archive, capability vector for each tier.
- **Gaps:** none.

### SH-2-02 — Session warning vocabulary + events
- **Phase:** 2
- **Depends on:** SH-2-01
- **Allowed paths:** `hub/sessions/warnings.js`, `hub/runtime/events.js`
- **DoD:**
  - Implements all kinds in TDD §8.3.
  - Emits `SessionWarningEvent` / `SessionWarningClearedEvent`.
  - Regression test asserts no `kind: "quiet"` warning is ever emitted (renamed to `quiet_terminal`).
- **Evidence:** unit tests per warning kind; lint rule forbidding the literal `"quiet"` warning kind.
- **Gaps:** none.

### SH-2-03 — `ProcessSessionAdapter` (becomes `GenericPtyProviderAdapter`)
- **Phase:** 2
- **Depends on:** SH-2-01
- **Allowed paths:** `hub/sessions/adapters/process.js`
- **DoD:**
  - Spawn process, capture stdout/stderr, persist to log when capture is on, update `lastOutputAt`.
  - Stdin pass-through gated by explicit user action.
  - Stop sequence (TDD §23.2 #28 / §25 `processLifecycle`):
    - emit `session.stop.requested`;
    - send `SIGINT`; emit `process.signal_sent { signal: "SIGINT" }`;
    - wait `sigintGraceMs: 5000`;
    - if process is still alive, send `SIGKILL`; emit `process.signal_sent { signal: "SIGKILL", reason: "sigint_grace_expired" }`;
    - emit `process.exited` and `session.stopped` when observed.
  - `[FORCE KILL]` skips the grace window. It is exposed only in the session detail dock (SH-2-13), not on the small card; every `FORCE KILL` records an audit event.
  - Forbids any heuristic on output content.
- **Evidence:**
  - Unit tests cover spawn/restart and the full stop sequence (exit-within-grace, exit-after-grace).
  - Audit log captures every `process.signal_sent` with reason.
  - Lint rule blocks `RegExp` / `includes("approval")` etc. inside this file; semantic-state tests assert no `approval_needed` warning is ever produced from this adapter.
  - UI smoke confirms `[FORCE KILL]` is absent from the small card.
- **Gaps:** none.

### SH-2-04 — Stdio capture: memory ring + disk rotation
- **Phase:** 2
- **Depends on:** SH-2-03, SH-0-03
- **Allowed paths:** `hub/sessions/stdio/rotation.js`, `hub/sessions/stdio/ring.js`
- **DoD:**
  - **Live stdio default ON** for any provider that exposes `rawStdio`. **Disk capture default OFF** (`stdio.captureToDisk: false`). The two settings are independent.
  - When capture is OFF, hub keeps an in-memory ring buffer of `stdio.memoryRingBytes: 262144` (256 KiB default) for the live UI; no `.runtime/session-stdio/<sessionId>.log` is created.
  - When capture is ON, live log capped at `maxBytes: 5242880` (5 MB), overflow rotates to `<id>.<n>.log`, retention `rotatedSegments: 3`.
  - `SessionStdioState` tracks `{ liveTail, captureToDisk, memoryRingBytes, maxBytes, rotatedSegments, currentLogBytes?, rotatedSegmentCount? }`.
  - First time a workspace enables capture (`promptOnFirstCapture: true`) requires explicit acknowledgement of the secrets caveat.
- **Evidence:**
  - capture-off test: live stream visible in UI; ring buffer never exceeds `memoryRingBytes`; no log file created.
  - capture-on test: 12 MB write produces live + 3 segments; older segments deleted.
  - first-capture prompt path covered.
  - hub restart with capture-off discards old in-memory ring; new session starts fresh.
- **Gaps:** none.

### SH-2-23 — Stdio capture toggle endpoint + audit event
- **Phase:** 2
- **Depends on:** SH-2-04, SH-1-02
- **Allowed paths:** `hub/api/sessions.js`, `hub/runtime/events.js`
- **DoD:**
  - `POST /api/sessions/:sessionId/stdio/capture { captureToDisk, reason? }` toggles the per-session capture mode.
  - Emits `SessionStdioCaptureChangedEvent` per TDD §6.6 with `{ sessionId, captureToDisk, reason? }`.
  - Turning capture ON requires a session-scoped token (SH-2-06); a no-op call with same state still succeeds without emitting an event.
  - UI card label updates from `STDIO LIVE` to `STDIO CAPTURED` (or back) within one WS broadcast.
- **Evidence:** HTTP integration test for both directions; WS smoke confirms label flip; event log line present.
- **Gaps:** none.

### SH-2-05 — Stdio mode indicator + secrets caveat
- **Phase:** 2
- **Depends on:** SH-2-04, SH-0-05
- **Allowed paths:** `ui/session-hub/SessionCard.*`, `ui/session-hub/StdioBadge.*`
- **DoD:**
  - Every session card shows exactly one of `STDIO LIVE`, `STDIO CAPTURED`, `STDIO OFF`.
  - `STDIO LIVE` = provider supports `rawStdio`, live stream visible, ring buffer only.
  - `STDIO CAPTURED` = live stream visible AND rolling logs persisted under `.runtime/session-stdio/`; tooltip links to SH-0-05 secrets caveat.
  - `STDIO OFF` = provider does not expose `rawStdio` (e.g., manual or structured-only sessions).
- **Evidence:** UI snapshot test per label; integration test transitioning between modes; manual+app-server sessions correctly land on `STDIO OFF`.
- **Gaps:** G-20 ADVISORY (component framework).

### SH-2-06 — Session-scoped token issuance + validation middleware
- **Phase:** 2
- **Depends on:** SH-2-01
- **Allowed paths:** `hub/sessions/auth/tokens.js`, `hub/api/middleware/session-token.js`
- **DoD:**
  - Token bound to `(sessionId, capabilities, expiresAt)`; default `maxLifetimeMinutes: 1440`.
  - **Hub stores the token hash only** (TDD §23.2 #14). Cleartext is shown exactly once at issuance.
  - Cleartext propagation:
    - HTTP create-session response (one-time).
    - CLI `session start` / `session attach` stdout (one-time).
    - Child process env vars: `LT_SESSION_ID`, `LT_JOB_ID`, `LT_SESSION_TOKEN`, `LT_MCP_URL`.
    - Pasteable contract from SH-6-07 includes the same values.
  - HTTP header `X-LT-Session-Token`; MCP argument `sessionToken`; rejected calls → 401 + `SessionTokenAuditEvent`.
- **Evidence:** integration tests for valid/expired/wrong-session token; CLI test captures token output in stdout and asserts the hub side stores only the hash; env-var propagation test on child process; rotation test confirms old token revoked.
- **Gaps:** none.

### SH-2-07 — Token rotation endpoint
- **Phase:** 2
- **Depends on:** SH-2-06
- **Allowed paths:** `hub/api/sessions.js`
- **DoD:**
  - `POST /api/sessions/:sessionId/token/rotate` issues new token, revokes old immediately.
  - `SessionTokenRotatedEvent` recorded.
- **Evidence:** integration test: old token returns 401 after rotation; new token works.
- **Gaps:** none.

### SH-2-08 — Layout JSON read/write
- **Phase:** 2
- **Depends on:** SH-1-04
- **Allowed paths:** `hub/runtime/layouts.js`, `hub/api/layouts.js`
- **DoD:**
  - `.runtime/layouts/session-hub.json` is the sole layout source — workspace-local, atomic overwrite on PUT.
  - File shape implements `SessionHubLayoutFile` from TDD §6.11: `global`, `views.hub`, `views.triage`, `views.project[<slug>]`.
  - Per-project sections live inside this single file; no separate per-project file exists.
  - Corrupt file falls back to default.
  - Regression guard: no `runtime-events.jsonl` line carries a layout-typed event.
- **Evidence:** unit tests for read/write/reset; schema validation against §6.11 shape; lint rule against any `LayoutUpdatedEvent` literal; integration test confirms per-project subsection round-trips.
- **Gaps:** none.

### SH-2-09 — Layout endpoints + WS broadcast
- **Phase:** 2
- **Depends on:** SH-2-08, SH-1-08
- **Allowed paths:** `hub/api/layouts.js`
- **DoD:**
  - `GET / PUT / RESET` per TDD §12.4.
  - WS `layout.updated` debounced to 100 ms.
- **Evidence:** WS integration test: 30 rapid PUTs produce ≤ 4 WS broadcasts.
- **Gaps:** none.

### SH-2-10 — `ActivityMonitor`
- **Phase:** 2
- **Depends on:** SH-2-01, SH-2-02, SH-0-03
- **Allowed paths:** `hub/sessions/activity.js`
- **DoD:**
  - Implements rules in TDD §8.2 exactly.
  - Emits `SessionStatusEvent` only when state changes.
  - Tier-aware: dumb terminal → `quiet_terminal`; MCP/app-server → `missing_heartbeat`.
  - Threshold sources (TDD §25): `dumbTerminalQuietAfterMinutes: 10`, `dumbTerminalQuietEscalateAfterMinutes: 25` (escalates the existing `quiet_terminal` warning from medium to high — never to `approval_needed`), `missingHeartbeatAfterMinutes: 12`, `heartbeatEveryMinutes: 5` for `expectsHeartbeat` logic, `appServerDisconnectedWarningAfterSeconds: 60` for the `disconnected` warning kind (independent of `missing_heartbeat`).
- **Evidence:** golden tests from TDD §20.3 incl. regression check that no `stale` state is ever produced; tests covering the escalation transition at 25 min for dumb terminals; test that app-server transport disconnect emits the `disconnected` warning within 60 s.
- **Gaps:** none.

### SH-2-11 — Session cards UI
- **Phase:** 2
- **Depends on:** SH-2-01, SH-1-08
- **Allowed paths:** `ui/session-hub/SessionCard.*`, `ui/session-hub/SessionGroup.*`
- **DoD:**
  - Enum sizes `compact | normal | large` only; no free resize.
  - Source/evidence labels visible on warnings.
  - WS-driven live updates without page reload.
- **Evidence:** UI snapshot tests for each size; live-update test in browser.
- **Gaps:** G-20 ADVISORY.

### SH-2-12 — Manual attach flow (CLI + UI)
- **Phase:** 2
- **Depends on:** SH-2-01, SH-2-06
- **Allowed paths:** `hub/cli/session-attach.js`, `ui/session-hub/AttachDialog.*`
- **DoD:**
  - CLI: `llm-tracker session attach --project --task --agent --cwd --repo-root --worktree` creates session + prints token + contract.
  - CLI fills `cwd` from `process.cwd()` and `repoRoot` from `git rev-parse --show-toplevel` if not supplied (TDD §23.2 closure item 2).
  - If repo discovery fails, the session still attaches and the card shows `repo unknown`.
  - UI: same flow via dialog with read-only `cwd` / editable `repoRoot` / `worktreePath` fields.
- **Evidence:** CLI integration test for both supplied and discovered-fallback paths; UI snapshot test; created session appears in Hub with the correct `repo unknown` label when both fail.
- **Gaps:** none.

### SH-2-22 — `[Set repo/worktree]` affordance for unbound-repo sessions
- **Phase:** 2
- **Depends on:** SH-2-11, SH-2-12
- **Allowed paths:** `ui/session-hub/SessionDetailDock.*`, `hub/api/sessions.js`
- **DoD:**
  - Cards with `repo unknown` show `[Set repo/worktree]` action in their tool row and detail dock.
  - Setting these values updates the session record and re-enables watcher/conflict features.
- **Evidence:** UI smoke; HTTP integration test transitions a session from `repo unknown` to bound.
- **Gaps:** none.

### SH-2-13 — Stdio drawer (follow/pause/search/copy)
- **Phase:** 2
- **Depends on:** SH-2-11, SH-2-03
- **Allowed paths:** `ui/session-hub/SessionDetailDock.*`, `ui/session-hub/StdioPanel.*`
- **DoD:**
  - Follow toggle, pause, search, copy-to-clipboard.
  - Render throttled to 30 fps on visible session, 5 fps off-screen (matches TDD §15.1 even though server batching is not yet implemented).
- **Evidence:** UI snapshot tests; manual smoke for follow-pause behavior.
- **Gaps:** none.

### SH-2-14 — Phase 2 acceptance suite
- **Phase:** 2
- **Depends on:** SH-2-01 … SH-2-13, SH-2-15 … SH-2-21
- **Allowed paths:** `hub/sessions/__tests__/**`, `ui/session-hub/__tests__/**`
- **DoD:** TDD §20.2, §20.3, §20.10 acceptance scenarios pass; plus provider-broker tests from addendum §19.1.
- **Evidence:** CI green; coverage report.
- **Gaps:** none.

### SH-2-15 — `ProviderBroker` + `ProviderRegistry`
- **Phase:** 2
- **Depends on:** SH-2-01, G-28
- **Allowed paths:** `hub/providers/broker.js`, `hub/providers/registry.js`
- **DoD:**
  - Broker exposes `start/attach/resume/fork/stop` keyed by `providerId`.
  - Registry discovers installed `RuntimeProvider` instances at startup.
  - Sessions started through the broker; no caller bypasses it.
- **Evidence:** unit test wires a fake provider and round-trips start/stop through the broker.
- **Gaps:** G-28 ADVISORY.

### SH-2-16 — `ProviderCapabilities` + mapping to `SessionCapabilities`
- **Phase:** 2
- **Depends on:** SH-2-15
- **Allowed paths:** `hub/providers/capabilities.js`
- **DoD:** matches addendum §5 shape exactly; `toSessionCapabilities()` derives the existing `SessionCapabilities` shape used by cards and tool shelf.
- **Evidence:** unit tests covering every capability flag in both directions.
- **Gaps:** none.

### SH-2-17 — `GenericPtyProviderAdapter`
- **Phase:** 2
- **Depends on:** SH-2-15, SH-2-03
- **Allowed paths:** `hub/providers/generic-pty.js`
- **DoD:**
  - Wraps the SH-2-03 process-spawn logic behind the `RuntimeProvider` interface (addendum §6 / §10).
  - Primary PTY backend `node-pty`; fallback `child_process.spawn` when `node-pty` is unavailable (TDD §23.2 #21).
  - `capabilities()` reflects the backend: `node-pty` path returns `{rawStdio: true, stdinWrite: true, processLifecycle: true, terminalResize: true}`; fallback returns `terminalResize: false` and `stdinWrite: partial`. Every `structured*` flag is false unless paired with an explicit MCP contract overlay.
  - Per-provider command templates (`codex_cli`, `claude_code`, `kimi`, `gemini`) come from `providers.*` config (TDD §25); SH-2-17 supplies the template plumbing, no bespoke wrappers (G-24 closure / PL-08 stays parked).
  - Absolutely no semantic parsing of terminal output.
- **Evidence:** lint rule blocks `/approve|blocked|done|verify/i` matchers in this file; tests confirm raw stdio text containing those words triggers no semantic events; template-test creates a session for each of the four CLI providers and asserts capability matches the backend in use.
- **Gaps:** none.

### SH-2-18 — `ManualProvider`
- **Phase:** 2
- **Depends on:** SH-2-15
- **Allowed paths:** `hub/providers/manual.js`
- **DoD:** advisory-only provider per PRD §6.3 manual tier; no process lifecycle; capability flags all false except where human edits drive state; underwrites the MCP contract paste path that Phase 6 wires.
- **Evidence:** unit test asserts no process or auto-mutating events escape the provider.
- **Gaps:** none.

### SH-2-19 — Provider event normalization
- **Phase:** 2
- **Depends on:** SH-2-15, SH-1-02
- **Allowed paths:** `hub/providers/normalizer.js`, `hub/providers/provider-events.js`
- **DoD:**
  - `ProviderEvent` union per addendum §8 implemented.
  - Normalizer maps each event kind to RuntimeEvents per the addendum §8 rules table.
  - Provider-reported file paths annotate but never clear conflict warnings.
- **Evidence:** unit tests for every mapping row; regression test asserts `file_change.applied` does NOT clear an active `file_conflict`.
- **Gaps:** none.

### SH-2-20 — Provider APIs (probe / capabilities / models / skills)
- **Phase:** 2
- **Depends on:** SH-2-15
- **Allowed paths:** `hub/api/providers.js`
- **DoD:** endpoints per addendum §16.1: `GET /api/providers`, `GET /api/providers/:id/capabilities`, `GET /api/providers/:id/models`, `GET /api/providers/:id/skills?cwd=`, `POST /api/providers/:id/probe`.
- **Evidence:** HTTP integration tests against a fake provider with each shape (`listModels` present/absent, `listSkills` present/absent).
- **Gaps:** none.

### SH-2-21 — `ProviderThreadRef` on `SessionRecord`
- **Phase:** 2
- **Depends on:** SH-2-15, SH-2-01
- **Allowed paths:** `hub/sessions/registry.js`, `hub/runtime/events.js`
- **DoD:**
  - Runtime-only `providerThread?: ProviderThreadRef` and `providerCapabilities?: ProviderCapabilities` added to the projection (addendum §7).
  - Never written into durable tracker JSON.
- **Evidence:** unit tests; tracker schema validator rejects these keys if they appear in tracker JSON (regression guard).
- **Gaps:** none.

---

## 5. Phase 3 — Run Session funnel + project board integration

### SH-3-01 — `RunSessionDraft` model + storage
- **Phase:** 3 (Run Session funnel + board)
- **Depends on:** SH-1-01
- **Allowed paths:** `hub/run-session/drafts.js`
- **DoD:**
  - Ephemeral, `expiresAt` 30 min default.
  - Stored in memory + reissued in projection if server restarts mid-wizard (open: do we reissue or discard? — pick discard for v0.4 simplicity, document).
- **Evidence:** unit test: expired draft cannot be launched; reload discards drafts.
- **Gaps:** none.

### SH-3-02 — `RunCandidateService` scoring engine
- **Phase:** 3
- **Depends on:** SH-1-09 (read tracker), SH-2-01 (read active sessions)
- **Allowed paths:** `hub/run-session/candidates.js`
- **DoD:**
  - Deterministic scoring per TDD §6.7 weights.
  - Returns `reasons[]` and `penalties[]` strings.
  - Filters out completed/archived tasks.
- **Evidence:** unit tests with fixtures for lane/cross-project; explanation strings asserted.
- **Gaps:** none.

### SH-3-03 — Run Session endpoints
- **Phase:** 3
- **Depends on:** SH-3-01, SH-3-02
- **Allowed paths:** `hub/api/run-session.js`
- **DoD:** `GET /api/run-candidates`, `POST /api/run-session/draft`, `GET/PATCH /api/run-session/drafts/:id`, `POST /api/run-session/launch`.
- **Evidence:** HTTP integration tests for each endpoint.
- **Gaps:** none.

### SH-3-04 — Task claim semantics
- **Phase:** 3
- **Depends on:** SH-3-03
- **Allowed paths:** `hub/run-session/task-claim.js`
- **DoD:**
  - `expectedTrackerRev` check.
  - `claimMode: fail_if_active | join | force`.
  - `force` records a `HumanOverrideEvent` with reason; rejected if reason missing.
- **Evidence:** integration tests for `stale_tracker_rev` and `task_claim_conflict`; audit log captures `force` reason.
- **Gaps:** none.

### SH-3-05 — `RunSessionService` (launch path)
- **Phase:** 3
- **Depends on:** SH-3-03, SH-3-04, SH-5-04 (stub OK if Phase 5 not done; concrete after Phase 5)
- **Allowed paths:** `hub/run-session/service.js`
- **DoD:**
  - Validates draft, claims task, creates JobRecord, stamps VerifyPack stub (concrete later), generates start ContextPack stub, creates/attaches Session.
  - Emits projection updates for sessions/jobs/attention.
- **Evidence:** end-to-end test launches a task-card draft → session + job appear in projection.
- **Gaps:** none.

### SH-3-06 — `[+ RUN SESSION]` on task cards
- **Phase:** 3
- **Depends on:** SH-3-05
- **Allowed paths:** `ui/project-board/TaskCard.*`, `ui/project-board/TaskRunButton.*`
- **DoD:**
  - Visible on runnable, unbound task cards.
  - Disabled with reason when task has active job or unmet dependencies.
- **Evidence:** UI snapshot tests for each state in PRD §8.1 task-card matrix.
- **Gaps:** G-20 ADVISORY.

### SH-3-07 — `[+ NEXT IN LANE]` on swimlane headers
- **Phase:** 3
- **Depends on:** SH-3-02, SH-3-05
- **Allowed paths:** `ui/project-board/SwimlaneHeader.*`, `ui/project-board/SwimlaneRunNextButton.*`
- **DoD:** clicking opens wizard with highest-fit task preselected + reason string.
- **Evidence:** browser smoke; explanation string visible.
- **Gaps:** none.

### SH-3-08 — Hub `[+ RUN]` cross-project picker
- **Phase:** 3
- **Depends on:** SH-3-02
- **Allowed paths:** `ui/session-hub/RunSessionButton.*`, `ui/session-hub/RunCandidatePicker.*`
- **DoD:**
  - Picker shows top N candidates across all projects in the current workspace with score + reasons.
  - Scope is workspace-local per TDD §23.2 #15; no autonomous scheduling across projects.
  - Multi-session launch requires explicit confirmation when `crossProjectQueue.requireHumanConfirmForMultiLaunch: true` and is capped at `crossProjectQueue.maxInitialLaunches: 3`.
  - Adds workspace-scope lane chips to Triage: `Runnable now | Blocked | Needs review | Needs closeout | Quiet`.
- **Evidence:** UI snapshot; live preview against fixture trackers; multi-launch confirmation modal smoke; cap-of-3 regression test.
- **Gaps:** none.

### SH-3-09 — RunSessionWizard
- **Phase:** 3
- **Depends on:** SH-3-03
- **Allowed paths:** `ui/run-session/RunSessionWizard.*`
- **DoD:**
  - Steps: task (locked or pick) → profile/runtime → preflight.
  - Preflight surfaces `RunPreflightWarning[]` with severity.
  - Launch button disabled with reason when warnings of severity `high` are unresolved.
- **Evidence:** snapshot tests; integration test for launch path.
- **Gaps:** none.

### SH-3-10 — TaskSessionBadge inline component
- **Phase:** 3
- **Depends on:** SH-2-11
- **Allowed paths:** `ui/project-board/TaskSessionBadge.*`
- **DoD:** badge appears on task cards bound to an active session; shows tier, status, last activity.
- **Evidence:** UI snapshot tests for each tier/state.
- **Gaps:** none.

### SH-3-11 — ProjectSessionStrip
- **Phase:** 3
- **Depends on:** SH-2-11
- **Allowed paths:** `ui/project-board/ProjectSessionStrip.*`
- **DoD:** strip appears above swimlanes; shows project-local sessions only; `[+ RUN]` at the end.
- **Evidence:** UI snapshot; live WS update test.
- **Gaps:** none.

### SH-3-12 — Task card state matrix
- **Phase:** 3
- **Depends on:** SH-3-06, SH-3-10
- **Allowed paths:** `ui/project-board/TaskCard.*`
- **DoD:** each state row in PRD §8.1 renders the exact action set listed.
- **Evidence:** parametrized snapshot test covering every row.
- **Gaps:** none.

### SH-3-13 — Phase 3 acceptance suite
- **Phase:** 3
- **Depends on:** SH-3-01 … SH-3-12, SH-3-14 … SH-3-18
- **Allowed paths:** `hub/run-session/__tests__/**`, `ui/run-session/__tests__/**`
- **DoD:** TDD §20.4 + addendum §19.4 scenarios pass.
- **Evidence:** CI green.
- **Gaps:** none.

### SH-3-14 — Launch Brief capability preview
- **Phase:** 3
- **Depends on:** SH-2-16, SH-3-09
- **Allowed paths:** `ui/run-session/CapabilityPreview.*`
- **DoD:** preview lists provider capability flags with ✓ / ○ markers; matches the two example layouts in addendum §17.3 (Codex app-server vs generic terminal).
- **Evidence:** UI snapshot tests for two providers; live preview against fixture broker.
- **Gaps:** none.

### SH-3-15 — Launch Brief: CLI equivalent + copy-prompt
- **Phase:** 3
- **Depends on:** SH-3-09
- **Allowed paths:** `ui/run-session/RunSessionWizard.*`, `hub/api/run-session.js`
- **DoD:**
  - Wizard surfaces the equivalent `llm-tracker run session …` CLI command.
  - `POST /api/run-session/draft/:id/copy-prompt` returns the fully materialized prompt for clipboard.
- **Evidence:** UI snapshot; HTTP test; CLI command runs identically when copy-pasted into a terminal.
- **Gaps:** none.

### SH-3-16 — Drag/drop routed through preflight
- **Phase:** 3
- **Depends on:** SH-3-09
- **Allowed paths:** `ui/project-board/TaskCard.*`, `ui/session-hub/*`
- **DoD:** dragging a task onto a session or drop zone always opens draft/preflight; never binds-and-launches without confirmation (addendum §14: "do not allow drag/drop to bypass preflight").
- **Evidence:** UI smoke; HTTP regression test asserts the bypass path is impossible.
- **Gaps:** none.

### SH-3-17 — `RunSessionDraft` extended fields
- **Phase:** 3
- **Depends on:** SH-3-01, SH-2-15
- **Allowed paths:** `hub/run-session/drafts.js`
- **DoD:** add `providerId`, `model`, `sandbox`, `worktreePath`, `branch`, `capabilityPreview`, `claimMode`, `expectedTrackerRev`, `refreshContext` action per addendum §14.
- **Evidence:** unit tests for draft validation; preflight emits `capability_mismatch` when provider lacks a required capability for the chosen profile.
- **Gaps:** none.

### SH-3-18 — Preflight warning expansion
- **Phase:** 3
- **Depends on:** SH-3-17
- **Allowed paths:** `hub/run-session/preflight.js`
- **DoD:** preflight emits the full warning list from addendum §14 ("preflight must check"): `provider_unavailable`, `capability_mismatch`, `sandbox_disallowed`, `context_injection_unsupported`, in addition to the TDD-listed warnings.
- **Evidence:** scenario tests per warning kind.
- **Gaps:** none.

### SH-3-19 — Preflight: preselect dedicated worktree creation
- **Phase:** 3
- **Depends on:** SH-3-09, SH-7B-01
- **Allowed paths:** `hub/run-session/preflight.js`, `ui/run-session/RunSessionWizard.*`
- **DoD:**
  - When `worktrees.recommendOnTaskSessionStart` is on and the chosen task has repo metadata but the current worktree is shared with another active session, the wizard preselects "Create dedicated worktree" with the `defaultNamingPattern` applied.
  - Selection is editable; user can opt out before launch.
  - One-click launch creates the worktree only when both `trustedLocalMode.allowWorktreeCreationFromUI` and `worktrees.allowTrustedAutoCreateOnLaunch` are true; otherwise the worktree step requires explicit confirmation.
- **Evidence:** scenario tests for both gated paths; UI snapshot.
- **Gaps:** G-22 ADVISORY.

---

## 6. Phase 4 — Attention strip + Triage

### SH-4-01 — `AttentionItem` model + dedupe key
- **Phase:** 4 (Attention strip + Triage)
- **Depends on:** SH-1-02
- **Allowed paths:** `hub/attention/types.js`, `hub/attention/dedupe.js`
- **DoD:**
  - Exactly matches TDD §6.8 shape.
  - DedupeKey = `kind|projectSlug|taskId|jobId|sessionId|evidenceRef`.
- **Evidence:** unit tests for dedupeKey collisions.
- **Gaps:** none.

### SH-4-02 — `AttentionEngine` projection
- **Phase:** 4
- **Depends on:** SH-4-01, SH-2-01, SH-1-05
- **Allowed paths:** `hub/attention/engine.js`, `hub/attention/projection.js`
- **DoD:**
  - Computes items from sessions/jobs/warnings/conflicts/tracker on every relevant event.
  - Priority order from TDD §8A.3.
- **Evidence:** scenario tests for each kind in PRD §8.5.
- **Gaps:** none.

### SH-4-03 — Per-kind generation rules
- **Phase:** 4
- **Depends on:** SH-4-02
- **Allowed paths:** `hub/attention/rules/**`
- **DoD:** one rule file per kind (`approval_needed.js`, `blocked.js`, `conflict.js`, etc.) following TDD §8A.3 "Generation rules".
- **Evidence:** dedicated unit test per file.
- **Gaps:** none.

### SH-4-04 — Auto-clear rules
- **Phase:** 4
- **Depends on:** SH-4-02
- **Allowed paths:** `hub/attention/rules/**`
- **DoD:** clear conditions per TDD §8A.3 "Clear rules" implemented; clear emits `AttentionItem.clearedAt`.
- **Evidence:** scenario tests for each clear path.
- **Gaps:** none.

### SH-4-05 — Ack/snooze/clear endpoints + events
- **Phase:** 4
- **Depends on:** SH-4-02
- **Allowed paths:** `hub/api/attention.js`, `hub/runtime/events.js`
- **DoD:**
  - `POST /api/attention/:id/ack | snooze | clear`.
  - Persisted as `AttentionAckEvent` / `AttentionSnoozedEvent` / `AttentionClearedEvent` per TDD §6.6.
  - Semantics (TDD §23.2 #16): `ack` hides from Attention strip but keeps item visible in Triage where relevant; `snooze` accepts `until` timestamp + optional `reason`, hides until `until` unless severity escalates; `clear` only fires when the source condition clears (the underlying warning/conflict/gate).
  - None of these mutate durable tracker truth.
- **Evidence:** HTTP integration tests; events survive server restart by replay; smoke confirms `snooze` lifting on escalation; smoke confirms `ack` keeps Triage visibility.
- **Gaps:** none.

### SH-4-06 — AttentionStrip UI
- **Phase:** 4
- **Depends on:** SH-4-02
- **Allowed paths:** `ui/attention/AttentionStrip.*`
- **DoD:**
  - Persistent across Hub, project board, task detail, Triage.
  - Collapsible; never silently buries critical items (collapsing leaves a count chip).
  - Each item shows source label + recommended action chips.
- **Evidence:** UI snapshot in collapsed and expanded states; smoke across the four parent pages.
- **Gaps:** G-20 ADVISORY.

### SH-4-07 — Triage page
- **Phase:** 4
- **Depends on:** SH-4-02
- **Allowed paths:** `ui/triage/**`
- **DoD:** severity lanes; each lane groups by kind; cards mirror Attention strip primitives.
- **Evidence:** UI snapshot; live WS update test.
- **Gaps:** none.

### SH-4-08 — `AttentionAction` wiring
- **Phase:** 4
- **Depends on:** SH-4-06, SH-4-07, SH-2-12 (open session), SH-8-* later (rollover)
- **Allowed paths:** `hub/attention/actions.js`, `ui/attention/**`
- **DoD:**
  - Every action kind in TDD §6.8 is dispatched.
  - Disabled actions show `disabledReason`.
  - Actions dependent on later phases (rollover, spawn_reviewer) gated behind feature flag until that phase lands.
- **Evidence:** unit tests; manual smoke against fixture sessions.
- **Gaps:** none.

### SH-4-09 — WS `attention.updated` broadcast
- **Phase:** 4
- **Depends on:** SH-4-02, SH-1-08
- **Allowed paths:** `hub/runtime/ws.js`, `hub/attention/engine.js`
- **DoD:** broadcasts when item is created, ack-ed, snoozed, cleared, or its severity flips.
- **Evidence:** WS integration tests for each transition.
- **Gaps:** none.

### SH-4-10 — Phase 4 acceptance suite
- **Phase:** 4
- **Depends on:** SH-4-01 … SH-4-09, SH-4-11 … SH-4-13
- **Allowed paths:** `hub/attention/__tests__/**`, `ui/attention/__tests__/**`
- **DoD:** TDD §20.5 + addendum §19.3 scenarios pass.
- **Evidence:** CI green.
- **Gaps:** none.

### SH-4-11 — New attention kinds: `sandbox_escape_requested`, `provider_error`
- **Phase:** 4
- **Depends on:** SH-4-01, SH-4-03
- **Allowed paths:** `hub/attention/rules/sandbox_escape_requested.js`, `hub/attention/rules/provider_error.js`, `hub/attention/types.js`
- **DoD:** addendum §15 kinds added; priority placement: `sandbox_escape_requested` critical, `provider_error` severity depends on `retryable`. `outside_allowed_paths` is also promoted to critical per addendum §15.
- **Evidence:** scenario tests per kind; priority order test reflects addendum §15.
- **Gaps:** none.

### SH-4-12 — `AttentionItem.clearCondition` field + UI surface
- **Phase:** 4
- **Depends on:** SH-4-01, SH-4-04
- **Allowed paths:** `hub/attention/types.js`, `ui/attention/AttentionItemCard.*`
- **DoD:** every item carries a human-readable `clearCondition` string; UI shows it under the item; addendum §15 requires every item to have one.
- **Evidence:** unit + UI snapshot tests; lint rule rejects rule files that don't return a `clearCondition`.
- **Gaps:** none.

### SH-4-13 — Evidence drill-down panel
- **Phase:** 4
- **Depends on:** SH-4-08
- **Allowed paths:** `ui/attention/EvidencePanel.*`
- **DoD:** clicking an attention badge or critical status chip opens a panel with: source, confidence, evidence id (runtime event id / tracker rev / provider event id / conflict id), timestamp, why it exists, recommended action, clear condition (addendum §17.5).
- **Evidence:** UI snapshot; click-through smoke for each item kind.
- **Gaps:** none.

---

## 6A. Phase 4A — SessionTimelineService

A projection layer that merges RuntimeEvents, ProviderEvents, MCP/HTTP session events, watcher/git evidence, and human overrides into a per-session timeline. Attention items deep-link into it. Comes after Attention (Phase 4) so attention drill-down has a target.

### SH-4A-01 — `TimelineItem` model + storage strategy
- **Phase:** 4A (SessionTimelineService)
- **Depends on:** SH-1-02, SH-2-15, G-25
- **Allowed paths:** `hub/timeline/timeline-model.js`
- **DoD:** matches addendum §11 shape exactly; storage approach decided per G-25 (default: in-memory projection rebuilt from RuntimeStore + watcher logs on startup).
- **Evidence:** unit tests for serialize/deserialize and projection rebuild.
- **Gaps:** G-25 ADVISORY.

### SH-4A-02 — Timeline projection
- **Phase:** 4A
- **Depends on:** SH-4A-01, SH-1-05, SH-2-19, SH-7-01
- **Allowed paths:** `hub/timeline/session-timeline-service.js`
- **DoD:** merges RuntimeEvents, ProviderEvents, MCP job/session/skill events, watcher/git repo events, verify command events, and human overrides into a time-ordered `TimelineItem[]` per session. Every item carries `evidenceRef`.
- **Evidence:** golden fixtures; clicking an attention item resolves to a timeline item with matching `evidenceRef`.
- **Gaps:** none.

### SH-4A-03 — Timeline API + WS push
- **Phase:** 4A
- **Depends on:** SH-4A-02, SH-1-08
- **Allowed paths:** `hub/api/timeline.js`
- **DoD:** `GET /api/sessions/:sessionId/timeline?since=&kinds=&limit=`; WS message `timeline.appended` carrying new items, server-batched per §15.1 cadence.
- **Evidence:** HTTP test; WS append smoke.
- **Gaps:** none.

### SH-4A-04 — Timeline tab in session detail dock
- **Phase:** 4A
- **Depends on:** SH-4A-03, SH-2-13
- **Allowed paths:** `ui/session-hub/SessionDetailDock.*`, `ui/session-hub/TimelinePanel.*`
- **DoD:** Timeline tab placed per addendum §11 ordering (`Summary | Timeline | Stdio | Chat | Diff | Context | Skills | Events`). Item rows show kind icon, title, detail, source/confidence chips, evidence link.
- **Evidence:** UI snapshot per kind; click-through opens the evidence panel from SH-4-13.
- **Gaps:** G-20 ADVISORY.

### SH-4A-05 — Timeline preview on large session card
- **Phase:** 4A
- **Depends on:** SH-4A-02, SH-2-11
- **Allowed paths:** `ui/session-hub/SessionCard.*`
- **DoD:** large card shows the last 2–3 timeline items beneath status (addendum §11).
- **Evidence:** UI snapshot.
- **Gaps:** none.

### SH-4A-06 — Attention → Timeline deep link
- **Phase:** 4A
- **Depends on:** SH-4A-04, SH-4-13
- **Allowed paths:** `ui/attention/EvidencePanel.*`
- **DoD:** clicking an attention item with `evidenceRef` jumps to the matching `TimelineItem` in the dock and highlights it briefly.
- **Evidence:** UI smoke.
- **Gaps:** none.

### SH-4A-07 — Raw-stdio timeline marker labeling
- **Phase:** 4A
- **Depends on:** SH-4A-02
- **Allowed paths:** `hub/timeline/session-timeline-service.js`
- **DoD:** any raw-stdio-derived marker is labeled `source: "raw_stdio"`, `confidence: "derived"`. No raw stdio text is ever promoted to a semantic kind (regression guard).
- **Evidence:** unit test; lint rule blocks `source: "structured"` for items whose origin is raw stdio.
- **Gaps:** none.

### SH-4A-08 — Phase 4A acceptance suite
- **Phase:** 4A
- **Depends on:** SH-4A-01 … SH-4A-07
- **Allowed paths:** `hub/timeline/__tests__/**`, `ui/session-hub/__tests__/**`
- **DoD:** addendum §19.5 scenarios pass.
- **Evidence:** CI green.
- **Gaps:** none.

---

## 7. Phase 5 — Jobs and skills

### SH-5-01 — `JobRecord` + `JobRegistry`
- **Phase:** 5 (Jobs and skills)
- **Depends on:** SH-2-01
- **Allowed paths:** `hub/jobs/registry.js`
- **DoD:** CRUD over JobRecord; predecessor/successor links; status transitions logged as events.
- **Evidence:** unit tests for create/checkpoint/complete/cancel/rollover.
- **Gaps:** none.

### SH-5-02 — `SkillsRegistry` + built-in skills
- **Phase:** 5
- **Depends on:** SH-5-01
- **Allowed paths:** `hub/skills/registry.js`, `hub/skills/builtins/**`
- **DoD:**
  - Built-ins: `lt.execute_scope`, `lt.closeout_sweep`, `lt.task_planner`, `lt.verify`, plus heartbeat skill.
  - Each carries `adapters` (codexSkill / mcpPrompt / promptTemplate / httpAction).
- **Evidence:** unit tests assert each skill resolves through each adapter where defined.
- **Gaps:** none.

### SH-5-03 — Job profiles + skill plan generation
- **Phase:** 5
- **Depends on:** SH-5-02
- **Allowed paths:** `hub/jobs/profiles.js`, `hub/jobs/skill-plan.js`
- **DoD:**
  - Profiles `code-implementer`, `prd-writer`, `reviewer`, `planner`, `closeout`.
  - Plan composition resolves profile vs skill default phases predictably (profile wins on conflict — document).
- **Evidence:** golden plan fixtures per profile.
- **Gaps:** none.

### SH-5-04 — VerifyPack composition + stamping
- **Phase:** 5
- **Depends on:** SH-5-03, SH-3-05 (RunSessionService), SH-5-07
- **Allowed paths:** `hub/jobs/verify-pack.js`
- **DoD:**
  - Composition order: `task.verify.items` → profile defaults → workspace defaults (TDD §11.6.1 / §6.9.4).
  - **Collision rule:** earlier source wins on `id` collision. Later sources do not override an earlier id.
  - At job creation: (1) validate `task.verify.items` per SH-5-07, (2) merge per the precedence above, (3) stamp immutable `VerifyPack` on `JobRecord`.
  - Later patches to `task.verify` do NOT widen or alter the in-flight pack.
- **Evidence:**
  - unit tests for each precedence path.
  - collision tests: same id in task + profile keeps the task item; same id in profile + workspace keeps the profile item.
  - immutability regression: patch `task.verify` mid-job and assert the stamped pack is unchanged.
- **Gaps:** none.

### SH-5-05 — `CompletionGate` state machine + evidence binding
- **Phase:** 5
- **Depends on:** SH-5-04, SH-5-01
- **Allowed paths:** `hub/jobs/gates.js`, `hub/api/jobs.js`
- **DoD:**
  - Gate transitions require `evidenceRef`; UI cannot flip gates to `satisfied` without a real event.
  - Default enforcement per TDD §23.2 #12 / §25 `completionGates`: `uiCompleteMode: block_required_missing`. UI-driven `Complete` is rejected with structured `missing_gates[]` when any required gate is unsatisfied.
  - Human override allowed but requires a recorded reason (`HumanOverrideEvent` with non-empty `reason`).
  - Direct tracker patches that flip task status to complete while required gates are missing emit a `done_claimed_verify_missing` attention item.
- **Evidence:** unit tests for each evidence kind; lint rule disallows direct gate flips outside this module; HTTP test for blocked UI complete; override-without-reason returns 400; tracker-patch-bypass test produces the attention item.
- **Gaps:** none.

### SH-5-06 — Verify pack endpoints
- **Phase:** 5
- **Depends on:** SH-5-04, SH-5-05
- **Allowed paths:** `hub/api/verify-pack.js`
- **DoD:**
  - `GET /api/jobs/:jobId/verify-pack`.
  - `POST .../items/:id/run` runs commands/lints with timeout + exit assertions, emits `VerifyCommandStartedEvent` / `VerifyCommandCompletedEvent`.
  - `POST .../items/:id/resolve` handles `human_approval` + `dod_check`. Resolving a `human_approval` item emits `VerifyHumanApprovalResolvedEvent` with the operator's decision and reason.
- **Evidence:** HTTP integration tests; failing command does not satisfy gate; `human_approval` resolution records evidenceRef linked to a `VerifyHumanApprovalResolvedEvent`.
- **Gaps:** none.

### SH-5-13 — `verify.human_approval.requested` lifecycle
- **Phase:** 5
- **Depends on:** SH-5-04, SH-5-05, SH-4-02
- **Allowed paths:** `hub/jobs/verify-pack.js`, `hub/runtime/events.js`, `hub/attention/rules/verify_missing.js`
- **DoD:**
  - When a verify pack reaches a `human_approval` item whose dependencies are satisfied, hub emits `VerifyHumanApprovalRequestedEvent`.
  - `AttentionEngine` projects this into an attention item labeled `HUMAN APPROVAL REQUIRED` (when item is `required: true` and blocks completion) or `HUMAN REVIEW READY` (otherwise) per TDD §23.2 closure item 7.
  - WS broadcasts `attention.updated`; no modal popover is opened by default.
  - Resolving the item clears the attention via SH-5-06's `VerifyHumanApprovalResolvedEvent`.
- **Evidence:** end-to-end test from verify-pack stamping → attention item → WS push → resolve → attention cleared; UI smoke confirms no modal.
- **Gaps:** none.

### SH-5-07 — Tracker schema validator update
- **Phase:** 5 — **APPROVAL**
- **Depends on:** SH-0-01
- **Allowed paths:** existing tracker schema/validator files (TBD)
- **DoD:**
  - Validator accepts optional `task.repos` and `task.verify` per TDD §6.9 + §6.9.4.
  - Missing fields are valid; present-but-invalid fields fail validation on patch/write.
  - `task.repos.secondary` limited to 16 entries; `TaskRepoRef.root` required, non-empty, ≤1024 chars, no NUL; `worktree`/`branch` constrained similarly; `allowed_paths` array ≤256 entries, each ≤512 chars, repo-relative, no leading `/`, no `..`, no NUL.
  - `task.verify.items` ≤128 entries; each `VerifyPackItem.id` unique per task and matches `^[a-z0-9][a-z0-9_.:-]{0,63}$`; `required` is a required boolean.
  - Per-kind constraints enforced: `command.cmd` ≤4096 chars, `cwd` repo-relative, `timeoutSec` 1..3600, `expectExit` defaults to 0; `lint.tool` matches `^[a-zA-Z0-9_.:-]+$`, `args` ≤128 entries; `skill_run.skillId` matches `^[a-z0-9][a-z0-9_.:-]{0,127}$`; `human_approval.prompt` ≤2000 chars; `dod_check.ref` ≤256 chars.
- **Evidence:**
  - validator unit tests for old fixtures (no fields), new fixtures (valid), and rejection fixtures (each constraint violation has its own case).
  - tests for the rejected examples in TDD §6.9.4 (`/Users/me/secrets/**`, `../outside/**`, `src/../../outside/**`, `C:\Users\me\secrets`).
  - load every workspace tracker without error after the change.
- **Gaps:** G-09 closed; only path-discovery for the existing validator (file location) remains an implementation detail.

### SH-5-08 — Tracker board UI: edit `task.repos` and `task.verify`
- **Phase:** 5
- **Depends on:** SH-5-07
- **Allowed paths:** `ui/board/TaskEditor.*`
- **DoD:** edit affordances for repos (root, worktree, branch, allowed_paths globs) and verify items (commands, lints, skill_runs, human_approval, dod_check).
- **Evidence:** UI snapshot; saved JSON validates.
- **Gaps:** none.

### SH-5-09 — Job lifecycle endpoints
- **Phase:** 5
- **Depends on:** SH-5-01
- **Allowed paths:** `hub/api/jobs.js`
- **DoD:** endpoints per TDD §12.2 (`start`, `checkpoint`, `complete`, `cancel`, `rollover`, `context-pack`).
- **Evidence:** HTTP integration tests.
- **Gaps:** none.

### SH-5-10 — Tool shelf (task/session/job/repo/review)
- **Phase:** 5
- **Depends on:** SH-5-09, SH-3-09
- **Allowed paths:** `ui/session-hub/ToolShelf.*`
- **DoD:**
  - Five tool groups per PRD §9.5.
  - Disabled actions show short reason.
  - Disabled-with-MCP-contract fallback offered for low-capability sessions.
- **Evidence:** UI snapshot per selection kind; smoke for fallback path.
- **Gaps:** none.

### SH-5-11 — `SessionSkillsTab` + `JobContextTab`
- **Phase:** 5
- **Depends on:** SH-5-03, SH-5-04
- **Allowed paths:** `ui/session-hub/SessionSkillsTab.*`, `ui/session-hub/SessionContextTab.*`
- **DoD:** show skill plan with status, verify pack with gate statuses, evidence links to RuntimeEvent.
- **Evidence:** UI snapshot; clicking evidence opens event detail.
- **Gaps:** none.

### SH-5-12 — Phase 5 acceptance suite
- **Phase:** 5
- **Depends on:** SH-5-01 … SH-5-11
- **Allowed paths:** `hub/jobs/__tests__/**`, `hub/skills/__tests__/**`, `ui/board/__tests__/**`
- **DoD:** TDD §20.8 scenarios pass.
- **Evidence:** CI green.
- **Gaps:** none.

---

## 8. Phase 6 — MCP reporting

### SH-6-01 — `tracker_session_*` tools
- **Phase:** 6 (MCP reporting)
- **Depends on:** SH-2-06, SH-5-09
- **Allowed paths:** `bin/mcp-server.js`, `hub/runtime/mcp-events.js`
- **DoD:** tools per TDD §13.1; each carries `sessionToken` argument.
- **Evidence:** MCP integration tests; bad token → JSON-RPC error.
- **Gaps:** none.

### SH-6-02 — `tracker_session_context_usage`
- **Phase:** 6
- **Depends on:** SH-6-01
- **Allowed paths:** `bin/mcp-server.js`
- **DoD:** updates `lastStructuredEventAt`; if percent ≥ threshold, sets `context_high` + emits warning with source `mcp`.
- **Evidence:** MCP test; ActivityMonitor receives the structured signal.
- **Gaps:** none.

### SH-6-03 — `tracker_job_*` tools
- **Phase:** 6
- **Depends on:** SH-5-09
- **Allowed paths:** `bin/mcp-server.js`
- **DoD:** tools per TDD §13.2; checkpoint/complete go through gates.
- **Evidence:** integration tests; complete with missing gates returns structured error.
- **Gaps:** none.

### SH-6-04 — `tracker_skill_*` tools
- **Phase:** 6
- **Depends on:** SH-5-02
- **Allowed paths:** `bin/mcp-server.js`
- **DoD:** tools per TDD §13.3; raw stdio content cannot satisfy a skill run.
- **Evidence:** integration tests; lint rule guards against stdio scraping for skill events.
- **Gaps:** none.

### SH-6-05 — `tracker_job_verify_*` tools
- **Phase:** 6
- **Depends on:** SH-5-06
- **Allowed paths:** `bin/mcp-server.js`
- **DoD:** `tracker_job_verify_pack`, `tracker_job_verify_run`, `tracker_job_verify_resolve` per TDD §11.6.5.
- **Evidence:** integration tests.
- **Gaps:** none.

### SH-6-06 — MCP token validation middleware
- **Phase:** 6
- **Depends on:** SH-2-06
- **Allowed paths:** `hub/sessions/auth/mcp-token.js`
- **DoD:** every mutating MCP tool runs token validation before mutation.
- **Evidence:** test asserts a missing-token call to every mutation tool is rejected.
- **Gaps:** none.

### SH-6-07 — Pasteable MCP session contract
- **Phase:** 6
- **Depends on:** SH-2-12
- **Allowed paths:** `hub/cli/session-contract.js`, `ui/session-hub/ContractDialog.*`
- **DoD:** CLI prints + UI dialog shows the contract text from TDD §8A.5 with concrete IDs filled in.
- **Evidence:** snapshot test; CLI integration test.
- **Gaps:** none.

### SH-6-08 — Phase 6 acceptance suite
- **Phase:** 6
- **Depends on:** SH-6-01 … SH-6-07
- **Allowed paths:** `bin/__tests__/**`, `hub/sessions/auth/__tests__/**`
- **DoD:** every MCP mutation tool rejects missing/invalid token; happy-path tests for every tool.
- **Evidence:** CI green.
- **Gaps:** none.

---

## 9. Phase 7 — Workspace watcher / conflicts

### SH-7-01 — `ProjectWorkspaceWatcher` + `WatcherBackend`
- **Phase:** 7 (Workspace watcher/conflicts)
- **Depends on:** SH-5-07, SH-2-01
- **Allowed paths:** `hub/workspaces/watcher.js`, `hub/workspaces/backends/chokidar.js`, `hub/workspaces/backends/node-fs-watch.js`
- **DoD:**
  - `ProjectWorkspaceWatcher` depends on a `WatcherBackend` interface (TDD §23.2 #27); the default is `ChokidarWatcherBackend`; `NodeFsWatchBackend` exists only as fallback/config override (`sessionHub.watcher.backend: node_fs_watch`).
  - All backends normalize raw events to `add | change | unlink` before they enter the coalescer (SH-7-02).
  - Watches each project's repo roots + worktrees; ignores patterns from §25 `watcher.ignore` list.
  - Backend options (`usePolling`, `atomic`, `awaitWriteFinish`) come from §25 config.
- **Evidence:**
  - Unit test against tmp dir; ignore patterns work.
  - Test that default workspace config instantiates `ChokidarWatcherBackend`; `backend: node_fs_watch` instantiates `NodeFsWatchBackend`; both feed the same normalization/coalescing path.
- **Gaps:** none.

### SH-7-02 — Per-`(repoRoot, path)` coalescer
- **Phase:** 7
- **Depends on:** SH-7-01
- **Allowed paths:** `hub/workspaces/coalescer.js`
- **DoD:** 200 ms debounce; collapse rules per TDD §9.6 (`change`/`unlink`/`add`).
- **Evidence:** unit tests for each collapse rule.
- **Gaps:** none.

### SH-7-03 — `RepoBurstEvent` aggregate
- **Phase:** 7
- **Depends on:** SH-7-02
- **Allowed paths:** `hub/workspaces/coalescer.js`, `hub/runtime/events.js`
- **DoD:** when batch would exceed `maxBatchSize` (default 500), emit `repo.burst` with `samplePaths`, file count, reason.
- **Evidence:** unit test fires 600 rapid events on one repo → one `repo.burst`, no `repo.change` flood.
- **Gaps:** none.

### SH-7-04 — Attribution rules
- **Phase:** 7
- **Depends on:** SH-7-02
- **Allowed paths:** `hub/workspaces/attribution.js`
- **DoD:** strong / likely / ambiguous / unknown per TDD §9.4.
- **Evidence:** unit tests for each rule.
- **Gaps:** none.

### SH-7-05 — Allowed-path glob check
- **Phase:** 7
- **Depends on:** SH-7-04, SH-5-07
- **Allowed paths:** `hub/workspaces/allowed-paths.js`
- **DoD:**
  - Watcher normalizes the changed file path relative to the repo root and matches against `task.repos.allowed_paths` using one shared glob engine (TDD §6.9.4 / §9.5).
  - If `allowed_paths` is **absent**, no `outside_allowed_paths` warning is ever emitted for that task.
  - If `allowed_paths` is **present** and no pattern matches, `outsideAllowedPaths: true` is set on the `RepoChangeEvent` and an `outside_allowed_paths` attention item is produced.
  - The glob engine is the same one used by SH-7A-04 diff allowed-paths and SH-5-08 board UI preview.
- **Evidence:** unit tests for include/exclude globs; explicit tests for the rejected-pattern cases in SH-5-07 (they never reach the watcher because validation fails first).
- **Gaps:** none.

### SH-7-06 — Git evidence collector
- **Phase:** 7
- **Depends on:** —
- **Allowed paths:** `hub/workspaces/git-evidence.js`
- **DoD:** collects `status`/`diff --stat`/`log --since`; safe against missing git.
- **Evidence:** unit test against fixture repo.
- **Gaps:** none.

### SH-7-07 — `ConflictDetector`
- **Phase:** 7
- **Depends on:** SH-7-04, SH-7-06
- **Allowed paths:** `hub/conflicts/detector.js`
- **DoD:** detects every type in TDD §9.5.
- **Evidence:** scenario tests per type.
- **Gaps:** none.

### SH-7-08 — Conflict endpoints + ack flow
- **Phase:** 7
- **Depends on:** SH-7-07
- **Allowed paths:** `hub/api/conflicts.js`
- **DoD:** endpoints per TDD §12.5; ack emits `ConflictAckEvent`.
- **Evidence:** HTTP integration tests.
- **Gaps:** none.

### SH-7-09 — Worktree recommendation / create action
- **Phase:** 7
- **Depends on:** SH-7-07, G-15
- **Allowed paths:** `hub/workspaces/worktree.js`, `ui/attention/AttentionItemCard.*`
- **DoD:** when `multiple_sessions_same_worktree` fires, attention item exposes `create_worktree` action; clicking runs `git worktree add` with a safe default path.
- **Evidence:** integration test creates a worktree, binds a new session, conflict clears.
- **Gaps:** G-15 ADVISORY.

### SH-7-10 — Phase 7 acceptance suite
- **Phase:** 7
- **Depends on:** SH-7-01 … SH-7-09
- **Allowed paths:** `hub/workspaces/__tests__/**`, `hub/conflicts/__tests__/**`
- **DoD:** TDD §20.7 scenarios pass.
- **Evidence:** CI green.
- **Gaps:** none.

---

## 9A. Phase 7A — DiffReviewService

In-app changed-files / diff review. Git and watcher remain authoritative; provider file-change items annotate but never clear conflict warnings. Diff review works for dumb-terminal sessions via git/watcher alone (addendum §12).

### SH-7A-01 — `DiffReviewRecord` model
- **Phase:** 7A (DiffReviewService)
- **Depends on:** SH-7-06
- **Allowed paths:** `hub/diffs/diff-review-service.js`
- **DoD:**
  - Implements `DiffReviewRecord` per TDD §6.12 (metadata only): `{ id, projectSlug, taskId?, jobId?, sessionId?, baseRev?, baseGitSha?, status, evidenceRefs[], createdAt, updatedAt }`.
  - Status workflow: `open | reviewed | changes_requested | approved | closed`.
  - **Diff content is computed on demand from git/worktree state and is NOT persisted** (TDD §23.2 #24). The hub does not write diff hunks to runtime storage to avoid persisting secrets or large blobs.
- **Evidence:** unit tests; serialization round-trip; regression test asserts no hunk text appears in any persisted file.
- **Gaps:** none.

### SH-7A-02 — Base/head computation
- **Phase:** 7A
- **Depends on:** SH-7A-01, SH-7-06
- **Allowed paths:** `hub/diffs/changed-since.js`, `hub/diffs/git-diff.js`
- **DoD:** base = `job.startRev` + corresponding git SHA at job start; head = current; uses tracker `/changed?fromRev=` plus `git diff`. Safe against missing git.
- **Evidence:** scenario tests against fixture repo + tracker.
- **Gaps:** none.

### SH-7A-03 — Provider file-change annotation
- **Phase:** 7A
- **Depends on:** SH-7A-01, SH-2-19
- **Allowed paths:** `hub/diffs/provider-file-changes.js`
- **DoD:** provider `file_change.proposed` / `file_change.applied` events annotate the matching file row in `providerItems` but cannot clear `file_conflict` warnings.
- **Evidence:** unit test asserts conflict persists after a matching `file_change.applied`.
- **Gaps:** none.

### SH-7A-04 — Allowed-paths warnings inside diff
- **Phase:** 7A
- **Depends on:** SH-7A-01, SH-7-05
- **Allowed paths:** `hub/diffs/diff-review-service.js`
- **DoD:** files outside `task.repos.allowed_paths` flagged via `allowedPathWarnings`; UI surface highlights row.
- **Evidence:** unit + UI snapshot tests.
- **Gaps:** none.

### SH-7A-05 — Conflict display in diff
- **Phase:** 7A
- **Depends on:** SH-7A-01, SH-7-07
- **Allowed paths:** `hub/diffs/diff-review-service.js`
- **DoD:** active `ConflictWarning`s for paths in the diff surface as `conflictIds[]`; UI banner above the diff.
- **Evidence:** unit + UI snapshot tests.
- **Gaps:** none.

### SH-7A-06 — Diff API endpoint
- **Phase:** 7A
- **Depends on:** SH-7A-01, SH-7A-02
- **Allowed paths:** `hub/api/diffs.js`
- **DoD:** `GET /api/sessions/:sessionId/diff` returns `DiffReview` with all tab data; supports `?baseRev=` override for ad-hoc comparisons.
- **Evidence:** HTTP integration test.
- **Gaps:** none.

### SH-7A-07 — Diff panel UI
- **Phase:** 7A
- **Depends on:** SH-7A-06
- **Allowed paths:** `ui/session-hub/DiffPanel.*`
- **DoD:** tabs per addendum §12: `Changed since job start | Provider proposals | Git diff | Allowed paths | Conflicts | Reviewer notes`.
- **Evidence:** UI snapshot per tab.
- **Gaps:** none.

### SH-7A-08 — Diff actions (spawn reviewer / run verify / closeout)
- **Phase:** 7A
- **Depends on:** SH-7A-07, SH-5-09, SH-5-06
- **Allowed paths:** `ui/session-hub/DiffPanel.*`, `hub/api/diffs.js`
- **DoD:** action buttons: spawn reviewer job (creates a new RunSessionDraft pre-bound to the changed-since context pack), run verify, mark closeout pending. Each opens preflight where needed and respects `trustedLocalMode.allowVerifyCommandRunFromUI`.
- **Evidence:** scenario test for each action; UI smoke.
- **Gaps:** G-22 ADVISORY.

### SH-7A-09 — Phase 7A acceptance suite
- **Phase:** 7A
- **Depends on:** SH-7A-01 … SH-7A-08
- **Allowed paths:** `hub/diffs/__tests__/**`
- **DoD:** addendum §19.6 scenarios pass; diff works for dumb-terminal sessions via git/watcher alone.
- **Evidence:** CI green.
- **Gaps:** none.

---

## 9B. Phase 7B — WorktreeService

Supersedes the spike in SH-7-09 and gives worktrees first-class lifecycle (addendum §13).

### SH-7B-01 — `WorktreeService` skeleton
- **Phase:** 7B (WorktreeService)
- **Depends on:** SH-7-06
- **Allowed paths:** `hub/worktrees/worktree-service.js`
- **DoD:** `create | bind | list | archive` operations; archive requires explicit confirmation; never destructive without reason recorded.
- **Evidence:** unit tests; archive without reason → 400.
- **Gaps:** none.

### SH-7B-02 — Branch helpers
- **Phase:** 7B
- **Depends on:** SH-7B-01
- **Allowed paths:** `hub/worktrees/branch-service.js`
- **DoD:** create branch, switch branch in worktree, fetch upstream; safe defaults; no force-push.
- **Evidence:** scenario tests in a fixture repo.
- **Gaps:** none.

### SH-7B-03 — Worktree metadata on session/job
- **Phase:** 7B
- **Depends on:** SH-7B-01, SH-2-01
- **Allowed paths:** `hub/sessions/registry.js`, `hub/jobs/registry.js`
- **DoD:** `worktreePath` and `branch` visible on every session card; binding recorded as a runtime event.
- **Evidence:** UI snapshot; runtime event in log.
- **Gaps:** none.

### SH-7B-04 — Same-worktree detection upgrade
- **Phase:** 7B
- **Depends on:** SH-7B-01, SH-7-07
- **Allowed paths:** `hub/conflicts/detector.js`
- **DoD:**
  - `multiple_sessions_same_worktree` raises an attention item whose primary action is `[Create worktree for this job]` (TDD §23.2 closure item 5).
  - Secondary actions: `[Acknowledge]`, `[Open conflicts]`.
  - Resolving via worktree creation clears the warning.
  - The hub never silently moves an existing running session into a new worktree.
- **Evidence:** scenario test transitions warning ambiguous → resolved after worktree creation; "silent move" path returns 400 + audit event.
- **Gaps:** none.

### SH-7B-05 — Worktree UI actions
- **Phase:** 7B
- **Depends on:** SH-7B-01, SH-4-08
- **Allowed paths:** `ui/session-hub/SessionCard.*`, `ui/attention/AttentionItemCard.*`
- **DoD:**
  - `[CREATE WORKTREE]`, `[BIND WORKTREE]`, `[ACKNOWLEDGE SHARED WORKTREE]` actions per addendum §13.
  - `[CREATE WORKTREE]` is gated by `trustedLocalMode.allowWorktreeCreationFromUI`.
  - One-click create-on-launch path requires both `trustedLocalMode.allowWorktreeCreationFromUI` and `worktrees.allowTrustedAutoCreateOnLaunch` true (TDD §25).
  - Naming follows `worktrees.defaultNamingPattern` (`{projectSlug}/{taskId}-{shortTitle}` default).
- **Evidence:** UI snapshot; smoke for blocked-by-flag path; created worktree path matches the naming pattern.
- **Gaps:** G-22 ADVISORY (only the per-flag default).

### SH-7B-06 — Archive worktree after closeout
- **Phase:** 7B
- **Depends on:** SH-7B-01
- **Allowed paths:** `hub/worktrees/worktree-service.js`, `ui/session-hub/SessionCard.*`
- **DoD:** closeout flow offers worktree archive/delete with confirmation; never auto-runs; respects in-flight commits/uncommitted changes (refuses to delete with a clear reason).
- **Evidence:** scenario test; confirmation step required; dirty-worktree path produces a refusal.
- **Gaps:** none.

### SH-7B-07 — Phase 7B acceptance suite
- **Phase:** 7B
- **Depends on:** SH-7B-01 … SH-7B-06
- **Allowed paths:** `hub/worktrees/__tests__/**`
- **DoD:** scenarios for create/bind/archive; conflict-clearing path verified end-to-end.
- **Evidence:** CI green.
- **Gaps:** none.

---

## 10. Phase 8 — Deterministic rollover

### SH-8-01 — `ContextPackService` skeleton + pack kinds
- **Phase:** 8 (Deterministic rollover)
- **Depends on:** SH-5-01
- **Allowed paths:** `hub/context-packs/service.js`
- **DoD:** routes per kind in TDD §10.1; deterministic source list per TDD §10.2.
- **Evidence:** unit tests per kind against fixtures.
- **Gaps:** none.

### SH-8-02 — Pack composers
- **Phase:** 8
- **Depends on:** SH-8-01
- **Allowed paths:** `hub/context-packs/composers/**`
- **DoD:** one composer per kind (`start`, `resume`, `rollover`, `handoff`, `review`, `verify`, `closeout`, `changed_since`).
- **Evidence:** golden fixtures per composer.
- **Gaps:** none.

### SH-8-03 — Rollover algorithm
- **Phase:** 8
- **Depends on:** SH-8-02, SH-7-06
- **Allowed paths:** `hub/context-packs/rollover.js`
- **DoD:** deterministic pack from brief/why/execute/verify/changed/history/runtime events/repo events/git; old-session handoff included only with `advisoryHandoffLabel`.
- **Evidence:** test produces full rollover pack with old session dead.
- **Gaps:** none.

### SH-8-04 — Successor session linking
- **Phase:** 8
- **Depends on:** SH-8-03, SH-2-01
- **Allowed paths:** `hub/sessions/registry.js`, `hub/jobs/registry.js`
- **DoD:** predecessor/successor links updated atomically; `JobRolloverRequestedEvent` recorded; old session marked `rolled_over`.
- **Evidence:** integration test traces full lineage.
- **Gaps:** none.

### SH-8-05 — Rollover trigger sources
- **Phase:** 8
- **Depends on:** SH-8-04
- **Allowed paths:** `hub/context-packs/rollover.js`, `hub/attention/rules/context_high.js`
- **DoD:** triggers per TDD §17.1 wired (manual, context-high, missing heartbeat, MCP, resume/reload).
- **Evidence:** scenario tests per trigger.
- **Gaps:** none.

### SH-8-06 — RolloverDialog UI
- **Phase:** 8
- **Depends on:** SH-8-03
- **Allowed paths:** `ui/session-hub/RolloverDialog.*`
- **DoD:** preview pack; allow inline edit; launch successor or copy to clipboard.
- **Evidence:** UI snapshot; integration smoke.
- **Gaps:** none.

### SH-8-07 — Attention `rollover` action
- **Phase:** 8
- **Depends on:** SH-8-06, SH-4-08
- **Allowed paths:** `hub/attention/actions.js`, `ui/attention/**`
- **DoD:** rollover action visible on `context_high`, `not_responding` (where appropriate), `done_claimed_verify_missing` items.
- **Evidence:** UI smoke.
- **Gaps:** none.

### SH-8-08 — Phase 8 acceptance suite
- **Phase:** 8
- **Depends on:** SH-8-01 … SH-8-07
- **Allowed paths:** `hub/context-packs/__tests__/**`
- **DoD:** TDD §20.6 scenarios pass.
- **Evidence:** CI green.
- **Gaps:** none.

---

## 11. Phase 9 — Codex app-server provider

**Phase positioning (TDD §23.2 closure item 3):** P0 for the operator-capable build, but **not a boot-time dependency**. SH-9-13's fallback to `GenericPtyProvider` is non-negotiable so the Hub starts and runs without Codex installed. Capabilities surface only when probed (SH-9-11) and the vendored schema (SH-9-12) is available.


### SH-9-01 — Codex provider transport client (probe-driven)
- **Phase:** 9 (Codex app-server provider)
- **Depends on:** SH-0-03, SH-2-15, G-19, G-21, G-27
- **Allowed paths:** `hub/providers/codex-app-server.js`, `hub/providers/codex-rpc.js`
- **DoD:**
  - Transport client (WS or stdio per probed schema, addendum §9) with capped exponential backoff.
  - **No method names hardcoded from TDD §7.4** — methods loaded from the vendored schema (SH-9-12).
  - When schema is unavailable, the provider declares itself unavailable rather than guessing method names.
- **Evidence:** unit test against a mock server stubbed from the vendored schema; second test asserts no method name is referenced as a string literal outside the schema-derived dispatcher.
- **Gaps:** G-19 BLOCKING, G-21 BLOCKING, G-27 BLOCKING.

### SH-9-02 — `hello` handshake + capability cache
- **Phase:** 9
- **Depends on:** SH-9-01
- **Allowed paths:** `hub/sessions/adapters/codex-rpc.js`
- **DoD:** capability flags cached and exposed; missing capability disables corresponding features.
- **Evidence:** capability-degraded tests run against a mock advertising different flag sets.
- **Gaps:** none.

### SH-9-03 — `events.subscribe` + notification router
- **Phase:** 9
- **Depends on:** SH-9-02
- **Allowed paths:** `hub/sessions/adapters/codex-app-server.js`, `hub/sessions/appserver-events.js`
- **DoD:** every server-pushed method in TDD §7.4.4 has a handler; unknown methods logged + ignored.
- **Evidence:** unit tests for each method.
- **Gaps:** none.

### SH-9-04 — Thread create/send/cancel/list/resume
- **Phase:** 9
- **Depends on:** SH-9-03
- **Allowed paths:** `hub/sessions/adapters/codex-app-server.js`
- **DoD:** all client→server methods in TDD §7.4.3 implemented; `threads.resume` only when capability advertised; fallback uses `threads.create`.
- **Evidence:** integration tests against mock.
- **Gaps:** G-06 BLOCKING (timing).

### SH-9-05 — Event normalization mapping
- **Phase:** 9
- **Depends on:** SH-9-03
- **Allowed paths:** `hub/sessions/appserver-events.js`
- **DoD:** mapping table in TDD §7.4.5 implemented; each row covered by a test.
- **Evidence:** unit tests per row.
- **Gaps:** none.

### SH-9-06 — Approval flow
- **Phase:** 9
- **Depends on:** SH-9-05, SH-4-08
- **Allowed paths:** `hub/sessions/adapters/codex-app-server.js`, `hub/attention/rules/approval_needed.js`
- **DoD:** `thread.approval` → attention item → `approvals.resolve` on action; `thread.approval_resolved` clears the item.
- **Evidence:** scenario test end-to-end.
- **Gaps:** none.

### SH-9-07 — Context usage flow
- **Phase:** 9
- **Depends on:** SH-9-05
- **Allowed paths:** `hub/sessions/adapters/codex-app-server.js`, `hub/attention/rules/context_high.js`
- **DoD:** `thread.context_usage ≥ threshold` → `context_high` warning + state; threshold configurable.
- **Evidence:** unit test asserts threshold behavior.
- **Gaps:** none.

### SH-9-08 — Reconnect reconciliation
- **Phase:** 9
- **Depends on:** SH-9-01, SH-9-04
- **Allowed paths:** `hub/sessions/adapters/codex-app-server.js`
- **DoD:** on reconnect, run `threads.list`; unknown threads → session marked `unknown` and human action requested.
- **Evidence:** scenario test simulating a disconnect that loses threads.
- **Gaps:** none.

### SH-9-09 — Capability-degraded UX
- **Phase:** 9
- **Depends on:** SH-9-02, SH-5-10
- **Allowed paths:** `ui/session-hub/ToolShelf.*`
- **DoD:** missing capability → action disabled with a short reason and MCP-contract fallback offered.
- **Evidence:** UI snapshot for missing-`supportsApprovals` and missing-`supportsContextUsage` cases.
- **Gaps:** none.

### SH-9-10 — Phase 9 acceptance suite
- **Phase:** 9
- **Depends on:** SH-9-01 … SH-9-09, SH-9-11 … SH-9-15
- **Allowed paths:** `hub/providers/__tests__/**`
- **DoD:** scenarios for every TDD §7.4 sub-section *as derived from the vendored schema*; mock server fixtures committed; addendum §19.7 scenarios pass; fallback path verified.
- **Evidence:** CI green.
- **Gaps:** none.

### SH-9-11 — Codex installation probe
- **Phase:** 9
- **Depends on:** SH-2-15, SH-2-20, G-19
- **Allowed paths:** `hub/providers/codex-app-server.js`
- **DoD:** `probe()` detects whether `codex app-server` is installed and returns version + advertised capability set; failure marks the provider unavailable; never throws into the broker.
- **Evidence:** unit test with mocked binary; integration test against real `codex` if CI has it.
- **Gaps:** G-19 BLOCKING.

### SH-9-12 — Protocol schema vendoring
- **Phase:** 9
- **Depends on:** SH-9-11, G-21
- **Allowed paths:** `hub/providers/codex-schema/**`, `scripts/vendor-codex-schema.*`
- **DoD:**
  - Vendored schema lives at a versioned path.
  - Build/install script populates it per G-21 (bundle / generate-on-install / paste).
  - Adapter loads schema at startup and validates every outgoing call + incoming event against it.
- **Evidence:** vendored file present; drift test compares vendored schema with the installed `codex` schema and warns on mismatch.
- **Gaps:** G-21 BLOCKING.

### SH-9-13 — Capability-degraded fallback to `GenericPtyProviderAdapter`
- **Phase:** 9
- **Depends on:** SH-9-11, SH-2-17
- **Allowed paths:** `hub/providers/codex-app-server.js`, `hub/providers/broker.js`
- **DoD:**
  - When the Codex provider is unavailable or the schema cannot be loaded, the broker substitutes `GenericPtyProviderAdapter` for `codex` runs and surfaces a `provider_error` (retryable) attention item.
  - Transport priority for the structured path (TDD §23.2 #25): `stdio` → `unix` → `websocket` (the last only when explicitly enabled in `providers.codex_app_server.transportPreference`).
  - Per-feature fallback table:
    - `thread/resume` unavailable → successor spawn via `thread/start`, UI label "successor spawn" not "thread reattach".
    - `thread/fork` unavailable → deterministic rollover pack + `thread/start`.
    - Structured approvals unavailable → no approval badge from this provider.
    - Context usage unavailable → no `context_high` from this provider.
    - Turn-level diff unavailable → `DiffReviewService` uses git/watcher only.
    - Schema generation unavailable → Codex provider disabled with "provider setup required" attention item.
- **Evidence:** scenario tests simulate each missing-capability path; broker substitution test; transport-preference unit tests; missing-schema path surfaces the setup-required attention item.
- **Gaps:** none.

### SH-9-14 — Provider review (Codex-native) — optional
- **Phase:** 9
- **Depends on:** SH-9-04, SH-7A-08, G-24
- **Allowed paths:** `hub/providers/codex-app-server.js`, `hub/api/diffs.js`
- **DoD:** when Codex advertises a native review surface, the diff panel's "spawn reviewer" can route through it instead of spawning a new tracker job. Gated by `trustedLocalMode.allowProviderReviewFromUI`.
- **Evidence:** capability-flag-driven test; UI smoke with flag off.
- **Gaps:** G-24 ADVISORY.

### SH-9-15 — Provider action endpoints
- **Phase:** 9
- **Depends on:** SH-9-04, SH-9-06, SH-2-20
- **Allowed paths:** `hub/api/provider-actions.js`
- **DoD:** endpoints per addendum §16.4: `POST /api/sessions/:sessionId/provider/{approve,deny,interrupt,steer,fork,review}`. Each validates session-scoped token and the provider's capability flags; missing capability → 409 with reason.
- **Evidence:** HTTP integration tests for each endpoint, capability present and absent.
- **Gaps:** none.

---

## 12. Future / parking lot

Items mentioned in PRD/TDD but not slated for v0.4 implementation; promote to the appropriate phase when answered.

- **PL-01** — Cross-project execution queue (PRD §8.15; G-17). Currently the Hub `[+ RUN]` picker covers the common case; a queue is a later refinement.
- **PL-02** — Free-resize session cards (PRD §9.3; deferred until enum sizes prove insufficient).
- **PL-03** — Workspace-level Neo4j/PMO backend (PRD §4.2 non-goal).
- **PL-04** — Guardrail policy engine (PRD §4.2 non-goal).
- **PL-05** — Hoplon-specific integration (PRD §4.2 non-goal).
- **PL-06** — Automatic worktree creation policy (G-15) — depends on whether SH-7-09 suggestion is enough.
- **PL-07** — Workspace stdio-redaction stage. Currently §19.3 explicitly says no redaction; revisit if operators ask for it.
- **PL-08** — Per-provider PTY wrappers (`ClaudeCodePtyProvider`, `KimiPtyProvider`, `GeminiPtyProvider`). Deferred unless G-24 says otherwise; `GenericPtyProvider` already covers their baseline (addendum §10).
- **PL-09** — Codex-native review surface beyond the SH-9-14 hook (a dedicated review UI built around `provider/review`). Promote when a concrete use case appears.
- **PL-10** — Provider thread `fork()` UX beyond the create/resume baseline. The interface exists in addendum §6; UX is parking-lotted until a real operator flow demands it.
- **PL-11** — `attach()` provider method usage. Most providers don't expose this safely; revisit when one does.

---

## 13. Index by dependency

This is a quick read of fan-out so you can see which tasks unblock the most others. Update when gap answers change shape.

- **SH-1-01** unlocks the whole Phase 1 chain → Phase 2 chain → everything else.
- **SH-2-01** unlocks Phase 2 UI/auth, Phase 3 launch, Phase 4 attention, Phase 5 jobs.
- **SH-2-06** unlocks all MCP mutation tools (SH-6-*).
- **SH-3-05** is the convergence point for every Run Session entry.
- **SH-4-02** is the convergence point for every attention surface.
- **SH-5-04** + **SH-5-05** are the convergence point for "done" semantics; many tests depend on them.
- **SH-5-07** unlocks watcher allowed-paths checks and verify-pack composition for task-stamped items.
- **SH-2-15** unlocks every provider integration (GenericPty, Manual, Codex, capability preview, run candidates' provider field).
- **SH-2-19** unlocks provider-driven attention, timeline, and diff annotation flows.
- **SH-4A-02** is the convergence point for Timeline; every attention drill-down anchors here.
- **SH-7A-01** is the convergence point for DiffReview; spawn-reviewer and verify-from-diff hook into it.
- **SH-7B-01** unlocks SH-7B-04 (conflict-clearing flow) and the worktree UI action set.
- **SH-9-11** + **SH-9-12** gate every Codex-specific task — without probe + vendored schema, Phase 9 cannot proceed.

---

## 14. Change log

- **v0.1 (initial draft)** — broken down from PRD/TDD v0.4; 9 phases + Phase 0 cross-cutting + parking lot; 20 open gaps captured (9 BLOCKING, 11 ADVISORY).
- **v0.6** — closed G-10 (watcher backend = chokidar with `WatcherBackend` interface + `NodeFsWatchBackend` fallback) and G-11 (SIGINT + 5 s grace + SIGKILL; `[FORCE KILL]` only in dock).
  - TDD additions: §23.2 closure items 27 and 28; §25 YAML gains `watcher` and `processLifecycle` blocks.
  - Task updates: SH-7-01 (backend interface + per-backend tests), SH-2-03 (full stop sequence + audit events + dock-only `[FORCE KILL]`).
  - Open gaps now: **0**. Design is implementable end-to-end without further product decisions.
- **v0.5** — closed all remaining foundational and most behavioral gaps (16 closures); only G-10 / G-11 remained advisory.
  - TDD additions: §23.2 closure items 11–26 (config path, gate enforcement, layout scope, CLI token transport, cross-project queue, ack/snooze persistence, Codex token, UI framework, schema vendoring, `trustedLocalMode`, PTY library, provider templates, timeline/diff persistence, transport priority, provider naming); §25 YAML extended with `completionGates`, `crossProjectQueue`, full `trustedLocalMode`, `providers`; new §6.11 `SessionHubLayoutFile`, §6.12 `DiffReviewRecord`; `AttentionClearedEvent` added to §6.6; §7.4.3 method-name table marked illustrative.
  - Task updates: SH-0-03 (config lookup order), SH-0-07 (full `trustedLocalMode` defaults + non-overridable flag), SH-2-04/SH-2-05 (live-vs-disk wording corrected: live stdio ON when provider supports `rawStdio`, disk capture OFF), SH-2-06 (env-var transport + hash-only storage), SH-2-08 (layout file shape), SH-2-17 (node-pty + fallback + command templates), SH-3-08 (workspace cross-project queue), SH-4-05 (ack/snooze/clear lifecycle + `AttentionClearedEvent`), SH-5-05 (block-by-default enforcement), SH-7A-01 (metadata-only persistence), SH-9-13 (transport priority + per-feature fallback table).
  - Open gaps now: 2 ADVISORY (G-10 file-watcher library, G-11 process kill escalation); 26 closed.
- **v0.4** — closed 3 more BLOCKING gaps (G-01 runtime ID format, G-03 stdio capture refinement, G-09 tracker schema validator).
  - TDD additions: §6.10 Runtime ID format (canonical lower-case ULID + type prefix); §6.9.4 detailed validation constraints for `task.repos` / `task.verify`; §25 YAML gains `memoryRingBytes: 262144`; §6.6 `RuntimeEvent` union gains `SessionStdioCaptureChangedEvent`; §23.2 gains closure items 9 (IDs) and 10 (validator scope), and item 6 (stdio default) is expanded with ring-buffer + capture-change-event semantics.
  - Task updates: SH-1-01 (canonical IDs + property tests + client-supplied-ID rejection), SH-2-04 (in-memory ring when capture OFF, per-session `SessionStdioState`), SH-5-04 (collision rule), SH-5-07 (detailed validation), SH-7-05 (allowed_paths shared glob engine + absent-vs-present semantics).
  - New task: SH-2-23 (stdio capture toggle endpoint + audit event).
  - Open gaps now: 18 (6 BLOCKING, 12 ADVISORY); 10 closed.
- **v0.3** — closed 8 open questions per user direction; updated PRD §15 + TDD §23.2 + added TDD §25 workspace config defaults appendix.
  - Closed gaps: G-03 (stdio capture default OFF), G-04 (activity thresholds), G-06 (app-server timing: P0 not boot-time), G-12 (snapshot debounce max-age + max-pending), G-13 (single log + split triggers), G-14 (explicit repo-root args + fallback), G-15 (worktree recommend-not-silent), G-16 (push-style `verify.human_approval`).
  - Updated tasks: SH-0-03 / SH-0-07 (config), SH-1-06 (snapshot debouncer), SH-2-04 / SH-2-05 (stdio defaults + labels), SH-2-10 (ActivityMonitor thresholds + escalation), SH-2-12 (CLI repo args), SH-3-18 / SH-3-19 (worktree preflight), SH-5-06 / SH-5-13 (human_approval lifecycle), SH-7B-04 / SH-7B-05 (worktree recommendation), Phase 9 header note.
  - New tasks: SH-2-22 (`[Set repo/worktree]` affordance), SH-3-19 (preflight preselects dedicated worktree), SH-5-13 (`verify.human_approval.requested` event + WS push).
  - Added `VerifyHumanApprovalRequestedEvent` and `VerifyHumanApprovalResolvedEvent` to TDD §6.6 `RuntimeEvent` union.
  - Open gaps now: 20 (8 BLOCKING, 12 ADVISORY); 8 closed.
- **v0.2** — integrated `EXECUTOR_ADDENDUM` v0.1. Additions:
  - Phase 0: SH-0-06 (repo inventory), SH-0-07 (`trustedLocalMode` config), SH-0-08 (precedence note).
  - Phase 2: SH-2-15..SH-2-21 — `ProviderBroker`, `ProviderCapabilities`, `GenericPtyProvider`, `ManualProvider`, provider event normalization, provider APIs, `ProviderThreadRef`.
  - Phase 3: SH-3-14..SH-3-18 — Launch Brief capability preview, CLI equivalent + copy-prompt, drag/drop routed through preflight, extended draft fields, expanded preflight warnings.
  - Phase 4: SH-4-11..SH-4-13 — new attention kinds (`sandbox_escape_requested`, `provider_error`), `clearCondition` field, evidence drill-down panel.
  - New Phase 4A `SessionTimelineService`: SH-4A-01..SH-4A-08.
  - New Phase 7A `DiffReviewService`: SH-7A-01..SH-7A-09.
  - New Phase 7B `WorktreeService`: SH-7B-01..SH-7B-07.
  - Phase 9 reworked: SH-9-01 now probe-driven; new SH-9-11 (Codex probe), SH-9-12 (schema vendoring), SH-9-13 (fallback to GenericPty), SH-9-14 (Codex-native review), SH-9-15 (provider action endpoints).
  - Open gaps: G-21..G-28 added (2 BLOCKING, 6 ADVISORY).
  - Parking lot: PL-08..PL-11 added (per-provider PTY wrappers, Codex-native review UI, fork UX, `attach()`).
  - Net: 46 new tasks; total now ~146. Total open gaps: 28 (11 BLOCKING, 17 ADVISORY).
