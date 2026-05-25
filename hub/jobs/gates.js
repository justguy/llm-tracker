// hub/jobs/gates.js — SH-5-05 (TDD v0.5 §11.5, §23.2 #12)
//
// Completion gates are the state machine between "work looks done" and
// "JobRecord may enter a terminal completed state". A gate cannot be treated
// as satisfied or overridden unless it is bound to a concrete runtime event.

import { isJobId, isRuntimeEventId, isSessionId } from "../runtime/ids.js";

export const UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING = "block_required_missing";

const SATISFYING_STATUSES = new Set(["satisfied", "overridden"]);
const TRANSITION_STATUSES = new Set(["pending", "satisfied", "failed", "overridden"]);

function makeGateError(message, code, details) {
  const err = /** @type {Error & { code: string; details?: object }} */ (new Error(message));
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function resolveUiCompleteMode(value) {
  if (value === undefined || value === null) return UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING;
  if (value === UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING) return value;
  throw makeGateError(
    `uiCompleteMode must be '${UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING}' when present`,
    "INVALID_UI_COMPLETE_MODE",
    { allowed: [UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING] },
  );
}

export function isEvidenceBound(value) {
  return isRuntimeEventId(value);
}

export function isCompletionGateSatisfied(gate) {
  if (!gate || typeof gate !== "object") return false;
  if (!SATISFYING_STATUSES.has(gate.status)) return false;
  if (!isEvidenceBound(gate.evidenceRef)) return false;
  if (gate.status === "overridden" && !isNonEmptyString(gate.overrideReason)) return false;
  return true;
}

export function findMissingRequiredGates(jobOrGates) {
  const gates = Array.isArray(jobOrGates)
    ? jobOrGates
    : Array.isArray(jobOrGates?.completionGates)
      ? jobOrGates.completionGates
      : [];
  return gates
    .filter((gate) => gate && gate.required === true && !isCompletionGateSatisfied(gate))
    .map((gate) => ({ ...gate }));
}

export function buildGatesPendingResult(jobId, missing) {
  return {
    ok: false,
    mode: "gates_pending",
    missing,
    missing_gates: missing,
    requiresOverride: true,
    uiCompleteMode: UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING,
    overridePromptUrl: `/api/jobs/${jobId}/complete-override`,
  };
}

export function transitionCompletionGate(gate, input) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    throw makeGateError("gate must be an object", "INVALID_GATE");
  }
  const { status, evidenceRef, overrideReason } = input || {};
  if (!TRANSITION_STATUSES.has(status)) {
    throw makeGateError(
      `status '${status}' is not a valid completion gate status`,
      "INVALID_GATE_STATUS",
      { allowed: [...TRANSITION_STATUSES] },
    );
  }
  if ((status === "satisfied" || status === "overridden") && !isEvidenceBound(evidenceRef)) {
    throw makeGateError(
      `${status} completion gates require evidenceRef to be a runtime event id`,
      "EVIDENCE_REF_REQUIRED",
      { status },
    );
  }
  if (status === "overridden" && !isNonEmptyString(overrideReason)) {
    throw makeGateError(
      "overridden completion gates require a non-empty overrideReason",
      "OVERRIDE_REASON_REQUIRED",
      { status },
    );
  }

  const next = { ...gate, status };
  if (status === "satisfied" || status === "overridden") next.evidenceRef = evidenceRef;
  if (status === "overridden") next.overrideReason = overrideReason;
  return next;
}

export function buildOverriddenCompletionGates(job, input) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw makeGateError("job must be an object", "INVALID_JOB");
  }
  const { evidenceRef, reason } = input || {};
  const gates = Array.isArray(job.completionGates) ? job.completionGates : [];
  const missingIds = new Set(findMissingRequiredGates(gates).map((gate) => gate.id));
  const completionGates = gates.map((gate) => {
    if (!gate || gate.required !== true || !missingIds.has(gate.id)) return { ...gate };
    return transitionCompletionGate(gate, {
      status: "overridden",
      evidenceRef,
      overrideReason: reason,
    });
  });
  return {
    completionGates,
    overriddenGates: completionGates.filter((gate) => missingIds.has(gate.id)),
  };
}

export function createHumanOverrideEvent(input) {
  const {
    job,
    gateIds,
    reason,
    workspace,
    source = "http",
    user,
    ts,
    idempotencyKey,
  } = input || {};
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw makeGateError("job required", "INVALID_JOB");
  }
  if (!isJobId(job.id)) {
    throw makeGateError("job.id must be a job_ id", "INVALID_JOB_ID", { value: job.id });
  }
  if (!Array.isArray(gateIds) || gateIds.length === 0 || gateIds.some((id) => !isNonEmptyString(id))) {
    throw makeGateError("gateIds must be a non-empty string array", "INVALID_GATE_IDS");
  }
  if (!isNonEmptyString(reason)) {
    throw makeGateError("reason required (non-empty string)", "OVERRIDE_REASON_REQUIRED");
  }
  if (!isNonEmptyString(workspace)) {
    throw makeGateError("workspace required (non-empty string)", "INVALID_WORKSPACE");
  }
  if (!isNonEmptyString(source)) {
    throw makeGateError("source required (non-empty string)", "INVALID_SOURCE");
  }
  if (user !== undefined && !isNonEmptyString(user)) {
    throw makeGateError("user must be a non-empty string when present", "INVALID_USER");
  }

  const event = {
    schemaVersion: 1,
    ts: isNonEmptyString(ts) ? ts : new Date().toISOString(),
    type: "human.override",
    source,
    workspace,
    jobId: job.id,
    gateIds: [...gateIds],
    reason,
    context: {
      kind: "complete_override",
      jobId: job.id,
      ...(isSessionId(job.sessionId) ? { sessionId: job.sessionId } : {}),
      ...(isNonEmptyString(job.projectSlug) ? { projectSlug: job.projectSlug } : {}),
      ...(isNonEmptyString(job.taskId) ? { taskId: job.taskId } : {}),
    },
  };
  if (user !== undefined) event.user = user;
  if (idempotencyKey !== undefined) event.idempotencyKey = idempotencyKey;
  return event;
}
