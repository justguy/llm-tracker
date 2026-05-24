// hub/attention/rules/context_high.js — SH-4-03 (TDD v0.5 §8A.3, §7.4.5, §8.3)
//
// Trigger: a session carries a `context_high` SessionWarning (§8.3) with
// `source: "app_server" | "mcp"`. §8A.3 forbids deriving this from raw
// stdio. The warning itself originates only from a structured app-server
// `thread.context_usage` event or an MCP `tracker_session_context_usage`
// call (§7.4.5, §8.3 commentary), so a present warning is the structured
// signal we need.
//
// We also accept a structured `session.contextUsage = { percent, source }`
// field (parallel sh-4-09 may add this to the runtime projection) when
// `percent` exceeds the configured threshold and `source` is structured.
//
// Source: `structured`.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

const DEFAULT_THRESHOLD_PERCENT = 80;
const STRUCTURED_USAGE_SOURCES = new Set(["app_server", "mcp"]);

/**
 * @param {{
 *   sessions: object[],
 *   now: Date,
 *   config: object,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function contextHighRule(input) {
  if (!input || typeof input !== "object") return [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  const threshold = resolveThreshold(input.config);

  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;

    // Path 1: structured warning of kind "context_high".
    const warnings = Array.isArray(session.warnings) ? session.warnings : [];
    let warning = warnings.find(
      (w) =>
        w &&
        w.kind === "context_high" &&
        typeof w.source === "string" &&
        STRUCTURED_USAGE_SOURCES.has(w.source),
    );

    // Path 2: structured contextUsage field crosses the threshold.
    let usagePercent;
    let usageSource;
    if (
      !warning &&
      session.contextUsage &&
      typeof session.contextUsage === "object" &&
      typeof session.contextUsage.percent === "number" &&
      typeof session.contextUsage.source === "string" &&
      STRUCTURED_USAGE_SOURCES.has(session.contextUsage.source) &&
      session.contextUsage.percent >= threshold
    ) {
      usagePercent = session.contextUsage.percent;
      usageSource = session.contextUsage.source;
    }

    if (!warning && usagePercent === undefined) continue;

    const dedupeKey = computeAttentionDedupeKey({
      kind: "context_high",
      projectSlug:
        typeof session.projectSlug === "string" && session.projectSlug.length > 0
          ? session.projectSlug
          : undefined,
      sessionId: session.id,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const percent =
      warning && typeof warning.percent === "number" ? warning.percent : usagePercent;
    const sourceLabel =
      (warning && typeof warning.source === "string" ? warning.source : usageSource) || "structured";

    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "context_high",
      severity: "high",
      title: "Context window high",
      detail:
        typeof percent === "number"
          ? `Session ${session.id} context usage at ${percent}% (${sourceLabel}).`
          : `Session ${session.id} reports high context usage (${sourceLabel}).`,
      source: "structured",
      sessionId: session.id,
      clearCondition: "rollover, archive, or structured context drops below threshold",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "rollover", label: "Roll over", kind: "rollover", enabled: true },
        { id: "request_checkpoint", label: "Checkpoint", kind: "request_checkpoint", enabled: true },
        { id: "open_session", label: "Open session", kind: "open_session", enabled: true },
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

function resolveThreshold(cfg) {
  const v =
    cfg &&
    typeof cfg === "object" &&
    cfg.contextHigh &&
    typeof cfg.contextHigh === "object"
      ? cfg.contextHigh.thresholdPercent
      : undefined;
  if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100) return v;
  return DEFAULT_THRESHOLD_PERCENT;
}
