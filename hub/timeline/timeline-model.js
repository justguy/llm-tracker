// hub/timeline/timeline-model.js — SH-4A-01 (EXECUTOR_ADDENDUM §11, TDD v0.5 §23.2 #23)
//
// TimelineItem + TimelineAction model. Mirrors addendum §11 verbatim. JSDoc
// typedefs stand in for the TypeScript declarations; frozen arrays expose the
// enum sets so callers (UI, projection, lints) can validate without
// re-deriving them.
//
// Storage strategy (addendum §11 + TDD §23.2 #23):
//   Timeline is a *projection* over RuntimeEvents, normalized provider
//   events, repo events, and selected tracker history — NOT a durable store.
//   Default storage is in-memory; the projection is rebuilt from
//   `RuntimeStore` + watcher logs at hub startup. An optional snapshot cache
//   at `.runtime/timeline.snapshot.json` is permitted later (advisory only)
//   and is never authoritative. No separate timeline database, no
//   append-only timeline log.
//
// What this module is responsible for:
//   - Declaring the TimelineItemKind, TimelineSource, TimelineConfidence enum
//     sets exactly as addendum §11 lists them.
//   - Providing runtime validators (`assertValidTimelineItem`,
//     `assertValidTimelineAction`) that the timeline projection / API layers
//     can call before shipping records.
//
// What this module does NOT do:
//   - Build the projection (that lives in later SH-4A tasks).
//   - Constrain TimelineAction.kind to a fixed enum. The concrete
//     action-kind enum lives with the SH-4A actions tasks (later); keeping
//     `kind` as a free-form string here avoids over-coupling.

/**
 * @typedef {"message"
 *   | "reasoning"
 *   | "command"
 *   | "file_change"
 *   | "approval"
 *   | "checkpoint"
 *   | "skill"
 *   | "verify"
 *   | "repo_change"
 *   | "warning"
 *   | "handoff"
 *   | "status"} TimelineItemKind
 */

/**
 * @typedef {"provider"
 *   | "mcp"
 *   | "http"
 *   | "watcher_git"
 *   | "derived"
 *   | "human"
 *   | "raw_stdio"
 *   | "system"} TimelineSource
 */

/**
 * @typedef {"structured"
 *   | "reported"
 *   | "derived"
 *   | "manual"
 *   | "unknown"} TimelineConfidence
 */

/**
 * @typedef {object} TimelineAction
 * @property {string} id
 * @property {string} label
 * @property {string} kind         free-form for now; concrete enum lands with SH-4A actions tasks
 * @property {boolean} enabled
 * @property {string} [disabledReason]
 */

/**
 * @typedef {object} TimelineItem
 * @property {string} id
 * @property {string} sessionId
 * @property {string} [jobId]
 * @property {string} [taskId]
 * @property {string} [projectSlug]
 * @property {TimelineItemKind} kind
 * @property {string} title
 * @property {string} [detail]
 * @property {string} ts
 * @property {TimelineSource} source
 * @property {TimelineConfidence} confidence
 * @property {string} evidenceRef  every timeline item must link to its evidence source (addendum §11)
 * @property {TimelineAction[]} [actions]
 */

/**
 * Frozen list of the 12 TimelineItemKind values from addendum §11.
 * @type {readonly TimelineItemKind[]}
 */
export const TIMELINE_KINDS = Object.freeze([
  "message",
  "reasoning",
  "command",
  "file_change",
  "approval",
  "checkpoint",
  "skill",
  "verify",
  "repo_change",
  "warning",
  "handoff",
  "status",
]);

/**
 * Frozen list of the 8 TimelineSource values from addendum §11.
 * @type {readonly TimelineSource[]}
 */
export const TIMELINE_SOURCES = Object.freeze([
  "provider",
  "mcp",
  "http",
  "watcher_git",
  "derived",
  "human",
  "raw_stdio",
  "system",
]);

/**
 * Frozen list of the 5 TimelineConfidence values from addendum §11.
 * @type {readonly TimelineConfidence[]}
 */
export const TIMELINE_CONFIDENCES = Object.freeze([
  "structured",
  "reported",
  "derived",
  "manual",
  "unknown",
]);

// ISO-8601 with required date + time + timezone (Z or ±HH:MM). Mirrors the
// shape `new Date().toISOString()` produces while also accepting numeric
// offsets.
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
 * Validate a TimelineAction shape. Throws on the first violation.
 *
 * @param {unknown} action
 * @returns {void}
 */
export function assertValidTimelineAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("TimelineAction must be a plain object");
  }
  const a = /** @type {Record<string, unknown>} */ (action);
  if (!isNonEmptyString(a.id)) {
    throw new Error("TimelineAction.id required (non-empty string)");
  }
  if (!isNonEmptyString(a.label)) {
    throw new Error("TimelineAction.label required (non-empty string)");
  }
  if (!isNonEmptyString(a.kind)) {
    throw new Error("TimelineAction.kind required (non-empty string)");
  }
  if (typeof a.enabled !== "boolean") {
    throw new Error("TimelineAction.enabled must be a boolean");
  }
  if (a.disabledReason !== undefined) {
    if (!isNonEmptyString(a.disabledReason)) {
      throw new Error(
        "TimelineAction.disabledReason must be a non-empty string when present",
      );
    }
    if (a.enabled !== false) {
      throw new Error(
        "TimelineAction.disabledReason only allowed when enabled === false",
      );
    }
  }
}

/**
 * Validate a TimelineItem shape. Throws on the first violation. Also
 * validates each entry in `actions` when present.
 *
 * @param {unknown} item
 * @returns {void}
 */
export function assertValidTimelineItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("TimelineItem must be a plain object");
  }
  const i = /** @type {Record<string, unknown>} */ (item);

  if (!isNonEmptyString(i.id)) {
    throw new Error("TimelineItem.id required (non-empty string)");
  }
  if (!isNonEmptyString(i.sessionId)) {
    throw new Error("TimelineItem.sessionId required (non-empty string)");
  }
  if (!isNonEmptyString(i.kind)) {
    throw new Error("TimelineItem.kind required (non-empty string)");
  }
  if (!TIMELINE_KINDS.includes(/** @type {TimelineItemKind} */ (i.kind))) {
    throw new Error(`TimelineItem.kind '${i.kind}' not in TIMELINE_KINDS`);
  }
  if (!isNonEmptyString(i.title)) {
    throw new Error("TimelineItem.title required (non-empty string)");
  }
  if (typeof i.ts !== "string" || !ISO_8601_RE.test(i.ts)) {
    throw new Error(
      `TimelineItem.ts must be an ISO-8601 timestamp (got ${JSON.stringify(i.ts)})`,
    );
  }
  if (!isNonEmptyString(i.source)) {
    throw new Error("TimelineItem.source required (non-empty string)");
  }
  if (!TIMELINE_SOURCES.includes(/** @type {TimelineSource} */ (i.source))) {
    throw new Error(
      `TimelineItem.source '${i.source}' not in TIMELINE_SOURCES`,
    );
  }
  if (!isNonEmptyString(i.confidence)) {
    throw new Error("TimelineItem.confidence required (non-empty string)");
  }
  if (
    !TIMELINE_CONFIDENCES.includes(
      /** @type {TimelineConfidence} */ (i.confidence),
    )
  ) {
    throw new Error(
      `TimelineItem.confidence '${i.confidence}' not in TIMELINE_CONFIDENCES`,
    );
  }
  // Every timeline item must link to its evidence source (addendum §11).
  if (!isNonEmptyString(i.evidenceRef)) {
    throw new Error(
      "TimelineItem.evidenceRef required (non-empty string; every timeline item must link to its evidence source)",
    );
  }

  for (const optional of ["jobId", "taskId", "projectSlug", "detail"]) {
    if (i[optional] !== undefined && !isNonEmptyString(i[optional])) {
      throw new Error(
        `TimelineItem.${optional} must be a non-empty string when present`,
      );
    }
  }

  if (i.actions !== undefined) {
    if (!Array.isArray(i.actions)) {
      throw new Error("TimelineItem.actions must be an array when present");
    }
    for (let n = 0; n < i.actions.length; n += 1) {
      try {
        assertValidTimelineAction(i.actions[n]);
      } catch (err) {
        throw new Error(
          `TimelineItem.actions[${n}]: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
