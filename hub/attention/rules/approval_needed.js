// hub/attention/rules/approval_needed.js — SH-4-03 (TDD v0.5 §8A.3, §6.8)
//
// Trigger: a session carries a structured `approval_needed` warning, OR an
// active job's verify-pack human-approval gate is pending. Per §8A.3 raw
// stdio NEVER creates this kind — we require structured evidence carried on
// `session.warnings[].kind === "approval_needed"` (where the warning's
// `source` is `app_server` | `mcp` | `human` per §8.3), or a CompletionGate
// with `kind: "verify_pack"` referencing a human-approval check that is
// still pending.
//
// Source: `structured` — all entry points originate from app-server, MCP,
// or recorded human resolution events.
//
// Clear: handled by absence in subsequent ticks (the warning/gate is gone).

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

/**
 * @param {{
 *   sessions: object[],
 *   jobs?: object[],
 *   warnings?: object[],
 *   conflicts?: object[],
 *   trackerSnapshot?: object,
 *   now: Date,
 *   config: object,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function approvalNeededRule(input) {
  if (!input || typeof input !== "object") return [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;
    const warnings = Array.isArray(session.warnings) ? session.warnings : [];
    for (const w of warnings) {
      if (!w || w.kind !== "approval_needed") continue;
      const evidenceRef =
        typeof w.actionId === "string" && w.actionId.length > 0 ? w.actionId : undefined;
      const dedupeKey = computeAttentionDedupeKey({
        kind: "approval_needed",
        projectSlug:
          typeof session.projectSlug === "string" && session.projectSlug.length > 0
            ? session.projectSlug
            : undefined,
        sessionId: session.id,
        evidenceRef,
      });
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      /** @type {AttentionItem} */
      const item = {
        id: input.makeId("att"),
        kind: "approval_needed",
        severity: "critical",
        title: "Approval needed",
        detail: `Session ${session.id} is waiting for approval${
          typeof w.source === "string" ? ` (${w.source})` : ""
        }.`,
        source: "structured",
        sessionId: session.id,
        clearCondition: "structured approval resolution or human clear",
        createdAt: nowIso,
        updatedAt: nowIso,
        dedupeKey,
        recommendedActions: [
          { id: "approve", label: "Approve", kind: "approve", enabled: true },
          { id: "deny", label: "Deny", kind: "deny", enabled: true },
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
      if (evidenceRef) item.evidenceRef = evidenceRef;
      out.push(item);
    }
  }

  // Pending human-approval verify gate (§11.5 / §11.6 CompletionGate).
  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || job.id.length === 0) continue;
    const requestedItemIds = new Set();
    const requests = Array.isArray(job.humanApprovalRequests) ? job.humanApprovalRequests : [];
    for (const request of requests) {
      if (!request || request.status !== "pending") continue;
      if (typeof request.itemId !== "string" || request.itemId.length === 0) continue;
      requestedItemIds.add(request.itemId);
      const evidenceRef =
        typeof request.eventId === "string" && request.eventId.length > 0 ? request.eventId : undefined;
      const blocksCompletion = request.blocksCompletion === true || request.required === true;
      const title =
        typeof request.title === "string" && request.title.length > 0
          ? request.title
          : blocksCompletion
            ? "HUMAN APPROVAL REQUIRED"
            : "HUMAN REVIEW READY";
      const dedupeKey = computeAttentionDedupeKey({
        kind: "approval_needed",
        projectSlug:
          typeof job.projectSlug === "string" && job.projectSlug.length > 0
            ? job.projectSlug
            : undefined,
        taskId:
          typeof job.taskId === "string" && job.taskId.length > 0 ? job.taskId : undefined,
        jobId: job.id,
        evidenceRef,
      });
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      /** @type {AttentionItem} */
      const item = {
        id: input.makeId("att"),
        kind: "approval_needed",
        severity: blocksCompletion ? "critical" : "medium",
        title,
        detail:
          typeof request.prompt === "string" && request.prompt.length > 0
            ? request.prompt
            : `Job ${job.id} has a human-approval verify item ready.`,
        source: "structured",
        jobId: job.id,
        clearCondition: "structured approval resolution or human clear",
        createdAt: nowIso,
        updatedAt: nowIso,
        dedupeKey,
        recommendedActions: [
          { id: "approve", label: "Approve", kind: "approve", enabled: true },
          { id: "deny", label: "Deny", kind: "deny", enabled: true },
          { id: "open_session", label: "Open session", kind: "open_session", enabled: true },
        ],
      };
      if (typeof job.projectSlug === "string" && job.projectSlug.length > 0) {
        item.projectSlug = job.projectSlug;
      }
      if (typeof job.taskId === "string" && job.taskId.length > 0) {
        item.taskId = job.taskId;
      }
      if (typeof job.sessionId === "string" && job.sessionId.length > 0) {
        item.sessionId = job.sessionId;
      }
      if (evidenceRef) item.evidenceRef = evidenceRef;
      out.push(item);
    }

    const gates = Array.isArray(job.completionGates) ? job.completionGates : [];
    for (const gate of gates) {
      if (!gate || gate.kind !== "verify_pack") continue;
      if (requestedItemIds.has(gate.id)) continue;
      if (gate.status !== "pending") continue;
      if (gate.required !== true) continue;
      const ref = typeof gate.id === "string" && gate.id.length > 0 ? gate.id : undefined;
      // Only surface gates that explicitly require human approval. The verify
      // pack composition (§11.6.3) maps human_approval VerifyPackItems to
      // verify_pack gates; we distinguish via `gate.humanApproval === true`
      // or a `requiresHuman: true` flag where present. Absent that signal,
      // skip — that's a generic verify gate, not an approval request.
      const isHumanApproval =
        gate.humanApproval === true || gate.requiresHuman === true;
      if (!isHumanApproval) continue;
      const dedupeKey = computeAttentionDedupeKey({
        kind: "approval_needed",
        projectSlug:
          typeof job.projectSlug === "string" && job.projectSlug.length > 0
            ? job.projectSlug
            : undefined,
        taskId:
          typeof job.taskId === "string" && job.taskId.length > 0 ? job.taskId : undefined,
        jobId: job.id,
        evidenceRef: ref,
      });
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      /** @type {AttentionItem} */
      const item = {
        id: input.makeId("att"),
        kind: "approval_needed",
        severity: "critical",
        title: "Human approval required",
        detail: `Job ${job.id} has a required human-approval verify gate pending.`,
        source: "structured",
        jobId: job.id,
        clearCondition: "human approval gate resolved (satisfied or overridden)",
        createdAt: nowIso,
        updatedAt: nowIso,
        dedupeKey,
        recommendedActions: [
          { id: "approve", label: "Approve", kind: "approve", enabled: true },
          { id: "deny", label: "Deny", kind: "deny", enabled: true },
        ],
      };
      if (typeof job.projectSlug === "string" && job.projectSlug.length > 0) {
        item.projectSlug = job.projectSlug;
      }
      if (typeof job.taskId === "string" && job.taskId.length > 0) {
        item.taskId = job.taskId;
      }
      if (typeof job.sessionId === "string" && job.sessionId.length > 0) {
        item.sessionId = job.sessionId;
      }
      if (ref) item.evidenceRef = ref;
      out.push(item);
    }
  }

  return out;
}
