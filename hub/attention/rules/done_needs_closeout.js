// hub/attention/rules/done_needs_closeout.js — SH-4-03 (TDD v0.5 §8A.3, §11.5)
//
// Trigger: a JobRecord whose `status === "completed"` while one or more
// required completion gates of kind `handoff_created`, `required_skill`,
// or `dod_checked` are not yet `satisfied`/`overridden`. Per §8A.3 this
// kind reflects structured job state, so we only act on a JobRecord (jobs
// are durable structured records). Raw stdio NEVER creates this.
//
// Source: `structured`.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

const CLOSEOUT_GATE_KINDS = new Set([
  "handoff_created",
  "required_skill",
  "dod_checked",
]);

const SATISFIED_STATUSES = new Set(["satisfied", "overridden"]);

/**
 * @param {{
 *   jobs?: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function doneNeedsCloseoutRule(input) {
  if (!input || typeof input !== "object") return [];
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || job.id.length === 0) continue;
    if (job.status !== "completed") continue;
    const gates = Array.isArray(job.completionGates) ? job.completionGates : [];
    const missing = gates.filter(
      (g) =>
        g &&
        g.required === true &&
        CLOSEOUT_GATE_KINDS.has(g.kind) &&
        !SATISFIED_STATUSES.has(g.status),
    );
    if (missing.length === 0) continue;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "done_needs_closeout",
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
      kind: "done_needs_closeout",
      severity: "medium",
      title: "Job done; closeout pending",
      detail: `Job ${job.id} is complete but ${missing.length} closeout gate(s) remain (${missing
        .map((g) => g.kind)
        .join(", ")}).`,
      source: "structured",
      jobId: job.id,
      clearCondition: "closeout/handoff/archive gate satisfied or overridden",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "run_closeout", label: "Run closeout", kind: "run_closeout", enabled: true },
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

  return out;
}
