// hub/attention/rules/verify_missing.js — SH-4-03 (TDD v0.5 §8A.3, §11.6)
//
// Trigger: a JobRecord exists with no required verify-pack completion gate
// (i.e., the verify pack was never stamped, or all verify gates were
// dropped). Per §8A.3 raw stdio NEVER creates this; we read it from
// structured job state. We also accept a session/preflight warning with
// `kind === "verify_pack_empty"` carried in `input.warnings[]`.
//
// We restrict to jobs whose status indicates the verify pack should be
// present (`running`, `verifying`, `blocked`, `completed`) — a freshly
// queued job hasn't been stamped yet, and surfacing then would be noisy.
//
// Source: `structured`.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

const STAMP_EXPECTED_STATUSES = new Set([
  "running",
  "verifying",
  "blocked",
  "completed",
]);

/**
 * @param {{
 *   jobs?: object[],
 *   warnings?: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function verifyMissingRule(input) {
  if (!input || typeof input !== "object") return [];
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const warnings = Array.isArray(input.warnings) ? input.warnings : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || job.id.length === 0) continue;
    if (!STAMP_EXPECTED_STATUSES.has(job.status)) continue;
    const gates = Array.isArray(job.completionGates) ? job.completionGates : [];
    const hasRequiredVerify = gates.some(
      (g) => g && g.required === true && g.kind === "verify_pack",
    );
    if (hasRequiredVerify) continue;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "verify_missing",
      projectSlug:
        typeof job.projectSlug === "string" && job.projectSlug.length > 0
          ? job.projectSlug
          : undefined,
      taskId: typeof job.taskId === "string" && job.taskId.length > 0 ? job.taskId : undefined,
      jobId: job.id,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "verify_missing",
      severity: "medium",
      title: "Verify pack missing",
      detail: `Job ${job.id} has no required verify gate stamped.`,
      source: "structured",
      jobId: job.id,
      clearCondition: "verify pack stamped with at least one required gate",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "run_verify", label: "Stamp verify", kind: "run_verify", enabled: true },
        {
          id: "complete_override",
          label: "Override",
          kind: "complete_override",
          enabled: true,
        },
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

  // Path 2: explicit verify_pack_empty preflight warning (§8.3 / §8A.1).
  for (const w of warnings) {
    if (!w || w.kind !== "verify_pack_empty") continue;
    const jobId = typeof w.jobId === "string" && w.jobId.length > 0 ? w.jobId : undefined;
    const taskId = typeof w.taskId === "string" && w.taskId.length > 0 ? w.taskId : undefined;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "verify_missing",
      projectSlug:
        typeof w.projectSlug === "string" && w.projectSlug.length > 0
          ? w.projectSlug
          : undefined,
      taskId,
      jobId,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "verify_missing",
      severity: "medium",
      title: "Verify pack empty",
      detail: jobId
        ? `Job ${jobId} has an empty verify pack.`
        : "Verify pack is empty.",
      source: "structured",
      clearCondition: "verify pack populated with at least one required gate",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "run_verify", label: "Stamp verify", kind: "run_verify", enabled: true },
      ],
    };
    if (typeof w.projectSlug === "string" && w.projectSlug.length > 0) {
      item.projectSlug = w.projectSlug;
    }
    if (taskId) item.taskId = taskId;
    if (jobId) item.jobId = jobId;
    out.push(item);
  }

  return out;
}
