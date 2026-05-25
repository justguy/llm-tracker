// hub/attention/rules/not_responding.js — SH-4-03 (TDD v0.5 §8A.3, §8.3, §6.1)
//
// Trigger: a session carries a `missing_heartbeat` SessionWarning (§8.3) —
// i.e., the ActivityMonitor decided a session that was expected to emit
// structured heartbeats has gone silent past the configured threshold. Per
// §8A.3 we surface this as `not_responding`.
//
// Source: depends on `session.capabilityTier` (§6.1):
//   - `mcp` / `explicit`           -> `structured` (the missing-heartbeat
//                                     signal came from a contract violation
//                                     by a structured-capable agent).
//   - `dumb` / `hybrid` / others   -> `reported`   (we expected a heartbeat
//                                     but the tier itself doesn't guarantee
//                                     structured delivery).

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

const STRUCTURED_TIERS = new Set(["mcp", "explicit"]);

/**
 * @param {{
 *   sessions: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function notRespondingRule(input) {
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
    const heartbeat = warnings.find((w) => w && w.kind === "missing_heartbeat");
    if (!heartbeat) continue;
    const tier = session.capabilityTier;
    /** @type {"structured" | "reported"} */
    const source =
      typeof tier === "string" && STRUCTURED_TIERS.has(tier) ? "structured" : "reported";
    const dedupeKey = computeAttentionDedupeKey({
      kind: "not_responding",
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
      kind: "not_responding",
      severity: "high",
      title: "Session not responding",
      detail:
        typeof heartbeat.minutes === "number"
          ? `Session ${session.id} missed structured heartbeats for ${heartbeat.minutes}m.`
          : `Session ${session.id} missed structured heartbeats.`,
      source,
      sessionId: session.id,
      clearCondition: "next structured heartbeat or event",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "open_session", label: "Open session", kind: "open_session", enabled: true },
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
    if (typeof session.activeJobId === "string" && session.activeJobId.length > 0) {
      item.jobId = session.activeJobId;
    }
    out.push(item);
  }

  return out;
}
