// hub/runtime/projection.js — sh-1-05 (TDD v0.5 §5.2, §5.3, §6.1–§6.5, §6.6)
//
// In-memory RuntimeProjection over the RuntimeEvent log.
//
// The RuntimeStore (sh-1-03) feeds events into `apply(event)` via its
// onAppend hook (wired in a later integration task). The projection holds
// Map<id, record> for sessions / jobs / skillRuns and exposes `toSnapshots()`
// for atomic snapshot writes (sh-1-04 atomicWriteJson).
//
// Idempotency / replay safety:
//   - Each event carries a unique evt_ id (§6.10). apply() tracks the set of
//     ids it has already absorbed and short-circuits duplicates, so JSONL
//     replay (rebuilding state on hub restart) is safe.
//   - All mutations are deterministic — no Date.now(), no random — so
//     replaying the same event sequence reproduces the same state.
//
// Unknown / not-yet-implemented event types are no-ops. Later phases extend
// the dispatcher; the acceptance test for sh-1-10 covers the rolled-up
// Phase 1 scenarios.

import {
  isSessionId,
  isJobId,
  isSkillRunId,
} from "./ids.js";

/**
 * @typedef {object} SnapshotBundle
 * @property {object[]} sessions  Partial SessionRecord[] (TDD §6.1) in FIFO order.
 * @property {object[]} jobs      Partial JobRecord[]     (TDD §6.4) in FIFO order.
 * @property {object[]} skillRuns Partial SkillRunRecord[]               in FIFO order.
 */

export class RuntimeProjection {
  constructor() {
    /** @type {Map<string, object>} session id -> SessionRecord (partial) */
    this.sessions = new Map();
    /** @type {Map<string, object>} job id -> JobRecord (partial) */
    this.jobs = new Map();
    /** @type {Map<string, object>} skill run id -> SkillRunRecord (partial) */
    this.skillRuns = new Map();
    /** @type {Set<string>} dedupe set for evt_ ids already absorbed */
    this.seenEventIds = new Set();
    /** insertion order helpers for FIFO snapshots */
    /** @type {string[]} */ this.sessionOrder = [];
    /** @type {string[]} */ this.jobOrder = [];
    /** @type {string[]} */ this.skillRunOrder = [];
    /** monotonic counter that ticks per *accepted* (non-duplicate) apply() */
    this.rev = 0;
  }

  /**
   * Absorb a RuntimeEvent into the projection. Synchronous, mutates internal
   * Maps in place, returns void.
   *
   *   - Non-object input: ignored.
   *   - Duplicate evt_ id: ignored (rev does NOT tick).
   *   - Unknown event type: rev ticks, no state change.
   *
   * Schema validation is the caller's responsibility (sh-1-02
   * `validateRuntimeEvent`). This method is defensive about missing fields
   * but never throws on event content.
   *
   * @param {object} event
   * @returns {void}
   */
  apply(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const id = event.id;
    if (typeof id === "string") {
      if (this.seenEventIds.has(id)) return; // idempotent replay
      this.seenEventIds.add(id);
    }
    const handler = HANDLERS[event.type];
    if (handler) handler(this, event);
    this.rev += 1;
  }

  /**
   * Return three derived snapshots in FIFO arrival order. Each call returns a
   * fresh array (defensive copy of the order index) holding references to the
   * internal record objects — callers should treat them as read-only.
   *
   * @returns {SnapshotBundle}
   */
  toSnapshots() {
    return {
      sessions: this.sessionOrder.map((id) => this.sessions.get(id)).filter(Boolean),
      jobs: this.jobOrder.map((id) => this.jobs.get(id)).filter(Boolean),
      skillRuns: this.skillRunOrder.map((id) => this.skillRuns.get(id)).filter(Boolean),
    };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher table. Frozen for inspection/testing.
//
// Only the events implemented by Phase 1 are handled here. Generic / future
// variants (attention, conflict, sandbox, etc.) fall through as no-ops; later
// sh-X-XX tasks add handlers as their subsystems land.
// ---------------------------------------------------------------------------

const HANDLERS = Object.freeze({
  "session.started": handleSessionStarted,
  "session.status": handleSessionStatus,
  "session.warning": handleSessionWarning,
  "session.warning_cleared": handleSessionWarningCleared,
  "session.output": handleSessionOutput,
  "session.stopped": handleSessionStopped,
  "session.stdio_capture_changed": handleSessionStdioCaptureChanged,
  "job.started": handleJobStarted,
  "job.checkpoint": handleJobCheckpoint,
  "job.completed": handleJobCompleted,
  "job.queued": handleJobQueued,
  "job.unblocked": handleJobUnblocked,
  "job.rollover_requested": handleJobRolloverRequested,
  "skill.run.started": handleSkillRunStarted,
  "skill.run.finished": handleSkillRunFinished,
});

// --- session handlers ------------------------------------------------------

function handleSessionStarted(p, e) {
  const session = e.session || {};
  const id = session.id;
  if (!isSessionId(id)) return;
  const existing = p.sessions.get(id);
  if (!existing) p.sessionOrder.push(id);
  p.sessions.set(id, {
    ...(existing || {}),
    id,
    name: session.name,
    tier: session.tier,
    ...(session.projectSlug !== undefined ? { projectSlug: session.projectSlug } : {}),
    ...(session.taskId !== undefined ? { taskId: session.taskId } : {}),
    status: "starting",
    statusSource: { kind: e.source, eventId: e.id, eventType: e.type },
    startedAt: e.ts,
    ...(session.lastOutputAt !== undefined ? { lastOutputAt: session.lastOutputAt } : {}),
    ...(session.lastStructuredEventAt !== undefined ? { lastStructuredEventAt: session.lastStructuredEventAt } : {}),
    warnings: existing?.warnings || [],
  });
}

function handleSessionStatus(p, e) {
  const id = e.sessionId;
  if (!isSessionId(id)) return;
  const existing = p.sessions.get(id);
  if (!existing) return; // out-of-order / stale — ignore
  p.sessions.set(id, {
    ...existing,
    status: e.status,
    statusSource: { kind: e.source, eventId: e.id, eventType: e.type },
    lastActivityAt: e.ts,
  });
}

function handleSessionWarning(p, e) {
  const id = e.sessionId;
  if (!isSessionId(id)) return;
  const existing = p.sessions.get(id);
  if (!existing) return;
  if (!e.warning || typeof e.warning !== "object") return;
  const warnings = Array.isArray(existing.warnings) ? existing.warnings.slice() : [];
  warnings.push({ ...e.warning });
  p.sessions.set(id, { ...existing, warnings });
}

function handleSessionWarningCleared(p, e) {
  const id = e.sessionId;
  if (!isSessionId(id)) return;
  const existing = p.sessions.get(id);
  if (!existing) return;
  const kind = e.warningKind;
  if (!kind) return;
  const warnings = Array.isArray(existing.warnings)
    ? existing.warnings.filter((w) => w && w.kind !== kind)
    : [];
  p.sessions.set(id, { ...existing, warnings });
}

function handleSessionOutput(p, e) {
  const id = e.sessionId;
  if (!isSessionId(id)) return;
  const existing = p.sessions.get(id);
  if (!existing) return;
  const next = {
    ...existing,
    lastActivityAt: e.ts,
  };
  if (e.stream === "stdout" || e.stream === "stderr") {
    next.lastOutputAt = e.ts;
  }
  if (e.stream === "structured") {
    next.lastStructuredEventAt = e.ts;
  }
  p.sessions.set(id, next);
}

function handleSessionStopped(p, e) {
  const id = e.sessionId;
  if (!isSessionId(id)) return;
  const existing = p.sessions.get(id);
  if (!existing) return;
  p.sessions.set(id, {
    ...existing,
    status: "stopped",
    statusSource: { kind: e.source, eventId: e.id, eventType: e.type },
    stoppedAt: e.ts,
    ...(typeof e.reason === "string" ? { stopReason: e.reason } : {}),
    ...(Number.isInteger(e.exitCode) ? { exitCode: e.exitCode } : {}),
  });
}

function handleSessionStdioCaptureChanged(p, e) {
  const id = e.sessionId;
  if (!isSessionId(id)) return;
  const existing = p.sessions.get(id);
  if (!existing) return;
  // Schema field is `capture` (object); we keep the whole object for fidelity.
  p.sessions.set(id, {
    ...existing,
    stdioCapture: e.capture && typeof e.capture === "object" ? { ...e.capture } : existing.stdioCapture,
  });
}

// --- job handlers ----------------------------------------------------------

function handleJobStarted(p, e) {
  const id = e.jobId;
  if (!isJobId(id)) return;
  const existing = p.jobs.get(id);
  if (!existing) p.jobOrder.push(id);
  // SH-5-04: verifyPack is deeply frozen by stampVerifyPack() before append,
  // so passing the reference through subsequent spread-based handlers cannot
  // mutate the stamp. DoD §11.6.1 line 4: later patches to task.verify must
  // not widen or alter the in-flight pack.
  p.jobs.set(id, {
    ...(existing || {}),
    id,
    ...(isSessionId(e.sessionId) ? { sessionId: e.sessionId } : {}),
    ...(e.projectSlug !== undefined ? { projectSlug: e.projectSlug } : {}),
    ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
    ...(e.profileId !== undefined ? { profileId: e.profileId } : {}),
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.verifyPack && typeof e.verifyPack === "object" ? { verifyPack: e.verifyPack } : {}),
    status: "running",
    startedAt: e.ts,
  });
}

function handleJobCheckpoint(p, e) {
  const id = e.jobId;
  if (!isJobId(id)) return;
  const existing = p.jobs.get(id);
  if (!existing) return;
  p.jobs.set(id, {
    ...existing,
    lastActivityAt: e.ts,
    ...(typeof e.status === "string" ? { status: e.status } : {}),
    ...(typeof e.summary === "string" ? { lastCheckpointSummary: e.summary } : {}),
  });
}

function handleJobCompleted(p, e) {
  const id = e.jobId;
  if (!isJobId(id)) return;
  const existing = p.jobs.get(id);
  if (!existing) return;
  p.jobs.set(id, {
    ...existing,
    status: e.status || "completed",
    completedAt: e.ts,
    ...(typeof e.summary === "string" ? { summary: e.summary } : {}),
  });
}

function handleJobQueued(p, e) {
  // job.queued upserts what the SH-5-01 + SH-5-04 strict variant carries:
  // jobId (required), sessionId, projectSlug, taskId, profileId, kind,
  // predecessorJobId, and the immutable SH-5-04 verifyPack stamp. The pack
  // is deeply frozen by stampVerifyPack(), so passing the reference through
  // is safe for subsequent ...existing spreads in handleJobCheckpoint et al.
  const id = e.jobId;
  if (!isJobId(id)) return;
  const existing = p.jobs.get(id);
  if (!existing) p.jobOrder.push(id);
  p.jobs.set(id, {
    ...(existing || {}),
    id,
    ...(isSessionId(e.sessionId) ? { sessionId: e.sessionId } : {}),
    ...(e.projectSlug !== undefined ? { projectSlug: e.projectSlug } : {}),
    ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
    ...(e.profileId !== undefined ? { profileId: e.profileId } : {}),
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(isJobId(e.predecessorJobId) ? { predecessorJobId: e.predecessorJobId } : {}),
    ...(e.verifyPack && typeof e.verifyPack === "object" ? { verifyPack: e.verifyPack } : {}),
    status: "queued",
    queuedAt: e.ts,
  });
}

function handleJobUnblocked(p, e) {
  const id = e.jobId;
  if (!isJobId(id)) return;
  const existing = p.jobs.get(id);
  if (!existing) return;
  p.jobs.set(id, {
    ...existing,
    status: "running",
    lastActivityAt: e.ts,
  });
}

function handleJobRolloverRequested(p, e) {
  const id = e.jobId;
  if (!isJobId(id)) return;
  const existing = p.jobs.get(id);
  if (!existing) return;
  p.jobs.set(id, {
    ...existing,
    rolloverRequestedAt: e.ts,
    ...(typeof e.reason === "string" ? { rolloverReason: e.reason } : {}),
  });
}

// --- skill run handlers ----------------------------------------------------

function handleSkillRunStarted(p, e) {
  const id = e.skillRunId;
  if (!isSkillRunId(id)) return;
  const existing = p.skillRuns.get(id);
  if (!existing) p.skillRunOrder.push(id);
  p.skillRuns.set(id, {
    ...(existing || {}),
    id,
    ...(typeof e.skillId === "string" ? { skillId: e.skillId } : {}),
    ...(isJobId(e.jobId) ? { jobId: e.jobId } : {}),
    ...(isSessionId(e.sessionId) ? { sessionId: e.sessionId } : {}),
    status: "running",
    startedAt: e.ts,
  });
}

function handleSkillRunFinished(p, e) {
  const id = e.skillRunId;
  // skill.run.finished is allowed even if started wasn't seen — upsert.
  if (!isSkillRunId(id)) return;
  const existing = p.skillRuns.get(id);
  if (!existing) p.skillRunOrder.push(id);
  p.skillRuns.set(id, {
    ...(existing || { id }),
    ...(typeof e.skillId === "string" ? { skillId: e.skillId } : {}),
    ...(isJobId(e.jobId) ? { jobId: e.jobId } : {}),
    ...(isSessionId(e.sessionId) ? { sessionId: e.sessionId } : {}),
    status: e.status || "succeeded",
    finishedAt: e.ts,
    ...(typeof e.summary === "string" ? { summary: e.summary } : {}),
  });
}

export { HANDLERS };
