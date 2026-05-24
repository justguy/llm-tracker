// hub/attention/rules/done_claimed_verify_missing.js — SH-4-03 (TDD v0.5 §8A.3, §11.5, §23.2 #12)
//
// Trigger: the tracker says a task is complete (`trackerSnapshot.tasks[]`
// with `status === "complete"`) while the cross-referenced job's required
// verify gates have NOT been satisfied. This is the §23.2 #12 contract:
// raw `tracker_task_set_status: complete` bypasses the UI gate flow and
// produces a `done_claimed_verify_missing` AttentionItem on the active job.
//
// We cross-reference jobs to the tracker task by `jobId` (preferred) or
// `taskId` (fallback). When a task is complete but no matching job exists,
// we still surface the item — the structured evidence is the tracker
// snapshot itself.
//
// Source: `structured` — the tracker is durable structured state.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

const SATISFIED_STATUSES = new Set(["satisfied", "overridden"]);

/**
 * @param {{
 *   jobs?: object[],
 *   trackerSnapshot?: object,
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function doneClaimedVerifyMissingRule(input) {
  if (!input || typeof input !== "object") return [];
  const trackerSnapshot =
    input.trackerSnapshot && typeof input.trackerSnapshot === "object"
      ? input.trackerSnapshot
      : {};
  const tasks = Array.isArray(trackerSnapshot.tasks) ? trackerSnapshot.tasks : [];
  if (tasks.length === 0) return [];
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if (task.status !== "complete") continue;
    const taskId = typeof task.id === "string" && task.id.length > 0 ? task.id : undefined;
    if (!taskId) continue;
    const projectSlug =
      typeof task.projectSlug === "string" && task.projectSlug.length > 0
        ? task.projectSlug
        : undefined;

    const job = jobs.find((j) => j && (j.taskId === taskId || j.id === task.jobId));
    const gates = job && Array.isArray(job.completionGates) ? job.completionGates : [];
    const verifyGates = gates.filter((g) => g && g.kind === "verify_pack" && g.required === true);

    // Decide whether verify evidence is missing:
    //  - No job found            -> missing (tracker bypassed job flow entirely).
    //  - No verify gates         -> missing (verify pack never stamped).
    //  - Any required verify gate not satisfied/overridden -> missing.
    let missing;
    if (!job) {
      missing = "no_job";
    } else if (verifyGates.length === 0) {
      missing = "no_verify_pack";
    } else if (verifyGates.some((g) => !SATISFIED_STATUSES.has(g.status))) {
      missing = "verify_gates_unmet";
    } else {
      continue; // all required verify gates satisfied
    }

    const dedupeKey = computeAttentionDedupeKey({
      kind: "done_claimed_verify_missing",
      projectSlug,
      taskId,
      jobId: job && typeof job.id === "string" ? job.id : undefined,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "done_claimed_verify_missing",
      severity: "high",
      title: "Task marked complete; verify evidence missing",
      detail: `Tracker says task ${taskId} is complete but verify evidence is missing (${missing}).`,
      source: "structured",
      taskId,
      clearCondition: "verify gates satisfied or task status changed",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "run_verify", label: "Run verify", kind: "run_verify", enabled: true },
        {
          id: "complete_override",
          label: "Override with reason",
          kind: "complete_override",
          enabled: true,
        },
      ],
    };
    if (projectSlug) item.projectSlug = projectSlug;
    if (job && typeof job.id === "string" && job.id.length > 0) item.jobId = job.id;
    if (job && typeof job.sessionId === "string" && job.sessionId.length > 0) {
      item.sessionId = job.sessionId;
    }
    out.push(item);
  }

  return out;
}
