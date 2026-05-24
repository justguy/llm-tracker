// hub/sessions/warnings.js — SH-2-02 (TDD v0.5 §8.3, §23.1)
//
// SessionWarning vocabulary + per-kind factories + a lint
// (`assertValidWarning`) that rejects malformed warnings before any event is
// emitted. The schema at `schema/runtime-events.schema.json` (SessionWarning
// definition) is the structural source of truth; this module enforces the
// stricter per-kind contracts from §8.3 (required fields, source enums,
// literal message text) that the schema's permissive bag-of-properties shape
// can't express on its own.
//
// What this module is responsible for:
//   - Exporting the 8 allowed warning kinds (TDD §8.3) and the single
//     deprecated kind (`quiet`, renamed to `quiet_terminal` per §23.1).
//   - Per-kind factories that return a plain, frozen-shape SessionWarning
//     object with the §8.3 required fields populated (and the §8.3 literal
//     `message` text for the two kinds that mandate one).
//   - `assertValidWarning(warning)` — throws with a field-pointed message
//     when kind is unknown / deprecated / missing required fields / has the
//     wrong `source` enum value.
//
// What this module does NOT do:
//   - Decide *when* to emit a warning. ActivityMonitor (SH-2-10 and friends)
//     owns the no-synthesis-from-raw-stdio rule for `context_high`; this
//     module only validates the shape once a caller has decided to build one.
//   - Emit events. `createSessionWarningEvent` /
//     `createSessionWarningClearedEvent` in `hub/runtime/events.js` use these
//     factories to build the event payload.

/**
 * @typedef {"app_server" | "mcp" | "human"} ApprovalSource
 * @typedef {"app_server" | "mcp"} ContextSource
 * @typedef {"app_server" | "mcp"} DisconnectedSource
 */

/**
 * @typedef {object} QuietTerminalWarning
 * @property {"quiet_terminal"} kind
 * @property {number} minutes
 * @property {"No raw output recently; check terminal."} message
 *
 * @typedef {object} MissingHeartbeatWarning
 * @property {"missing_heartbeat"} kind
 * @property {number} minutes
 * @property {"No structured heartbeat recently."} message
 *
 * @typedef {object} ApprovalNeededWarning
 * @property {"approval_needed"} kind
 * @property {ApprovalSource} source
 * @property {string} [actionId]
 *
 * @typedef {object} FileConflictWarning
 * @property {"file_conflict"} kind
 * @property {string} conflictId
 *
 * @typedef {object} ContextHighWarning
 * @property {"context_high"} kind
 * @property {ContextSource} source
 * @property {number} [percent]
 *
 * @typedef {object} SkillGateMissingWarning
 * @property {"skill_gate_missing"} kind
 * @property {string} skillId
 *
 * @typedef {object} DisconnectedWarning
 * @property {"disconnected"} kind
 * @property {DisconnectedSource} source
 * @property {number} sinceMs
 *
 * @typedef {object} StdioCaptureOversizedWarning
 * @property {"stdio_capture_oversized"} kind
 * @property {number} rotatedSegments
 *
 * @typedef {QuietTerminalWarning | MissingHeartbeatWarning | ApprovalNeededWarning
 *   | FileConflictWarning | ContextHighWarning | SkillGateMissingWarning
 *   | DisconnectedWarning | StdioCaptureOversizedWarning} SessionWarning
 */

/**
 * Frozen list of the 8 allowed SessionWarning kinds. Mirrors TDD §8.3 and the
 * `SessionWarning.kind` enum in `schema/runtime-events.schema.json`.
 *
 * @type {readonly string[]}
 */
export const WARNING_KINDS = Object.freeze([
  "quiet_terminal",
  "missing_heartbeat",
  "approval_needed",
  "file_conflict",
  "context_high",
  "skill_gate_missing",
  "disconnected",
  "stdio_capture_oversized",
]);

/**
 * Deprecated warning kinds that callers must never emit. Per TDD §23.1 the
 * legacy `quiet` kind was renamed to `quiet_terminal`. Kept as a separate
 * export so callers (and the regression test for the DoD) can assert against
 * it by name.
 *
 * @type {readonly string[]}
 */
export const DEPRECATED_WARNING_KINDS = Object.freeze(["quiet"]);

const APPROVAL_SOURCES = Object.freeze(["app_server", "mcp", "human"]);
const CONTEXT_SOURCES = Object.freeze(["app_server", "mcp"]);
const DISCONNECTED_SOURCES = Object.freeze(["app_server", "mcp"]);

/**
 * Build an Error with a field-pointed message + structured `details` for
 * downstream callers that want to map to HTTP/MCP error envelopes.
 *
 * @param {string} message
 * @param {object} [details]
 * @returns {Error & { details?: object }}
 */
function makeError(message, details) {
  const err = /** @type {any} */ (new Error(message));
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Throw if `warning` is not a structurally valid SessionWarning per TDD §8.3.
 *
 * Checks performed:
 *   - input is a plain object
 *   - `kind` is a string in WARNING_KINDS (and explicitly NOT in
 *     DEPRECATED_WARNING_KINDS — the deprecation message points at §23.1)
 *   - per-kind required fields are present and well-typed
 *   - `source` field is in the per-kind enum allowed by the schema
 *
 * @param {unknown} warning
 * @returns {void}
 */
export function assertValidWarning(warning) {
  if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
    throw makeError("SessionWarning must be a plain object", { received: typeof warning });
  }
  const w = /** @type {Record<string, unknown>} */ (warning);
  const kind = w.kind;
  if (typeof kind !== "string") {
    throw makeError("SessionWarning.kind must be a string", { field: "/kind" });
  }
  if (DEPRECATED_WARNING_KINDS.includes(kind)) {
    throw makeError(
      `SessionWarning.kind '${kind}' is deprecated; use '${kind === "quiet" ? "quiet_terminal" : kind}' (TDD §23.1)`,
      { field: "/kind", deprecated: kind },
    );
  }
  if (!WARNING_KINDS.includes(kind)) {
    throw makeError(
      `SessionWarning.kind '${kind}' not in ${WARNING_KINDS.join("|")}`,
      { field: "/kind", allowed: [...WARNING_KINDS] },
    );
  }

  switch (kind) {
    case "quiet_terminal":
      assertNumber(w, "minutes");
      assertLiteralMessage(w, "No raw output recently; check terminal.");
      break;
    case "missing_heartbeat":
      assertNumber(w, "minutes");
      assertLiteralMessage(w, "No structured heartbeat recently.");
      break;
    case "approval_needed":
      assertEnum(w, "source", APPROVAL_SOURCES);
      if (Object.prototype.hasOwnProperty.call(w, "actionId")) {
        assertNonEmptyString(w, "actionId");
      }
      break;
    case "file_conflict":
      assertNonEmptyString(w, "conflictId");
      break;
    case "context_high":
      assertEnum(w, "source", CONTEXT_SOURCES);
      if (Object.prototype.hasOwnProperty.call(w, "percent")) {
        assertNumber(w, "percent");
      }
      break;
    case "skill_gate_missing":
      assertNonEmptyString(w, "skillId");
      break;
    case "disconnected":
      assertEnum(w, "source", DISCONNECTED_SOURCES);
      assertNumber(w, "sinceMs");
      break;
    case "stdio_capture_oversized":
      assertNonNegativeInteger(w, "rotatedSegments");
      break;
    default:
      // Unreachable: kind was already checked against WARNING_KINDS above.
      throw makeError(`unhandled SessionWarning kind '${kind}'`, { field: "/kind" });
  }
}

/** @param {Record<string, unknown>} w @param {string} field */
function assertNumber(w, field) {
  const v = w[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw makeError(`SessionWarning.${field} must be a finite number`, { field: `/${field}`, kind: w.kind });
  }
}

/** @param {Record<string, unknown>} w @param {string} field */
function assertNonNegativeInteger(w, field) {
  const v = w[field];
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 0) {
    throw makeError(`SessionWarning.${field} must be a non-negative integer`, { field: `/${field}`, kind: w.kind });
  }
}

/** @param {Record<string, unknown>} w @param {string} field */
function assertNonEmptyString(w, field) {
  const v = w[field];
  if (typeof v !== "string" || v.length === 0) {
    throw makeError(`SessionWarning.${field} must be a non-empty string`, { field: `/${field}`, kind: w.kind });
  }
}

/** @param {Record<string, unknown>} w @param {string} field @param {readonly string[]} allowed */
function assertEnum(w, field, allowed) {
  const v = w[field];
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw makeError(
      `SessionWarning.${field} must be one of ${allowed.join("|")}`,
      { field: `/${field}`, kind: w.kind, allowed: [...allowed] },
    );
  }
}

/** @param {Record<string, unknown>} w @param {string} expected */
function assertLiteralMessage(w, expected) {
  if (w.message !== expected) {
    throw makeError(
      `SessionWarning.message must be the §8.3 literal "${expected}"`,
      { field: "/message", kind: w.kind, expected },
    );
  }
}

/**
 * Build a `quiet_terminal` warning. The §8.3 literal message is set for you.
 *
 * @param {{ minutes: number }} input
 * @returns {QuietTerminalWarning}
 */
export function quietTerminalWarning(input) {
  const warning = {
    kind: "quiet_terminal",
    minutes: input && input.minutes,
    message: "No raw output recently; check terminal.",
  };
  assertValidWarning(warning);
  return /** @type {QuietTerminalWarning} */ (warning);
}

/**
 * Build a `missing_heartbeat` warning. The §8.3 literal message is set for you.
 *
 * @param {{ minutes: number }} input
 * @returns {MissingHeartbeatWarning}
 */
export function missingHeartbeatWarning(input) {
  const warning = {
    kind: "missing_heartbeat",
    minutes: input && input.minutes,
    message: "No structured heartbeat recently.",
  };
  assertValidWarning(warning);
  return /** @type {MissingHeartbeatWarning} */ (warning);
}

/**
 * Build an `approval_needed` warning. `actionId` is optional.
 *
 * @param {{ source: ApprovalSource; actionId?: string }} input
 * @returns {ApprovalNeededWarning}
 */
export function approvalNeededWarning(input) {
  /** @type {Record<string, unknown>} */
  const warning = { kind: "approval_needed", source: input && input.source };
  if (input && input.actionId !== undefined) warning.actionId = input.actionId;
  assertValidWarning(warning);
  return /** @type {ApprovalNeededWarning} */ (warning);
}

/**
 * Build a `file_conflict` warning.
 *
 * @param {{ conflictId: string }} input
 * @returns {FileConflictWarning}
 */
export function fileConflictWarning(input) {
  const warning = { kind: "file_conflict", conflictId: input && input.conflictId };
  assertValidWarning(warning);
  return /** @type {FileConflictWarning} */ (warning);
}

/**
 * Build a `context_high` warning. The hub never synthesizes these from raw
 * stdio — callers (ActivityMonitor, SH-2-10) enforce that rule. This factory
 * only validates shape.
 *
 * @param {{ source: ContextSource; percent?: number }} input
 * @returns {ContextHighWarning}
 */
export function contextHighWarning(input) {
  /** @type {Record<string, unknown>} */
  const warning = { kind: "context_high", source: input && input.source };
  if (input && input.percent !== undefined) warning.percent = input.percent;
  assertValidWarning(warning);
  return /** @type {ContextHighWarning} */ (warning);
}

/**
 * Build a `skill_gate_missing` warning.
 *
 * @param {{ skillId: string }} input
 * @returns {SkillGateMissingWarning}
 */
export function skillGateMissingWarning(input) {
  const warning = { kind: "skill_gate_missing", skillId: input && input.skillId };
  assertValidWarning(warning);
  return /** @type {SkillGateMissingWarning} */ (warning);
}

/**
 * Build a `disconnected` warning.
 *
 * @param {{ source: DisconnectedSource; sinceMs: number }} input
 * @returns {DisconnectedWarning}
 */
export function disconnectedWarning(input) {
  const warning = {
    kind: "disconnected",
    source: input && input.source,
    sinceMs: input && input.sinceMs,
  };
  assertValidWarning(warning);
  return /** @type {DisconnectedWarning} */ (warning);
}

/**
 * Build a `stdio_capture_oversized` warning.
 *
 * @param {{ rotatedSegments: number }} input
 * @returns {StdioCaptureOversizedWarning}
 */
export function stdioCaptureOversizedWarning(input) {
  const warning = {
    kind: "stdio_capture_oversized",
    rotatedSegments: input && input.rotatedSegments,
  };
  assertValidWarning(warning);
  return /** @type {StdioCaptureOversizedWarning} */ (warning);
}
