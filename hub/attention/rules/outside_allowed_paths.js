// hub/attention/rules/outside_allowed_paths.js — SH-4-03 (TDD v0.5 §8A.3, §9.4, §6.9.1)
//
// Trigger: a `conflicts[]` entry from the ProjectWorkspaceWatcher with
// `kind === "outside_allowed_paths"`. Per §8A.3 this rule MUST be sourced
// from watcher/git evidence — never from agent self-reporting. Each
// conflict id produces one AttentionItem.
//
// Source: `watcher_git`.

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
export function outsideAllowedPathsRule(input) {
  if (!input || typeof input !== "object") return [];
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const c of conflicts) {
    if (!c || typeof c !== "object") continue;
    if (c.kind !== "outside_allowed_paths") continue;
    const ref =
      typeof c.id === "string" && c.id.length > 0
        ? c.id
        : typeof c.conflictId === "string" && c.conflictId.length > 0
          ? c.conflictId
          : undefined;
    if (!ref) continue;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "outside_allowed_paths",
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
    const pathHint = Array.isArray(c.paths) && c.paths.length > 0
      ? c.paths.slice(0, 3).join(", ")
      : typeof c.path === "string" && c.path.length > 0
        ? c.path
        : "";
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "outside_allowed_paths",
      severity: "critical",
      title: "Writes outside allowed_paths",
      detail: pathHint.length > 0
        ? `Watcher reports writes outside allowed_paths: ${pathHint}.`
        : `Watcher reports writes outside allowed_paths (conflict ${ref}).`,
      source: "watcher_git",
      evidenceRef: ref,
      clearCondition: "watcher/git evidence no longer shows out-of-bounds writes, or human ack with reason",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        { id: "view_conflict", label: "View files", kind: "view_conflict", enabled: true },
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
