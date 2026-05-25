// hub/attention/types.js — SH-4-01 (TDD v0.5 §6.8) + SH-4-12 (addendum §15)
//
// AttentionItem + AttentionAction model. Mirrors the §6.8 shape verbatim.
// JSDoc typedefs stand in for the TypeScript declarations; frozen arrays
// expose the enum sets so callers (UI, projection, lints) can validate
// without re-deriving them.
//
// What this module is responsible for:
//   - Declaring the AttentionKind, AttentionSource, AttentionSeverity and
//     AttentionAction kind enum sets exactly as §6.8 lists them.
//   - Providing the per-kind default clearCondition strings (addendum §15
//     requires every item to carry one) and a `defaultClearConditionForKind`
//     helper for UI fallbacks.
//   - Providing runtime validators (`assertValidAttentionItem`,
//     `assertValidAttentionAction`) that the attention projection / API
//     layers can call before persisting or shipping records.
//     `assertValidAttentionItem` default-fills `clearCondition` from
//     CLEAR_CONDITIONS_BY_KIND when the caller omitted it, then enforces a
//     non-empty string — see §15 ("every item to have one").
//
// What this module does NOT do:
//   - Build dedupe keys (that lives in `./dedupe.js`).
//   - Compute or persist anything; this file is pure shape + lint.

/**
 * @typedef {"approval_needed"
 *   | "blocked"
 *   | "conflict"
 *   | "outside_allowed_paths"
 *   | "not_responding"
 *   | "quiet"
 *   | "context_high"
 *   | "done_needs_closeout"
 *   | "done_claimed_verify_missing"
 *   | "verify_missing"
 *   | "unbound_session"
 *   | "sandbox_escape_requested"
 *   | "provider_error"} AttentionKind
 */

/**
 * @typedef {"structured"
 *   | "reported"
 *   | "derived"
 *   | "manual"
 *   | "watcher_git"
 *   | "unknown"} AttentionSource
 */

/**
 * @typedef {"critical" | "high" | "medium" | "low"} AttentionSeverity
 */

/**
 * @typedef {"open_session" | "open_stdio" | "open_chat"
 *   | "approve" | "deny"
 *   | "request_checkpoint" | "rollover"
 *   | "run_closeout" | "run_verify" | "spawn_reviewer"
 *   | "view_conflict" | "create_worktree" | "bind_task"
 *   | "copy_context"
 *   | "escalate_sandbox"
 *   | "unblock"
 *   | "ask"
 *   | "interrupt"
 *   | "complete_override"
 *   | "attach_task"
 *   | "add_task_then_run"
 *   | "swap_model_live"
 *   | "restart_with_new_model"
 *   | "restart_stricter_sandbox"
 *   | "restart_all_quiet"
 *   | "acknowledge"
 *   | "snooze"} AttentionActionKind
 */

/**
 * @typedef {object} AttentionAction
 * @property {string} id
 * @property {string} label
 * @property {AttentionActionKind} kind
 * @property {boolean} enabled
 * @property {string} [disabledReason]
 */

/**
 * @typedef {object} AttentionItem
 * @property {string} id
 * @property {AttentionKind} kind
 * @property {AttentionSeverity} severity
 * @property {string} [projectSlug]
 * @property {string} [taskId]
 * @property {string} [jobId]
 * @property {string} [sessionId]
 * @property {string} title
 * @property {string} detail
 * @property {AttentionSource} source
 * @property {string} [evidenceRef]    RuntimeEvent id, tracker rev, or conflict id
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} dedupeKey
 * @property {string} clearCondition  Human-readable §15 clear condition. Required on the wire; `assertValidAttentionItem` default-fills from CLEAR_CONDITIONS_BY_KIND when omitted.
 * @property {AttentionAction[]} recommendedActions
 * @property {boolean} [autoArchive]
 * @property {string} [acknowledgedAt]
 * @property {string} [snoozedUntil]
 * @property {string} [clearedAt]
 */

/**
 * Frozen list of the AttentionKind values. The first 11 entries mirror TDD
 * §6.8; `sandbox_escape_requested` and `provider_error` are appended per
 * addendum §15.
 * @type {readonly AttentionKind[]}
 */
export const ATTENTION_KINDS = Object.freeze([
  "approval_needed",
  "blocked",
  "conflict",
  "outside_allowed_paths",
  "not_responding",
  "quiet",
  "context_high",
  "done_needs_closeout",
  "done_claimed_verify_missing",
  "verify_missing",
  "unbound_session",
  "sandbox_escape_requested",
  "provider_error",
]);

/**
 * Frozen list of the 6 AttentionSource values from TDD §6.8.
 * @type {readonly AttentionSource[]}
 */
export const ATTENTION_SOURCES = Object.freeze([
  "structured",
  "reported",
  "derived",
  "manual",
  "watcher_git",
  "unknown",
]);

/**
 * Frozen list of severities (highest → lowest).
 * @type {readonly AttentionSeverity[]}
 */
export const ATTENTION_SEVERITIES = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
]);

/**
 * Per-kind default `clearCondition` strings, sourced from TDD §8A.3 "Clear
 * rules" and addendum §15. The active rules (and engine.js for
 * `unbound_session`) each emit their own kind-appropriate string; this map
 * provides a safe fallback for any code path that constructs an item without
 * one, so the §15 requirement "every item to have one" holds at the wire
 * boundary.
 *
 * @type {Readonly<Record<AttentionKind, string>>}
 */
export const CLEAR_CONDITIONS_BY_KIND = Object.freeze({
  approval_needed: "structured approval resolution or human clear",
  blocked: "structured status change, human resolution, or job completion/cancel",
  conflict: "watcher/git evidence no longer shows the conflict, or human ack",
  outside_allowed_paths:
    "watcher/git evidence no longer shows out-of-bounds writes, or human ack with reason",
  not_responding: "next structured heartbeat or event",
  quiet: "next raw output for dumb-terminal sessions",
  context_high: "rollover, archive, or structured context drops below threshold",
  done_needs_closeout: "closeout/handoff/archive gate satisfied or overridden",
  done_claimed_verify_missing: "verify gates satisfied or task status changed",
  verify_missing: "verify pack populated with at least one required gate",
  unbound_session: "session.taskId is set or session reaches a terminal status",
  sandbox_escape_requested:
    "structured escape resolution (granted/denied) or human ack",
  provider_error: "provider error resolves (retry success or human ack)",
});

/**
 * Lookup the §15 default clearCondition string for `kind`. Returns `undefined`
 * for unknown kinds so the validator's enum check can flag them rather than
 * silently masking the violation.
 *
 * @param {string} kind
 * @returns {string | undefined}
 */
export function defaultClearConditionForKind(kind) {
  if (typeof kind !== "string") return undefined;
  return CLEAR_CONDITIONS_BY_KIND[/** @type {AttentionKind} */ (kind)];
}

/**
 * Frozen list of every AttentionAction.kind from TDD §6.8 (14 base kinds plus
 * the v0.7 design-integration additions).
 * @type {readonly AttentionActionKind[]}
 */
export const ATTENTION_ACTION_KINDS = Object.freeze([
  // base
  "open_session",
  "open_stdio",
  "open_chat",
  "approve",
  "deny",
  "request_checkpoint",
  "rollover",
  "run_closeout",
  "run_verify",
  "spawn_reviewer",
  "view_conflict",
  "create_worktree",
  "bind_task",
  "copy_context",
  // v0.7 design-integration additions
  "escalate_sandbox",
  "unblock",
  "ask",
  "interrupt",
  "complete_override",
  "attach_task",
  "add_task_then_run",
  "swap_model_live",
  "restart_with_new_model",
  "restart_stricter_sandbox",
  "restart_all_quiet",
  "acknowledge",
  "snooze",
]);

// ISO-8601 with required date + time + timezone (Z or ±HH:MM). Mirrors the
// shape `new Date().toISOString()` produces while also accepting numeric
// offsets, which §6.8 timestamps may carry.
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {void}
 */
function assertIsoTimestamp(field, value) {
  if (typeof value !== "string" || !ISO_8601_RE.test(value)) {
    throw new Error(
      `AttentionItem.${field} must be an ISO-8601 timestamp (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Validate an AttentionAction shape. Throws on the first violation.
 *
 * @param {unknown} action
 * @returns {void}
 */
export function assertValidAttentionAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("AttentionAction must be a plain object");
  }
  const a = /** @type {Record<string, unknown>} */ (action);
  if (!isNonEmptyString(a.id)) {
    throw new Error("AttentionAction.id required (non-empty string)");
  }
  if (!isNonEmptyString(a.label)) {
    throw new Error("AttentionAction.label required (non-empty string)");
  }
  if (!isNonEmptyString(a.kind)) {
    throw new Error("AttentionAction.kind required (non-empty string)");
  }
  if (!ATTENTION_ACTION_KINDS.includes(/** @type {AttentionActionKind} */ (a.kind))) {
    throw new Error(
      `AttentionAction.kind '${a.kind}' not in ATTENTION_ACTION_KINDS`,
    );
  }
  if (typeof a.enabled !== "boolean") {
    throw new Error("AttentionAction.enabled must be a boolean");
  }
  if (a.disabledReason !== undefined) {
    if (!isNonEmptyString(a.disabledReason)) {
      throw new Error(
        "AttentionAction.disabledReason must be a non-empty string when present",
      );
    }
    if (a.enabled !== false) {
      throw new Error(
        "AttentionAction.disabledReason only allowed when enabled === false",
      );
    }
  }
}

/**
 * Validate an AttentionItem shape. Throws on the first violation. Also
 * validates each entry in `recommendedActions`.
 *
 * @param {unknown} item
 * @returns {void}
 */
export function assertValidAttentionItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("AttentionItem must be a plain object");
  }
  const i = /** @type {Record<string, unknown>} */ (item);

  if (!isNonEmptyString(i.id)) {
    throw new Error("AttentionItem.id required (non-empty string)");
  }
  if (!isNonEmptyString(i.kind)) {
    throw new Error("AttentionItem.kind required (non-empty string)");
  }
  if (!ATTENTION_KINDS.includes(/** @type {AttentionKind} */ (i.kind))) {
    throw new Error(`AttentionItem.kind '${i.kind}' not in ATTENTION_KINDS`);
  }
  if (!isNonEmptyString(i.severity)) {
    throw new Error("AttentionItem.severity required (non-empty string)");
  }
  if (!ATTENTION_SEVERITIES.includes(/** @type {AttentionSeverity} */ (i.severity))) {
    throw new Error(
      `AttentionItem.severity '${i.severity}' not in ATTENTION_SEVERITIES`,
    );
  }
  if (!isNonEmptyString(i.title)) {
    throw new Error("AttentionItem.title required (non-empty string)");
  }
  if (typeof i.detail !== "string") {
    throw new Error("AttentionItem.detail required (string)");
  }
  if (!isNonEmptyString(i.source)) {
    throw new Error("AttentionItem.source required (non-empty string)");
  }
  if (!ATTENTION_SOURCES.includes(/** @type {AttentionSource} */ (i.source))) {
    throw new Error(
      `AttentionItem.source '${i.source}' not in ATTENTION_SOURCES`,
    );
  }
  if (!isNonEmptyString(i.dedupeKey)) {
    throw new Error("AttentionItem.dedupeKey required (non-empty string)");
  }
  if (i.clearCondition === undefined) {
    const fallback = CLEAR_CONDITIONS_BY_KIND[/** @type {AttentionKind} */ (i.kind)];
    if (typeof fallback === "string" && fallback.length > 0) {
      i.clearCondition = fallback;
    }
  }
  if (!isNonEmptyString(i.clearCondition)) {
    throw new Error(
      "AttentionItem.clearCondition required (non-empty string; addendum §15)",
    );
  }
  if (i.autoArchive !== undefined && typeof i.autoArchive !== "boolean") {
    throw new Error("AttentionItem.autoArchive must be a boolean when present");
  }
  if (!Array.isArray(i.recommendedActions)) {
    throw new Error("AttentionItem.recommendedActions must be an array");
  }

  assertIsoTimestamp("createdAt", i.createdAt);
  assertIsoTimestamp("updatedAt", i.updatedAt);
  if (i.acknowledgedAt !== undefined) assertIsoTimestamp("acknowledgedAt", i.acknowledgedAt);
  if (i.snoozedUntil !== undefined) assertIsoTimestamp("snoozedUntil", i.snoozedUntil);
  if (i.clearedAt !== undefined) assertIsoTimestamp("clearedAt", i.clearedAt);

  for (const optional of ["projectSlug", "taskId", "jobId", "sessionId", "evidenceRef"]) {
    if (i[optional] !== undefined && !isNonEmptyString(i[optional])) {
      throw new Error(
        `AttentionItem.${optional} must be a non-empty string when present`,
      );
    }
  }

  for (let n = 0; n < i.recommendedActions.length; n += 1) {
    try {
      assertValidAttentionAction(i.recommendedActions[n]);
    } catch (err) {
      throw new Error(
        `AttentionItem.recommendedActions[${n}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
