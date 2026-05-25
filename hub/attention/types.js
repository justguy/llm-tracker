// hub/attention/types.js — SH-4-01 (TDD v0.5 §6.8)
//
// AttentionItem + AttentionAction model. Mirrors the §6.8 shape verbatim.
// JSDoc typedefs stand in for the TypeScript declarations; frozen arrays
// expose the enum sets so callers (UI, projection, lints) can validate
// without re-deriving them.
//
// What this module is responsible for:
//   - Declaring the AttentionKind, AttentionSource, AttentionSeverity and
//     AttentionAction kind enum sets exactly as §6.8 lists them.
//   - Providing runtime validators (`assertValidAttentionItem`,
//     `assertValidAttentionAction`) that the attention projection / API
//     layers can call before persisting or shipping records.
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
 * @property {string} [clearCondition]
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
  if (i.clearCondition !== undefined && !isNonEmptyString(i.clearCondition)) {
    throw new Error("AttentionItem.clearCondition must be a non-empty string when present");
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
