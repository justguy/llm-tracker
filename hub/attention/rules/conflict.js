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
      recommendedActions: [
        { id: "view_conflict", label: "View conflict", kind: "view_conflict", enabled: true },
        { id: "acknowledge", label: "Acknowledge", kind: "acknowledge", enabled: true },
      ],
    };
    if (typeof c.projectSlug === "string" && c.projectSlug.length > 0) {
      item.projectSlug = c.projectSlug;
    }
    if (typeof c.taskId === "string" && c.taskId.length > 0) item.taskId = c.taskId;
    if (typeof c.sessionId === "string" && c.sessionId.length > 0) item.sessionId = c.sessionId;
    out.push(item);
  }

  return out;
}
