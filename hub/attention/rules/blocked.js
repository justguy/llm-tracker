// hub/attention/rules/blocked.js — SH-4-03 (TDD v0.5 §8A.3, §6.4)
//
// Trigger: a job carries `status === "blocked"`, OR a session carries
// `status === "blocked"` with a structured status source. §8A.3 forbids raw
// stdio from creating this kind — we require either a JobRecord status
// (structured by definition; jobs are durable) or a SessionRecord whose
// `statusSource.kind` is one of `app_server`/`mcp`/`http`/`human`.
//
// Source: `structured`.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

const STRUCTURED_STATUS_SOURCES = new Set(["app_server", "mcp", "http", "human"]);

/**
 * @param {{
 *   sessions: object[],
 *   jobs?: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function blockedRule(input) {
  if (!input || typeof input !== "object") return [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || job.id.length === 0) continue;
    if (job.status !== "blocked") continue;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "blocked",
      projectSlug:
        typeof job.projectSlug === "string" && job.projectSlug.length > 0
          ? job.projectSlug
          : undefined,
      taskId:
        typeof job.taskId === "string" && job.taskId.length > 0 ? job.taskId : undefined,
      jobId: job.id,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "blocked",
      severity: "high",
      title: "Job blocked",
      detail: `Job ${job.id} is blocked${
        typeof job.blockedReason === "string" && job.blockedReason.length > 0
          ? `: ${job.blockedReason}`
          : "."
      }`,
      source: "structured",
      jobId: job.id,
      clearCondition: "structured status change, human resolution, or job completion/cancel",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "unblock", label: "Unblock", kind: "unblock", enabled: true },
        { id: "open_session", label: "Open session", kind: "open_session", enabled: true },
      ],
    };
    if (typeof job.projectSlug === "string" && job.projectSlug.length > 0) {
      item.projectSlug = job.projectSlug;
    }
    if (typeof job.taskId === "string" && job.taskId.length > 0) item.taskId = job.taskId;
    if (typeof job.sessionId === "string" && job.sessionId.length > 0) {
      item.sessionId = job.sessionId;
    }
    out.push(item);
  }

  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;
    if (session.status !== "blocked") continue;
    const sourceKind =
      session.statusSource && typeof session.statusSource === "object"
        ? session.statusSource.kind
        : undefined;
    if (typeof sourceKind !== "string" || !STRUCTURED_STATUS_SOURCES.has(sourceKind)) {
      // No structured evidence -> skip (§8A.3).
      continue;
    }
    const dedupeKey = computeAttentionDedupeKey({
      kind: "blocked",
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
      kind: "blocked",
      severity: "high",
      title: "Session blocked",
      detail: `Session ${session.id} reports blocked status via ${sourceKind}.`,
      source: "structured",
      sessionId: session.id,
      clearCondition: "structured status change or human resolution",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "unblock", label: "Unblock", kind: "unblock", enabled: true },
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
