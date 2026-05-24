// hub/providers/provider-events.js — SH-2-19 (addendum §8)
//
// Provider-neutral event union. Provider adapters (CodexAppServer,
// GenericPty, ManualProvider, …) emit ProviderEvents in their
// streamEvents() iterables; the normalizer in `normalizer.js` maps each
// kind to RuntimeEvents / AttentionIntents / TimelineItems.
//
// Source of truth: EXECUTOR_ADDENDUM §8. Adding a new kind requires
// updating both PROVIDER_EVENT_KINDS and the per-kind validators below.

/**
 * Frozen list of every ProviderEvent kind. Mirrors addendum §8.
 * @type {readonly string[]}
 */
export const PROVIDER_EVENT_KINDS = Object.freeze([
  "thread.started",
  "thread.resumed",
  "thread.forked",
  "turn.started",
  "turn.completed",
  "message",
  "command.started",
  "command.output",
  "command.completed",
  "file_change.proposed",
  "file_change.applied",
  "approval.requested",
  "approval.resolved",
  "context.usage",
  "provider.error",
]);

const TURN_STATUS = Object.freeze(["succeeded", "failed", "cancelled"]);
const MESSAGE_ROLES = Object.freeze(["user", "assistant", "tool", "system"]);
const STREAMS = Object.freeze(["stdout", "stderr"]);
const APPROVAL_DECISIONS = Object.freeze(["approved", "denied", "cancelled"]);

/**
 * @param {string} field
 * @param {unknown} value
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isArrayOfNonEmptyStrings(value) {
  if (!Array.isArray(value)) return false;
  for (const v of value) if (!isNonEmptyString(v)) return false;
  return true;
}

function isISODateString(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Build a tagged error with code `INVALID_PROVIDER_EVENT` and a field/kind
 * pointer so callers can route to the right log line / drop counter.
 *
 * @param {string} kind
 * @param {string} reason
 * @param {object} [details]
 */
function badEvent(kind, reason, details) {
  const err = /** @type {any} */ (new Error(`ProviderEvent (${kind}): ${reason}`));
  err.code = "INVALID_PROVIDER_EVENT";
  err.kind = kind;
  if (details) err.details = details;
  return err;
}

/**
 * Throw if `event` doesn't conform to the ProviderEvent union shape. The
 * normalizer always calls this first; provider adapters may call it as a
 * cheap self-check before yielding.
 *
 * @param {unknown} event
 * @returns {void}
 */
export function assertValidProviderEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw badEvent("(none)", "event must be an object");
  }
  const e = /** @type {any} */ (event);
  const { kind } = e;
  if (!PROVIDER_EVENT_KINDS.includes(kind)) {
    throw badEvent(String(kind), `unknown kind; expected one of ${PROVIDER_EVENT_KINDS.join("|")}`);
  }
  if (!isNonEmptyString(e.providerId)) throw badEvent(kind, "providerId must be a non-empty string");
  if (!isISODateString(e.ts)) throw badEvent(kind, "ts must be an ISO-8601 timestamp");

  switch (kind) {
    case "thread.started":
    case "thread.resumed":
    case "thread.forked": {
      if (!e.threadRef || typeof e.threadRef !== "object") {
        throw badEvent(kind, "threadRef object required");
      }
      // threadRef shape itself is defined in addendum §7; minimum we
      // need here is that it identifies a thread (transport-specific).
      break;
    }
    case "turn.started": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.turnId)) throw badEvent(kind, "turnId required");
      break;
    }
    case "turn.completed": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.turnId)) throw badEvent(kind, "turnId required");
      if (!TURN_STATUS.includes(e.status)) throw badEvent(kind, `status must be one of ${TURN_STATUS.join("|")}`);
      break;
    }
    case "message": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!MESSAGE_ROLES.includes(e.role)) throw badEvent(kind, `role must be one of ${MESSAGE_ROLES.join("|")}`);
      if (typeof e.text !== "string") throw badEvent(kind, "text must be a string");
      break;
    }
    case "command.started": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.commandId)) throw badEvent(kind, "commandId required");
      if (typeof e.command !== "string") throw badEvent(kind, "command must be a string");
      break;
    }
    case "command.output": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.commandId)) throw badEvent(kind, "commandId required");
      if (!STREAMS.includes(e.stream)) throw badEvent(kind, `stream must be one of ${STREAMS.join("|")}`);
      if (typeof e.text !== "string") throw badEvent(kind, "text must be a string");
      break;
    }
    case "command.completed": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.commandId)) throw badEvent(kind, "commandId required");
      if (e.exitCode !== undefined && !Number.isInteger(e.exitCode)) {
        throw badEvent(kind, "exitCode must be an integer when present");
      }
      break;
    }
    case "file_change.proposed":
    case "file_change.applied": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.proposalId)) throw badEvent(kind, "proposalId required");
      if (!Array.isArray(e.files) || e.files.length === 0 || !isArrayOfNonEmptyStrings(e.files)) {
        throw badEvent(kind, "files must be a non-empty string[]");
      }
      break;
    }
    case "approval.requested": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.approvalId)) throw badEvent(kind, "approvalId required");
      if (!isNonEmptyString(e.title)) throw badEvent(kind, "title required");
      break;
    }
    case "approval.resolved": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!isNonEmptyString(e.approvalId)) throw badEvent(kind, "approvalId required");
      if (!APPROVAL_DECISIONS.includes(e.decision)) {
        throw badEvent(kind, `decision must be one of ${APPROVAL_DECISIONS.join("|")}`);
      }
      break;
    }
    case "context.usage": {
      if (!isNonEmptyString(e.threadId)) throw badEvent(kind, "threadId required");
      if (!Number.isFinite(e.used) || e.used < 0) throw badEvent(kind, "used must be a non-negative number");
      if (!Number.isFinite(e.total) || e.total <= 0) throw badEvent(kind, "total must be a positive number");
      if (!Number.isFinite(e.percent) || e.percent < 0 || e.percent > 100) {
        throw badEvent(kind, "percent must be in [0,100]");
      }
      break;
    }
    case "provider.error": {
      if (!isNonEmptyString(e.message)) throw badEvent(kind, "message required");
      if (e.retryable !== undefined && typeof e.retryable !== "boolean") {
        throw badEvent(kind, "retryable must be a boolean when present");
      }
      break;
    }
    default:
      // The kind list above is exhaustive; the early check ensures we never reach here.
      throw badEvent(String(kind), "unhandled kind (programmer error)");
  }
}
