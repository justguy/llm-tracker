// hub/jobs/registry.js — SH-5-01 (TDD v0.5 §6.4, §6.6, §23.2 #35)
//
// JobRegistry — domain service for JobRecord-shaped CRUD over the runtime
// layer. Mirrors hub/sessions/registry.js (SH-2-01) in structure: reads come
// from RuntimeProjection.jobs; mutations flow exclusively through
// runtimeStore.append, which feeds the same projection. The registry never
// mutates the projection directly.
//
// What this module is responsible for:
//   - Validating create/transition input against the v0.7 JobRecord shape
//     (TDD §6.4): id, projectSlug, taskId, sessionId, profileId, kind plus
//     status transitions through the enum.
//   - Choosing the right emission verb at create time: a job with no
//     predecessor opens as `running` via a `job.started` event; a job that
//     queues behind an active sibling opens as `queued` via `job.queued`
//     carrying `predecessorJobId` (TDD §23.2 #35, JobQueuedEvent in §6.6).
//   - Emitting one event per status transition (`job.checkpoint`,
//     `job.completed`, `job.rollover_requested`, `job.unblocked`) so the
//     append-only log is authoritative. `unblock(reason, previousReason,
//     user)` (SH-5-16) may emit a follow-up `job.checkpoint` with
//     `status: "queued"` when the unblocked job's predecessor is still active
//     — keeps the projection's queued/running invariant without touching the
//     §6.6 schema.
//   - Guarding terminal state: once a job lands in `completed | cancelled |
//     rolled_over`, no further transitions are accepted.
//   - Deriving `successorJobId` on read by scanning `predecessorJobId`
//     backrefs across the projection — keeps the runtime schema unchanged
//     while still satisfying the DoD's "predecessor/successor links" line.
//
// What this module does NOT do:
//   - HTTP routing (lives in hub/api/jobs.js; SH-5-09 owns lifecycle routes).
//   - Auto-starting queued successors after a predecessor completes. That
//     belongs to the AttachTask flow (SH-3-21) / lifecycle endpoints (SH-5-09)
//     and the queue grace timer; the registry exposes the emit primitives
//     those callers will need.
//   - Mutating `SessionRecord.queuedJobIds` when a job queues. That mirror is
//     owned by SessionRegistry (Track 1 territory) and updated by the same
//     attach flow.
//   - VerifyPack composition / skill plan generation. The registry stores
//     `completionGates` and `skillPlan` slots in the create event payload so
//     they ride through to the projection, but the values are supplied by
//     SH-5-04 (verify pack) and SH-5-03 (skill plan).

import { isJobId, isSessionId } from "../runtime/ids.js";
import { findMissingRequiredGates } from "./gates.js";
import { collectReadyHumanApprovalRequests } from "./verify-pack.js";

/**
 * @typedef {"queued" | "starting" | "running" | "blocked" | "verifying" | "completed" | "cancelled" | "rolled_over"} JobStatus
 */

/**
 * @typedef {"code" | "prd" | "review" | "planning" | "closeout" | "custom"} JobKind
 */

/** Full TDD §6.4 status enum. Frozen so callers can rely on identity. */
export const ALLOWED_JOB_STATUS = Object.freeze([
  "queued",
  "starting",
  "running",
  "blocked",
  "verifying",
  "completed",
  "cancelled",
  "rolled_over",
]);

/** TDD §6.4 kind enum. Frozen. */
export const ALLOWED_JOB_KIND = Object.freeze([
  "code",
  "prd",
  "review",
  "planning",
  "closeout",
  "custom",
]);

/**
 * Statuses that terminate a job's lifecycle. Once a JobRecord reaches one of
 * these states the registry rejects further transitions; the only way to do
 * more work on the same task is to create a new job (e.g. a rollover
 * successor).
 */
export const TERMINAL_JOB_STATUS = Object.freeze([
  "completed",
  "cancelled",
  "rolled_over",
]);

/** Status enum for the strict `job.completed` event variant in §6.6. */
const COMPLETION_EVENT_STATUS = Object.freeze([
  "completed",
  "cancelled",
  "rolled_over",
]);

/**
 * Build a registry-shaped Error. The `code` field is the stable contract for
 * HTTP/CLI/WS layers; the message is for humans.
 *
 * @param {string} message
 * @param {string} code
 * @param {object} [details]
 * @returns {Error & { code: string; details?: object }}
 */
function makeError(message, code, details) {
  const err = /** @type {any} */ (new Error(message));
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Assert that `value` is a non-empty string.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {string} context
 * @returns {string}
 */
function assertNonEmptyString(value, field, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw makeError(
      `${context}: ${field} required (non-empty string)`,
      "INVALID_INPUT",
      { field },
    );
  }
  return value;
}

/**
 * @typedef {object} JobRegistryDeps
 * @property {{ append: (event: object) => Promise<{ ok: true; eventId: string; rev: number }> }} runtimeStore
 * @property {{ jobs: Map<string, object>; toSnapshots(): { jobs: object[] } }} projection
 * @property {(prefix: string) => string} makeRuntimeId
 * @property {(event: object) => true} validateRuntimeEvent
 * @property {string} workspace
 * @property {() => string} [now]
 */

/**
 * Domain service: job-shaped CRUD over the runtime layer.
 */
export class JobRegistry {
  /**
   * @param {JobRegistryDeps} deps
   */
  constructor(deps) {
    const { runtimeStore, projection, makeRuntimeId, validateRuntimeEvent, workspace, now } = deps || {};
    if (!runtimeStore || typeof runtimeStore.append !== "function") {
      throw new Error("JobRegistry: runtimeStore (with append) required");
    }
    if (!projection || !(projection.jobs instanceof Map) || typeof projection.toSnapshots !== "function") {
      throw new Error("JobRegistry: projection (with jobs Map + toSnapshots) required");
    }
    if (typeof makeRuntimeId !== "function") {
      throw new Error("JobRegistry: makeRuntimeId function required");
    }
    if (typeof validateRuntimeEvent !== "function") {
      throw new Error("JobRegistry: validateRuntimeEvent function required");
    }
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("JobRegistry: workspace string required");
    }
    this.runtimeStore = runtimeStore;
    this.projection = projection;
    this.makeRuntimeId = makeRuntimeId;
    this.validateRuntimeEvent = validateRuntimeEvent;
    this.workspace = workspace;
    this.now = typeof now === "function" ? now : () => new Date().toISOString();
    /** @type {Set<(payload: { jobId: string; sessionId?: string; previousStatus?: string; status?: string; result: object }) => void>} */
    this.jobCompletedListeners = new Set();
  }

  /**
   * Snapshot of every job in FIFO arrival order, each enriched with a
   * derived `successorJobId` when another job declares this one as its
   * predecessor.
   *
   * @returns {object[]}
   */
  list() {
    const successorByPredecessor = this.#buildSuccessorIndex();
    return this.projection.toSnapshots().jobs.map((job) => this.#enrich(job, successorByPredecessor));
  }

  /**
   * Look up a single job by id. Returns null when no such job exists.
   *
   * @param {string} jobId
   * @returns {object | null}
   */
  get(jobId) {
    if (typeof jobId !== "string") return null;
    const raw = this.projection.jobs.get(jobId);
    if (!raw) return null;
    return this.#enrich(raw, this.#buildSuccessorIndex());
  }

  /**
   * Every job currently associated with a session, in projection-FIFO order.
   *
   * @param {string} sessionId
   * @returns {object[]}
   */
  listBySession(sessionId) {
    if (typeof sessionId !== "string") return [];
    return this.list().filter((job) => job.sessionId === sessionId);
  }

  /**
   * Subscribe to terminal job completion events emitted through this registry.
   * Used by session attach queue orchestration to auto-start successors after
   * the configured grace period.
   *
   * @param {(payload: { jobId: string; sessionId?: string; previousStatus?: string; status?: string; result: object }) => void} listener
   * @returns {() => void}
   */
  onJobCompleted(listener) {
    if (typeof listener !== "function") {
      throw makeError("onJobCompleted: listener must be a function", "INVALID_INPUT", { field: "listener" });
    }
    this.jobCompletedListeners.add(listener);
    return () => {
      this.jobCompletedListeners.delete(listener);
    };
  }

  /**
   * Create a new JobRecord.
   *
   * Routes to `job.started` (status `running`) when no `predecessorJobId` is
   * supplied, and to `job.queued` (status `queued`) when one is supplied —
   * matching TDD §23.2 #35 and the JobQueuedEvent variant in §6.6.
   *
   * SH-5-04: optional `verifyPack` rides through the create event into the
   * projection, stamping an immutable VerifyPack onto the JobRecord. The
   * pack must be a plain object with a non-empty `items` array; item-shape
   * is already validated by SH-5-07's `stampVerifyPack`, so we don't
   * re-validate here. `completionGates` and `skillPlan` slots (mentioned in
   * the module preamble) remain unwired — see SH-5-03 follow-up.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} input.projectSlug
   * @param {string} input.taskId
   * @param {string} input.profileId
   * @param {JobKind} input.kind
   * @param {string} [input.predecessorJobId]
   * @param {object} [input.verifyPack]      Immutable VerifyPack from SH-5-04.
   * @param {string} [input.source]
   * @param {string} [input.idempotencyKey]
   * @returns {Promise<{ jobId: string; rev: number; eventId: string; job: object | null }>}
   */
  async create(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw makeError("create: input must be an object", "INVALID_INPUT");
    }
    const {
      sessionId,
      projectSlug,
      taskId,
      profileId,
      kind,
      predecessorJobId,
      verifyPack,
      source = "system",
      idempotencyKey,
    } = input;

    if (typeof sessionId !== "string" || !isSessionId(sessionId)) {
      throw makeError("create: sessionId must be a ses_ id", "INVALID_SESSION_ID", { value: sessionId });
    }
    assertNonEmptyString(projectSlug, "projectSlug", "create");
    assertNonEmptyString(taskId, "taskId", "create");
    assertNonEmptyString(profileId, "profileId", "create");
    if (typeof kind !== "string" || !ALLOWED_JOB_KIND.includes(/** @type {JobKind} */ (kind))) {
      throw makeError(
        `create: kind '${kind}' not in ${ALLOWED_JOB_KIND.join("|")}`,
        "INVALID_JOB_KIND",
        { allowed: [...ALLOWED_JOB_KIND] },
      );
    }
    if (predecessorJobId !== undefined) {
      if (typeof predecessorJobId !== "string" || !isJobId(predecessorJobId)) {
        throw makeError("create: predecessorJobId must be a job_ id", "INVALID_PREDECESSOR_ID", { value: predecessorJobId });
      }
      const predecessor = this.projection.jobs.get(predecessorJobId);
      if (!predecessor) {
        throw makeError(
          `create: predecessor '${predecessorJobId}' not found`,
          "UNKNOWN_PREDECESSOR",
          { predecessorJobId },
        );
      }
    }
    if (verifyPack !== undefined) {
      if (
        !verifyPack ||
        typeof verifyPack !== "object" ||
        Array.isArray(verifyPack) ||
        !Array.isArray(verifyPack.items) ||
        verifyPack.items.length === 0
      ) {
        throw makeError(
          "create: verifyPack must be an object with a non-empty items array",
          "INVALID_INPUT",
          { field: "verifyPack" },
        );
      }
    }

    const jobId = this.makeRuntimeId("job");
    const queued = predecessorJobId !== undefined;
    const eventType = queued ? "job.queued" : "job.started";

    const eventForValidation = {
      schemaVersion: 1,
      id: this.makeRuntimeId("evt"),
      ts: this.now(),
      type: eventType,
      source,
      workspace: this.workspace,
      jobId,
      sessionId,
      projectSlug,
      taskId,
      profileId,
      kind,
      ...(queued ? { predecessorJobId } : {}),
      ...(verifyPack !== undefined ? { verifyPack } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    this.validateRuntimeEvent(eventForValidation);

    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
    const result = await this.runtimeStore.append(eventForAppend);
    if (!queued) {
      await this.#emitReadyHumanApprovalRequests({ jobId, source });
    }
    return {
      jobId,
      rev: result.rev,
      eventId: result.eventId,
      job: this.get(jobId),
    };
  }

  /**
   * Record a checkpoint on an existing job. Status, when supplied, must be
   * a non-terminal value — use `complete()` or `cancel()` to terminate.
   *
   * @param {string} jobId
   * @param {object} [input]
   * @param {JobStatus} [input.status]
   * @param {string} [input.summary]
   * @param {string} [input.source="system"]
   * @param {string} [input.idempotencyKey]
   * @returns {Promise<{ rev: number; eventId: string; job: object | null }>}
   */
  async checkpoint(jobId, input = {}) {
    const existing = this.#assertActive(jobId, "checkpoint");
    if (input && typeof input !== "object") {
      throw makeError("checkpoint: input must be an object", "INVALID_INPUT");
    }
    const { status, summary, source = "system", idempotencyKey } = input || {};

    if (status !== undefined) {
      if (!ALLOWED_JOB_STATUS.includes(/** @type {JobStatus} */ (status))) {
        throw makeError(
          `checkpoint: status '${status}' not in ${ALLOWED_JOB_STATUS.join("|")}`,
          "INVALID_JOB_STATUS",
          { allowed: [...ALLOWED_JOB_STATUS] },
        );
      }
      if (TERMINAL_JOB_STATUS.includes(/** @type {JobStatus} */ (status))) {
        throw makeError(
          `checkpoint: status '${status}' is terminal — use complete/cancel`,
          "TERMINAL_STATUS_FORBIDDEN",
          { status },
        );
      }
    }
    if (summary !== undefined && (typeof summary !== "string" || summary.length === 0)) {
      throw makeError("checkpoint: summary must be a non-empty string when present", "INVALID_INPUT", { field: "summary" });
    }

    const result = await this.#appendEvent({
      type: "job.checkpoint",
      source,
      jobId,
      sessionId: existing.sessionId,
      ...(status ? { status } : {}),
      ...(summary ? { summary } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (status === "running") {
      await this.#emitReadyHumanApprovalRequests({ jobId, source });
    }
    return { ...result, job: this.get(jobId) };
  }

  /**
   * Terminate a job. Status must be one of the strict `job.completed`
   * variants: `completed`, `cancelled`, `rolled_over`.
   *
   * @param {string} jobId
   * @param {object} input
   * @param {"completed" | "cancelled" | "rolled_over"} input.status
   * @param {string} [input.summary]
   * @param {string} [input.source="system"]
   * @param {string} [input.idempotencyKey]
   * @returns {Promise<{ rev: number; eventId: string; job: object | null }>}
   */
  async complete(jobId, input) {
    const existing = this.#assertActive(jobId, "complete");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw makeError("complete: input must be an object", "INVALID_INPUT");
    }
    const { status, summary, source = "system", idempotencyKey } = input;
    if (typeof status !== "string" || !COMPLETION_EVENT_STATUS.includes(/** @type {any} */ (status))) {
      throw makeError(
        `complete: status '${status}' not in ${COMPLETION_EVENT_STATUS.join("|")}`,
        "INVALID_JOB_STATUS",
        { allowed: [...COMPLETION_EVENT_STATUS] },
      );
    }
    if (summary !== undefined && (typeof summary !== "string" || summary.length === 0)) {
      throw makeError("complete: summary must be a non-empty string when present", "INVALID_INPUT", { field: "summary" });
    }

    const result = await this.#appendEvent({
      type: "job.completed",
      source,
      jobId,
      sessionId: existing.sessionId,
      status,
      ...(summary ? { summary } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    this.#notifyJobCompleted({
      jobId,
      sessionId: existing.sessionId,
      previousStatus: existing.status,
      status,
      result,
    });
    return result;
  }

  /**
   * Complete a job by recording an explicit HumanOverrideEvent for the
   * currently missing required completion gates, then emitting job.completed.
   * The runtime projection consumes human.override to bind each overridden
   * gate's evidenceRef to the canonical override event id, so replay rebuilds
   * the same JobRecord state without route-owned projection mutation.
   *
   * @param {string} jobId
   * @param {object} input
   * @param {string} input.reason
   * @param {string} [input.summary]
   * @param {string} [input.user]
   * @param {string} [input.source="system"]
   * @param {string} [input.idempotencyKey]
   * @returns {Promise<{ rev: number; eventId: string; overrideEventId: string; overrideRev: number; job: object | null }>}
   */
  async completeWithOverride(jobId, input) {
    const existing = this.#assertActive(jobId, "completeWithOverride");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw makeError("completeWithOverride: input must be an object", "INVALID_INPUT");
    }
    const { reason, summary, user, source = "system", idempotencyKey } = input;
    assertNonEmptyString(reason, "reason", "completeWithOverride");
    if (summary !== undefined && (typeof summary !== "string" || summary.length === 0)) {
      throw makeError("completeWithOverride: summary must be a non-empty string when present", "INVALID_INPUT", { field: "summary" });
    }
    if (user !== undefined && (typeof user !== "string" || user.length === 0)) {
      throw makeError("completeWithOverride: user must be a non-empty string when present", "INVALID_INPUT", { field: "user" });
    }

    const missing = findMissingRequiredGates(existing);
    if (missing.length === 0) {
      throw makeError(
        `completeWithOverride: job '${jobId}' has no missing required completion gates`,
        "NO_MISSING_GATES",
        { jobId },
      );
    }
    const gateIds = missing.map((gate) => gate.id);
    if (gateIds.some((gateId) => typeof gateId !== "string" || gateId.length === 0)) {
      throw makeError(
        "completeWithOverride: every missing gate must have a non-empty id",
        "INVALID_GATE_IDS",
        { jobId },
      );
    }

    const overrideResult = await this.#appendEvent({
      type: "human.override",
      source,
      jobId,
      sessionId: existing.sessionId,
      gateIds,
      reason,
      context: {
        kind: "complete_override",
        jobId,
        ...(isSessionId(existing.sessionId) ? { sessionId: existing.sessionId } : {}),
        ...(typeof existing.projectSlug === "string" && existing.projectSlug.length > 0 ? { projectSlug: existing.projectSlug } : {}),
        ...(typeof existing.taskId === "string" && existing.taskId.length > 0 ? { taskId: existing.taskId } : {}),
      },
      overriddenGates: missing.map((gate) => ({
        ...gate,
        status: "overridden",
        overrideReason: reason,
      })),
      ...(user ? { user } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    const completeResult = await this.complete(jobId, {
      status: "completed",
      ...(summary ? { summary } : {}),
      source,
    });
    return {
      rev: completeResult.rev,
      eventId: completeResult.eventId,
      overrideEventId: overrideResult.eventId,
      overrideRev: overrideResult.rev,
      job: completeResult.job,
    };
  }

  /**
   * Convenience wrapper over `complete({ status: 'cancelled' })`.
   *
   * @param {string} jobId
   * @param {{ summary?: string; source?: string; idempotencyKey?: string }} [opts]
   * @returns {Promise<{ rev: number; eventId: string; job: object | null }>}
   */
  async cancel(jobId, opts = {}) {
    return this.complete(jobId, { status: "cancelled", ...opts });
  }

  /**
   * Record a rollover request on a job. Does not itself transition status;
   * the subsequent rollover machinery (SH-5-09 / SH-3-15) decides what
   * `job.completed` (or other) event follows.
   *
   * @param {string} jobId
   * @param {{ reason?: string; source?: string; idempotencyKey?: string }} [input]
   * @returns {Promise<{ rev: number; eventId: string; job: object | null }>}
   */
  async requestRollover(jobId, input = {}) {
    const existing = this.#assertActive(jobId, "requestRollover");
    if (input && typeof input !== "object") {
      throw makeError("requestRollover: input must be an object", "INVALID_INPUT");
    }
    const { reason, source = "system", idempotencyKey } = input || {};
    if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
      throw makeError("requestRollover: reason must be a non-empty string when present", "INVALID_INPUT", { field: "reason" });
    }

    return this.#appendEvent({
      type: "job.rollover_requested",
      source,
      jobId,
      sessionId: existing.sessionId,
      ...(reason ? { reason } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /**
   * Transition a `blocked` job back to `running` (or `queued` when a
   * non-terminal predecessor still owns the slot). Mirrors `JobUnblockedEvent`
   * in §6.6 / the projection's handleJobUnblocked.
   *
   * SH-5-16 extension: accepts `reason`, `previousReason`, and `user` as
   * optional audit fields that ride through into the `job.unblocked` payload.
   * The companion §23.2 #35 requirement — "running (or queued if the
   * predecessor is still active)" — is expressed by emitting a second event
   * (`job.checkpoint` with `status: "queued"`) when the predecessor is still
   * around; the projection's handleJobCheckpoint passes the status through
   * unchanged, so the projection invariant holds without a schema change.
   *
   * @param {string} jobId
   * @param {object} [input]
   * @param {string} [input.reason]
   * @param {string} [input.previousReason]
   * @param {string} [input.user]
   * @param {string} [input.source="system"]
   * @param {string} [input.idempotencyKey]
   * @returns {Promise<{ rev: number; eventId: string; job: object | null }>}
   */
  async unblock(jobId, input = {}) {
    const existing = this.#assertActive(jobId, "unblock");
    if (existing.status !== "blocked") {
      throw makeError(
        `unblock: job '${jobId}' status '${existing.status}' is not 'blocked'`,
        "INVALID_JOB_STATE",
        { jobId, status: existing.status },
      );
    }
    if (input && typeof input !== "object") {
      throw makeError("unblock: input must be an object", "INVALID_INPUT");
    }
    const { reason, previousReason, user, source = "system", idempotencyKey } = input || {};
    if (
      reason !== undefined &&
      (typeof reason !== "string" || reason.length === 0 || reason.length > 2000)
    ) {
      throw makeError(
        "unblock: reason must be a non-empty string ≤2000 chars when present",
        "INVALID_INPUT",
        { field: "reason" },
      );
    }
    if (
      previousReason !== undefined &&
      (typeof previousReason !== "string" || previousReason.length === 0)
    ) {
      throw makeError(
        "unblock: previousReason must be a non-empty string when present",
        "INVALID_INPUT",
        { field: "previousReason" },
      );
    }
    if (user !== undefined && (typeof user !== "string" || user.length === 0)) {
      throw makeError(
        "unblock: user must be a non-empty string when present",
        "INVALID_INPUT",
        { field: "user" },
      );
    }

    // First event: job.unblocked — projection.handleJobUnblocked flips status
    // to 'running'. This is the authoritative audit record carrying reason /
    // previousReason / user.
    const unblockResult = await this.#appendEvent({
      type: "job.unblocked",
      source,
      jobId,
      sessionId: existing.sessionId,
      ...(reason ? { reason } : {}),
      ...(previousReason ? { previousReason } : {}),
      ...(user ? { user } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    // §23.2 #35 / SH-5-16 DoD: "running (or queued if the predecessor is
    // still active)". When the predecessor is non-terminal we follow up with
    // a job.checkpoint that flips the projection back to queued. Done as a
    // secondary event (rather than a schema change) per the brief.
    const predecessorId = existing.predecessorJobId;
    if (predecessorId) {
      const predecessor = this.projection.jobs.get(predecessorId);
      if (predecessor && !TERMINAL_JOB_STATUS.includes(/** @type {any} */ (predecessor.status))) {
        await this.#appendEvent({
          type: "job.checkpoint",
          source,
          jobId,
          sessionId: existing.sessionId,
          status: "queued",
          summary: "auto-requeue: predecessor still active after unblock",
        });
      }
    }

    // Return projection record re-derived through this.get so callers see the
    // final (possibly queued) status.
    const finalJob = this.get(jobId);
    if (finalJob?.status === "running") {
      await this.#emitReadyHumanApprovalRequests({ jobId, source });
    }
    return { rev: unblockResult.rev, eventId: unblockResult.eventId, job: this.get(jobId) };
  }

  /**
   * Build a `predecessorJobId -> successorJobId` index by scanning every
   * job currently in the projection. Used by `list()`/`get()` to surface
   * successor links without storing them durably.
   *
   * @returns {Map<string, string>}
   */
  #buildSuccessorIndex() {
    /** @type {Map<string, string>} */
    const map = new Map();
    for (const [jobId, job] of this.projection.jobs) {
      const predId = job && job.predecessorJobId;
      if (typeof predId === "string" && !map.has(predId)) {
        map.set(predId, jobId);
      }
    }
    return map;
  }

  /**
   * Attach a derived `successorJobId` to a projection job record. Returns a
   * shallow clone so callers cannot mutate projection state via the result.
   *
   * @param {object} job
   * @param {Map<string, string>} successorByPredecessor
   * @returns {object}
   */
  #enrich(job, successorByPredecessor) {
    const successorJobId = successorByPredecessor.get(job.id);
    return successorJobId ? { ...job, successorJobId } : { ...job };
  }

  /**
   * Fetch a job and refuse to operate on terminal records.
   *
   * @param {string} jobId
   * @param {string} context
   * @returns {object}
   */
  #assertActive(jobId, context) {
    if (typeof jobId !== "string" || !isJobId(jobId)) {
      throw makeError(`${context}: jobId must be a job_ id`, "INVALID_JOB_ID", { value: jobId });
    }
    const existing = this.projection.jobs.get(jobId);
    if (!existing) {
      throw makeError(`${context}: unknown job '${jobId}'`, "UNKNOWN_JOB", { jobId });
    }
    if (TERMINAL_JOB_STATUS.includes(/** @type {any} */ (existing.status))) {
      throw makeError(
        `${context}: job '${jobId}' is terminal (${existing.status})`,
        "JOB_TERMINAL",
        { jobId, status: existing.status },
      );
    }
    return existing;
  }

  async #emitReadyHumanApprovalRequests({ jobId, source }) {
    const job = this.get(jobId);
    if (!job || job.status !== "running") return [];
    const requests = collectReadyHumanApprovalRequests(job);
    const results = [];
    for (const request of requests) {
      results.push(
        await this.#appendEvent({
          type: "verify.human_approval.requested",
          source,
          jobId,
          sessionId: job.sessionId,
          projectSlug: job.projectSlug,
          taskId: job.taskId,
          itemId: request.itemId,
          itemKind: "human_approval",
          required: request.required,
          blocksCompletion: request.blocksCompletion,
          title: request.title,
          ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
        }),
      );
    }
    return results;
  }

  /**
   * Common event-build / validate / append path used by every transition
   * method. Caller passes the type-specific payload; we layer on the base
   * envelope, run schema validation, and dispatch to the store.
   *
   * @param {object} payload
   * @returns {Promise<{ rev: number; eventId: string; job: object | null }>}
   */
  async #appendEvent(payload) {
    const eventForValidation = {
      schemaVersion: 1,
      id: this.makeRuntimeId("evt"),
      ts: this.now(),
      workspace: this.workspace,
      ...payload,
    };
    this.validateRuntimeEvent(eventForValidation);
    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
    const result = await this.runtimeStore.append(eventForAppend);
    return { rev: result.rev, eventId: result.eventId, job: this.get(payload.jobId) };
  }

  #notifyJobCompleted(payload) {
    for (const listener of this.jobCompletedListeners) {
      try {
        listener(payload);
      } catch {
        // Completion side effects are advisory. The terminal job event has
        // already committed; listeners must not make the primary transition
        // fail after the fact.
      }
    }
  }
}
