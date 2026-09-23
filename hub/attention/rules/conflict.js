// hub/attention/rules/conflict.js — SH-4-03 (TDD v0.5 §8A.3, §9.4)
//
// Trigger: a `conflicts[]` entry from the ProjectWorkspaceWatcher (§9.4)
// whose kind is NOT `outside_allowed_paths` — that's a separate rule. We
// surface every other watcher-emitted conflict (e.g. `file_conflict`,
// `task_claim_conflict`, `shared_worktree`) as one AttentionItem per
// distinct conflict id.
//
// Source: `watcher_git` — per §8A.3 conflicts come from filesystem/git
// evidence, never agent self-reporting.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

/**
 * @param {{
 *   conflicts?: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function conflictRule(input) {
  if (!input || typeof input !== "object") return [];
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const c of conflicts) {
    if (!c || typeof c !== "object") continue;
    if (c.kind === "outside_allowed_paths") continue; // separate rule
    const ref =
      typeof c.id === "string" && c.id.length > 0
        ? c.id
        : typeof c.conflictId === "string" && c.conflictId.length > 0
          ? c.conflictId
          : undefined;
    if (!ref) continue; // no stable evidence anchor -> skip
    const dedupeKey = computeAttentionDedupeKey({
      kind: "conflict",
      projectSlug:
        typeof c.projectSlug === "string" && c.projectSlug.length > 0
          ? c.projectSlug
          : undefined,
      taskId: typeof c.taskId === "string" && c.taskId.length > 0 ? c.taskId : undefined,
      sessionId:
        typeof c.sessionId === "string" && c.sessionId.length > 0 ? c.sessionId : undefined,
      evidenceRef: ref,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const recommendedActions = recommendedActionsForConflict(c);
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "conflict",
      severity: "critical",
      title: "Workspace conflict",
      detail:
        typeof c.message === "string" && c.message.length > 0
          ? c.message
          : `Watcher reported conflict ${ref}${
              typeof c.kind === "string" ? ` (${c.kind})` : ""
            }.`,
      source: "watcher_git",
      evidenceRef: ref,
      clearCondition: "watcher/git evidence no longer shows the conflict, or human ack",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions,
    };
    if (typeof c.projectSlug === "string" && c.projectSlug.length > 0) {
      item.projectSlug = c.projectSlug;
    }
    if (typeof c.taskId === "string" && c.taskId.length > 0) item.taskId = c.taskId;
    if (typeof c.jobId === "string" && c.jobId.length > 0) item.jobId = c.jobId;
    if (typeof c.sessionId === "string" && c.sessionId.length > 0) item.sessionId = c.sessionId;
    if (typeof c.worktreePath === "string" && c.worktreePath.length > 0) item.worktreePath = c.worktreePath;
    if (typeof c.repoRoot === "string" && c.repoRoot.length > 0) item.repoRoot = c.repoRoot;
    if (Array.isArray(c.sessionIds)) {
      const sessionIds = c.sessionIds.filter((id) => typeof id === "string" && id.length > 0);
      if (sessionIds.length > 0) item.sessionIds = sessionIds;
    }
    out.push(item);
  }

  return out;
}

function recommendedActionsForConflict(conflict) {
  const incoming = Array.isArray(conflict?.recommendedActions)
    ? conflict.recommendedActions
    : [];
  const normalized = incoming
    .filter((action) => action && typeof action === "object")
    .map((action) => ({
      id: typeof action.id === "string" && action.id.length > 0 ? action.id : action.kind,
      label: typeof action.label === "string" && action.label.length > 0 ? action.label : action.kind,
      kind: action.kind,
      enabled: action.enabled !== false,
      ...(action.disabledReason && action.enabled === false ? { disabledReason: action.disabledReason } : {}),
    }))
    .filter((action) => typeof action.kind === "string" && action.kind.length > 0);

  if (normalized.length > 0) return normalized;
  if (conflict?.kind === "multiple_sessions_same_worktree") {
    return [
      { id: "create_worktree_for_job", label: "Create worktree for this job", kind: "create_worktree", enabled: true },
      { id: "acknowledge", label: "Acknowledge", kind: "acknowledge", enabled: true },
      { id: "open_conflicts", label: "Open conflicts", kind: "view_conflict", enabled: true },
    ];
  }
  return [
    { id: "view_conflict", label: "View conflict", kind: "view_conflict", enabled: true },
    { id: "acknowledge", label: "Acknowledge", kind: "acknowledge", enabled: true },
  ];
}
