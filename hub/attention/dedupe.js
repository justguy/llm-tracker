// hub/attention/dedupe.js — SH-4-01 (TDD v0.5 §6.8)
//
// Deterministic dedupe key for AttentionItems. Equal inputs MUST produce
// equal strings so the projection can collapse duplicates without storing
// extra indexing state. Optional fields collapse to empty segments (never
// the literal "undefined") so absent values are still positionally stable.

import { ATTENTION_KINDS } from "./types.js";

/**
 * @typedef {import("./types.js").AttentionKind} AttentionKind
 */

/**
 * Compute the composite dedupe key:
 *   `${kind}|${projectSlug}|${taskId}|${jobId}|${sessionId}|${evidenceRef}`
 *
 * Optional fields collapse to "" (empty segment); positions are fixed so two
 * items that differ only in which optional field is set still produce
 * distinct keys.
 *
 * @param {object} input
 * @param {AttentionKind} input.kind
 * @param {string} [input.projectSlug]
 * @param {string} [input.taskId]
 * @param {string} [input.jobId]
 * @param {string} [input.sessionId]
 * @param {string} [input.evidenceRef]
 * @returns {string}
 */
export function computeAttentionDedupeKey(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("computeAttentionDedupeKey: input object required");
  }
  const { kind, projectSlug, taskId, jobId, sessionId, evidenceRef } = input;
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error("computeAttentionDedupeKey: kind required (non-empty string)");
  }
  if (!ATTENTION_KINDS.includes(/** @type {AttentionKind} */ (kind))) {
    throw new Error(
      `computeAttentionDedupeKey: kind '${kind}' not in ATTENTION_KINDS`,
    );
  }
  return `${kind}|${projectSlug ?? ""}|${taskId ?? ""}|${jobId ?? ""}|${sessionId ?? ""}|${evidenceRef ?? ""}`;
}
