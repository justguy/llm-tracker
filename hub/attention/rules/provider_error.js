// hub/attention/rules/provider_error.js — SH-4-11 (addendum §15, §8A.3)
//
// Trigger: a structured `provider_error` signal. We accept two structured
// inputs:
//
//   1. A session warning of kind `provider_error` (carried on
//      `session.warnings[]`). This kind is NOT yet in `WARNING_KINDS` in
//      `hub/sessions/warnings.js`; until it's added there, callers can still
//      attach a warning-shaped object to `session.warnings[]` and this rule
//      will surface it. The vocabulary gap is a follow-up.
//
//   2. A top-level `warnings[]` array entry (the engine input slot) whose
//      `kind === "provider_error"`. This covers the provider broker / adapter
//      `provider.error` ProviderEvent (normalized in §8) folded directly into
//      the attention input before any session-level state exists.
//
// Severity per addendum §15:
//   - `retryable === false` → `medium`  (§15 priority order places
//                                        `provider_error if retryable=false`
//                                        in the medium tier)
//   - `retryable === true`  → `low`    (self-recovering; §15 does not list
//                                       it in any tier above)
//   - retryable absent      → `medium` (default to the more visible severity;
//                                       absence does not imply self-recovery)
//
// Source: `structured`.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 * @typedef {import("../types.js").AttentionSeverity} AttentionSeverity
 */

/**
 * @param {boolean | undefined} retryable
 * @returns {AttentionSeverity}
 */
function severityFor(retryable) {
  if (retryable === false) return "medium";
  if (retryable === true) return "low";
  return "medium";
}

/**
 * @param {{
 *   sessions?: object[],
 *   warnings?: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function providerErrorRule(input) {
  if (!input || typeof input !== "object") return [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const topWarnings = Array.isArray(input.warnings) ? input.warnings : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;
    const warnings = Array.isArray(session.warnings) ? session.warnings : [];
    for (const w of warnings) {
      if (!w || w.kind !== "provider_error") continue;
      const retryable =
        typeof w.retryable === "boolean" ? w.retryable : undefined;
      const evidenceRef =
        typeof w.errorId === "string" && w.errorId.length > 0
          ? w.errorId
          : typeof w.eventId === "string" && w.eventId.length > 0
            ? w.eventId
            : undefined;
      const dedupeKey = computeAttentionDedupeKey({
        kind: "provider_error",
        sessionId: session.id,
        evidenceRef,
      });
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const detailParts = [`Session ${session.id} reports a provider error`];
      if (typeof w.message === "string" && w.message.length > 0) {
        detailParts.push(`: ${w.message}`);
      } else {
        detailParts.push(".");
      }
      if (retryable === false) detailParts.push(" (not retryable)");
      else if (retryable === true) detailParts.push(" (retryable)");
      /** @type {AttentionItem} */
      const item = {
        id: input.makeId("att"),
        kind: "provider_error",
        severity: severityFor(retryable),
        title: "Provider error",
        detail: detailParts.join(""),
        source: "structured",
        sessionId: session.id,
        clearCondition:
          "structured recovery (next successful provider event) or human ack",
        createdAt: nowIso,
        updatedAt: nowIso,
        dedupeKey,
        recommendedActions: [
          {
            id: "restart_with_new_model",
            label: "Restart with new model",
            kind: "restart_with_new_model",
            enabled: true,
          },
          {
            id: "restart_stricter_sandbox",
            label: "Restart with stricter sandbox",
            kind: "restart_stricter_sandbox",
            enabled: true,
          },
          { id: "interrupt", label: "Interrupt", kind: "interrupt", enabled: true },
          {
            id: "acknowledge",
            label: "Acknowledge",
            kind: "acknowledge",
            enabled: true,
          },
        ],
      };
      if (typeof session.projectSlug === "string" && session.projectSlug.length > 0) {
        item.projectSlug = session.projectSlug;
      }
      if (typeof session.taskId === "string" && session.taskId.length > 0) {
        item.taskId = session.taskId;
      }
      if (typeof session.activeJobId === "string" && session.activeJobId.length > 0) {
        item.jobId = session.activeJobId;
      }
      if (evidenceRef) item.evidenceRef = evidenceRef;
      out.push(item);
    }
  }

  for (const w of topWarnings) {
    if (!w || w.kind !== "provider_error") continue;
    const retryable = typeof w.retryable === "boolean" ? w.retryable : undefined;
    const sessionId =
      typeof w.sessionId === "string" && w.sessionId.length > 0 ? w.sessionId : undefined;
    const evidenceRef =
      typeof w.errorId === "string" && w.errorId.length > 0
        ? w.errorId
        : typeof w.eventId === "string" && w.eventId.length > 0
          ? w.eventId
          : undefined;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "provider_error",
      sessionId,
      evidenceRef,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const detailParts = sessionId
      ? [`Session ${sessionId} reports a provider error`]
      : ["Provider error"];
    if (typeof w.message === "string" && w.message.length > 0) {
      detailParts.push(`: ${w.message}`);
    } else {
      detailParts.push(".");
    }
    if (retryable === false) detailParts.push(" (not retryable)");
    else if (retryable === true) detailParts.push(" (retryable)");
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "provider_error",
      severity: severityFor(retryable),
      title: "Provider error",
      detail: detailParts.join(""),
      source: "structured",
      clearCondition:
        "structured recovery (next successful provider event) or human ack",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        {
          id: "restart_with_new_model",
          label: "Restart with new model",
          kind: "restart_with_new_model",
          enabled: true,
        },
        {
          id: "restart_stricter_sandbox",
          label: "Restart with stricter sandbox",
          kind: "restart_stricter_sandbox",
          enabled: true,
        },
        { id: "interrupt", label: "Interrupt", kind: "interrupt", enabled: true },
        {
          id: "acknowledge",
          label: "Acknowledge",
          kind: "acknowledge",
          enabled: true,
        },
      ],
    };
    if (sessionId) item.sessionId = sessionId;
    if (evidenceRef) item.evidenceRef = evidenceRef;
    out.push(item);
  }

  return out;
}
