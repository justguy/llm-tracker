// hub/attention/rules/quiet.js — SH-4-03 (TDD v0.5 §8A.3, §8.3)
//
// Trigger: a session carries a `quiet_terminal` SessionWarning (§8.3) — the
// ActivityMonitor's derived signal that a dumb-terminal session hasn't
// produced raw output recently. Per §8A.3 dumb-terminal silence may create
// `quiet` with source `derived`. We MUST NOT raise `quiet` from raw stdio
// content; the trigger is the derived warning, not the absence of bytes.
//
// Source: `derived`.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

/**
 * @param {{
 *   sessions: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function quietRule(input) {
  if (!input || typeof input !== "object") return [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;
    const warnings = Array.isArray(session.warnings) ? session.warnings : [];
    const quiet = warnings.find((w) => w && w.kind === "quiet_terminal");
    if (!quiet) continue;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "quiet",
      projectSlug:
        typeof session.projectSlug === "string" && session.projectSlug.length > 0
          ? session.projectSlug
          : undefined,
      sessionId: session.id,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "quiet",
      severity: "low",
      title: "Quiet terminal",
      detail:
        typeof quiet.minutes === "number"
          ? `Session ${session.id} has had no raw output for ${quiet.minutes}m.`
          : `Session ${session.id} has had no recent raw output; check terminal.`,
      source: "derived",
      sessionId: session.id,
      clearCondition: "next raw output for dumb-terminal sessions",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "open_stdio", label: "Open stdio", kind: "open_stdio", enabled: true },
        { id: "interrupt", label: "Interrupt", kind: "interrupt", enabled: true },
        { id: "snooze", label: "Snooze", kind: "snooze", enabled: true },
      ],
    };
    if (typeof session.projectSlug === "string" && session.projectSlug.length > 0) {
      item.projectSlug = session.projectSlug;
    }
    if (typeof session.taskId === "string" && session.taskId.length > 0) {
      item.taskId = session.taskId;
    }
    out.push(item);
  }

  return out;
}
