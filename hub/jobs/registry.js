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
//     append-only log is authoritative.
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
   * Create a new JobRecord.
   *
   * Routes to `job.started` (status `running`) when no `predecessorJobId` is
   * supplied, and to `job.queued` (status `queued`) when one is supplied —
   * matching TDD §23.2 #35 and the JobQueuedEvent variant in §6.6.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} input.projectSlug
   * @param {string} input.taskId
   * @param {string} input.profileId
   * @param {JobKind} input.kind
   * @param {string} [input.predecessorJobId]
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
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    this.validateRuntimeEvent(eventForValidation);

    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
    const result = await this.runtimeStore.append(eventForAppend);
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

    return this.#appendEvent({
      type: "job.checkpoint",
      source,
      jobId,
      sessionId: existing.sessionId,
      ...(status ? { status } : {}),
      ...(summary ? { summary } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
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

    return this.#appendEvent({
      type: "job.completed",
      source,
      jobId,
      sessionId: existing.sessionId,
      status,
      ...(summary ? { summary } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
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
   * Transition a `blocked` job back to `running`. Mirrors `JobUnblockedEvent`
   * in §6.6 / the projection's handleJobUnblocked.
   *
   * @param {string} jobId
   * @param {{ source?: string; idempotencyKey?: string }} [input]
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
    const { source = "system", idempotencyKey } = input || {};
    return this.#appendEvent({
      type: "job.unblocked",
      source,
      jobId,
      sessionId: existing.sessionId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
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
}
