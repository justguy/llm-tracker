// hub/run-session/task-claim.js — SH-3-04 (TDD v0.5 §8A.1, §6.6, PRD §6.7)
//
// Pure-policy module: "can this Run Session launch claim this task right now?"
//
// Encapsulates the three rules from TDD §8A.1 ("Task claim semantics"):
//   1. The caller's `expectedTrackerRev` (when supplied) must match the
//      authoritative `currentTrackerRev`, otherwise the launch must be
//      rejected with a stale-rev error so the UI can re-fetch.
//   2. `claimMode` selects between three behaviours when an active job
//      already owns the (projectSlug, taskId) pair:
//        - fail_if_active  — refuse with task_claim_conflict
//        - join            — attach to the predecessor's session
//        - force           — pre-empt the predecessor (audit trail required)
//   3. `force` is a destructive verb; the policy refuses to authorise it
//      without a non-empty `forceReason` and returns an override-event
//      descriptor that the RunSessionService (SH-3-05) will append to the
//      runtime log via `human.override`.
//
// The output is a frozen descriptor; the module performs no I/O, mutates no
// state, and imports nothing from the runtime layer or the registries. The
// future RunSessionService (SH-3-05) consumes the descriptor to (a) decide
// which RunLaunchResult variant to return on POST /api/run-session/launch and
// (b) when forced, build a full RuntimeEvent (schemaVersion/id/ts/workspace
// + this descriptor's overrideEvent payload) and pass it to
// `runtimeStore.append`.

/**
 * @typedef {"fail_if_active" | "join" | "force"} ClaimMode
 */

/**
 * Accepted claim modes for `evaluateTaskClaim`. Frozen so callers can rely on
 * identity. Order mirrors TDD §8A.1's RunLaunchResult union (fail → join → force).
 */
export const CLAIM_MODES = Object.freeze(["fail_if_active", "join", "force"]);

/**
 * Job statuses that terminate a job's lifecycle. A job in one of these states
 * does NOT block a fresh claim on the same (projectSlug, taskId).
 *
 * Duplicated (rather than imported from hub/jobs/registry.js) on purpose:
 * task-claim is the pure-policy half of the Run Session funnel and stays
 * dependency-free so it can be unit-tested in isolation. The two lists must
 * be kept in lockstep — see hub/jobs/registry.js TERMINAL_JOB_STATUS.
 */
const TERMINAL_JOB_STATUS = Object.freeze([
  "completed",
  "cancelled",
  "rolled_over",
]);

/**
 * String / type guard for `ClaimMode`.
 *
 * @param {unknown} value
 * @returns {value is ClaimMode}
 */
export function isClaimMode(value) {
  return typeof value === "string" && CLAIM_MODES.includes(/** @type {ClaimMode} */ (value));
}

/**
 * @typedef {object} ActiveJobSnapshot
 * @property {string} id
 * @property {string} projectSlug
 * @property {string} taskId
 * @property {string} status
 */

/**
 * @typedef {object} ClaimInput
 * @property {string} projectSlug
 * @property {string} taskId
 * @property {ClaimMode} [claimMode] default `"fail_if_active"`
 * @property {number} [expectedTrackerRev] when present, must equal `currentTrackerRev`
 * @property {number} currentTrackerRev authoritative tracker revision (non-negative integer)
 * @property {ActiveJobSnapshot[]} activeJobs job snapshots, e.g. from `JobRegistry.list()`. An "active" job is one whose status is not in `{completed, cancelled, rolled_over}`.
 * @property {string} [forceReason] required iff `claimMode === "force"`
 * @property {string} [forceUser] opaque actor id, recorded on the override event when supplied
 */

/**
 * @typedef {object} ClaimOverrideEvent
 * @property {"human.override"} type
 * @property {string} source the caller may override before append — task-claim emits `"system"` because it has no transport context. RunSessionService should set this to `"http"` (or whichever ingress is firing the launch) before appending.
 * @property {string} reason
 * @property {string} [user]
 * @property {{
 *   kind: "task_claim_force";
 *   projectSlug: string;
 *   taskId: string;
 *   preemptedJobId: string | null;
 *   expectedTrackerRev?: number;
 *   observedTrackerRev: number;
 * }} context
 */

/**
 * @typedef {object} ClaimAllowResult
 * @property {true} ok
 * @property {"created" | "joined" | "forced"} mode
 * @property {string | null} activeJobId predecessor we joined or stomped; null when `mode === "created"`
 * @property {ClaimOverrideEvent | null} overrideEvent present iff `mode === "forced"`
 */

/**
 * @typedef {object} ClaimRejectResult
 * @property {false} ok
 * @property {"stale_tracker_rev" | "task_claim_conflict" | "force_requires_reason" | "invalid_input"} error
 * @property {number} [currentRev] set when `error === "stale_tracker_rev"`
 * @property {string} [activeJobId] set when `error === "task_claim_conflict"`
 * @property {string} [detail] human-readable diagnostic for `force_requires_reason` and `invalid_input`
 */

/**
 * @typedef {ClaimAllowResult | ClaimRejectResult} ClaimResult
 */

/**
 * Deep-freeze a plain object/array tree. The caller treats `ClaimResult`s
 * as immutable descriptors; freezing here protects against accidental
 * mutation by the consumer (RunSessionService) or test code.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function freezeDeep(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    freezeDeep(/** @type {any} */ (value)[key]);
  }
  return Object.freeze(value);
}

/**
 * Build a frozen reject descriptor with `error: "invalid_input"`.
 *
 * @param {string} detail
 * @returns {ClaimRejectResult}
 */
function invalidInput(detail) {
  return freezeDeep({ ok: false, error: "invalid_input", detail });
}

/**
 * Predicate: a non-negative safe integer.
 *
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Predicate: a non-empty string.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Evaluate whether a Run Session launch may claim a task. Pure: no I/O, no
 * mutation. Returns a frozen `ClaimResult` (see typedefs above for shape and
 * RunLaunchResult mapping).
 *
 * Mode semantics:
 *   - `fail_if_active` (default): refuse if an active job exists, else create.
 *   - `join`: if an active job exists return `joined`, else fall through to
 *     `created` (joining nothing is the same as creating).
 *   - `force`: ALWAYS succeeds with audit, regardless of an existing job. The
 *     `forceReason` requirement is enforced unconditionally so the
 *     human.override audit trail is never empty. The caller (RunSessionService,
 *     SH-3-05) stamps schemaVersion/id/ts/workspace on `overrideEvent` before
 *     calling `runtimeStore.append`.
 *
 * @param {ClaimInput} input
 * @returns {ClaimResult}
 */
export function evaluateTaskClaim(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalidInput("input must be an object");
  }
  const {
    projectSlug,
    taskId,
    claimMode,
    expectedTrackerRev,
    currentTrackerRev,
    activeJobs,
    forceReason,
    forceUser,
  } = input;

  // --- shape validation ------------------------------------------------------
  if (!isNonEmptyString(projectSlug)) {
    return invalidInput("projectSlug must be a non-empty string");
  }
  if (!isNonEmptyString(taskId)) {
    return invalidInput("taskId must be a non-empty string");
  }
  if (!isNonNegativeInt(currentTrackerRev)) {
    return invalidInput("currentTrackerRev must be a non-negative integer");
  }
  if (!Array.isArray(activeJobs)) {
    return invalidInput("activeJobs must be an array");
  }
  if (expectedTrackerRev !== undefined && !isNonNegativeInt(expectedTrackerRev)) {
    return invalidInput("expectedTrackerRev must be a non-negative integer when present");
  }
  const mode = claimMode === undefined ? "fail_if_active" : claimMode;
  if (!isClaimMode(mode)) {
    return invalidInput(`claimMode must be one of ${CLAIM_MODES.join("|")}`);
  }

  // --- DoD 1: expectedTrackerRev gate --------------------------------------
  if (expectedTrackerRev !== undefined && expectedTrackerRev !== currentTrackerRev) {
    return freezeDeep({
      ok: false,
      error: "stale_tracker_rev",
      currentRev: currentTrackerRev,
    });
  }

  // --- active-job lookup ---------------------------------------------------
  // Find the first matching (projectSlug, taskId) job whose status is NOT
  // terminal. Policy assumes at most one such job; if multiple match we pick
  // the first by array order — the registry / projection are expected to
  // maintain the invariant, but we stay defensive.
  const active = activeJobs.find(
    (job) =>
      job &&
      job.projectSlug === projectSlug &&
      job.taskId === taskId &&
      !TERMINAL_JOB_STATUS.includes(job.status),
  );
  const activeJobId = active ? active.id : null;

  // --- DoD 2: mode dispatch ------------------------------------------------
  if (mode === "fail_if_active") {
    if (activeJobId) {
      return freezeDeep({
        ok: false,
        error: "task_claim_conflict",
        activeJobId,
      });
    }
    return freezeDeep({
      ok: true,
      mode: "created",
      activeJobId: null,
      overrideEvent: null,
    });
  }

  if (mode === "join") {
    if (activeJobId) {
      return freezeDeep({
        ok: true,
        mode: "joined",
        activeJobId,
        overrideEvent: null,
      });
    }
    // join with nothing to join → behaves like create (documented above).
    return freezeDeep({
      ok: true,
      mode: "created",
      activeJobId: null,
      overrideEvent: null,
    });
  }

  // --- DoD 3: force requires reason ---------------------------------------
  // `mode === "force"` past this point. `force` is the only verb that may
  // pre-empt an active job; we therefore require an auditable reason.
  if (!isNonEmptyString(forceReason)) {
    return freezeDeep({
      ok: false,
      error: "force_requires_reason",
      detail: "claimMode 'force' requires a non-empty reason",
    });
  }

  /** @type {ClaimOverrideEvent} */
  const overrideEvent = {
    type: "human.override",
    source: "system",
    reason: forceReason,
    ...(isNonEmptyString(forceUser) ? { user: forceUser } : {}),
    context: {
      kind: "task_claim_force",
      projectSlug,
      taskId,
      preemptedJobId: activeJobId,
      ...(expectedTrackerRev !== undefined ? { expectedTrackerRev } : {}),
      observedTrackerRev: currentTrackerRev,
    },
  };

  return freezeDeep({
    ok: true,
    mode: "forced",
    activeJobId,
    overrideEvent,
  });
}
