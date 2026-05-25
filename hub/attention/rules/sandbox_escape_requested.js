// hub/attention/rules/sandbox_escape_requested.js — SH-4-11 (addendum §15, §8A.3)
//
// Trigger: a structured signal that an agent has requested elevated sandbox
// permission. We accept two structured inputs:
//
//   1. A session warning of kind `sandbox_escape_requested` (carried on
//      `session.warnings[]`). This kind is NOT yet in `WARNING_KINDS` in
//      `hub/sessions/warnings.js`; until it's added there, callers can still
//      attach a warning-shaped object to `session.warnings[]` and this rule
//      will surface it. The vocabulary gap is a follow-up.
//
//   2. A top-level `warnings[]` array entry (the engine input slot) whose
//      `kind === "sandbox_escape_requested"`. This covers signals routed
//      directly from the sandbox watcher / app-server before they're folded
//      into a session record.
//
// Per addendum §15 the severity is always `critical`. Per §8A.3 we never
// derive this kind from raw stdio — only structured evidence sources
// (app_server | mcp | human | sandbox_watcher) drive it.
//
// Source: `structured`.

import { computeAttentionDedupeKey } from "../dedupe.js";

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

/**
 * @param {{
 *   sessions?: object[],
 *   warnings?: object[],
 *   now: Date,
 *   makeId: (prefix: string) => string,
 * }} input
 * @returns {AttentionItem[]}
 */
export function sandboxEscapeRequestedRule(input) {
  if (!input || typeof input !== "object") return [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const topWarnings = Array.isArray(input.warnings) ? input.warnings : [];
  const now = input.now instanceof Date ? input.now : new Date();
  const nowIso = now.toISOString();
  /** @type {AttentionItem[]} */
  const out = [];
  const seen = new Set();

  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;
    const warnings = Array.isArray(session.warnings) ? session.warnings : [];
    for (const w of warnings) {
      if (!w || w.kind !== "sandbox_escape_requested") continue;
      const evidenceRef =
        typeof w.actionId === "string" && w.actionId.length > 0
          ? w.actionId
          : typeof w.eventId === "string" && w.eventId.length > 0
            ? w.eventId
            : undefined;
      const dedupeKey = computeAttentionDedupeKey({
        kind: "sandbox_escape_requested",
        projectSlug:
          typeof session.projectSlug === "string" && session.projectSlug.length > 0
            ? session.projectSlug
            : undefined,
        taskId:
          typeof session.taskId === "string" && session.taskId.length > 0
            ? session.taskId
            : undefined,
        sessionId: session.id,
        evidenceRef,
      });
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      /** @type {AttentionItem} */
      const item = {
        id: input.makeId("att"),
        kind: "sandbox_escape_requested",
        severity: "critical",
        title: "Sandbox escape requested",
        detail: `Session ${session.id} is requesting elevated sandbox permission${
          typeof w.source === "string" ? ` (${w.source})` : ""
        }.`,
        source: "structured",
        sessionId: session.id,
        clearCondition:
          "structured escape resolution (granted/denied) or human ack",
        createdAt: nowIso,
        updatedAt: nowIso,
        dedupeKey,
        recommendedActions: [
          {
            id: "escalate_sandbox",
            label: "Escalate sandbox",
            kind: "escalate_sandbox",
            enabled: true,
          },
          { id: "deny", label: "Deny", kind: "deny", enabled: true },
          {
            id: "restart_stricter_sandbox",
            label: "Restart with stricter sandbox",
            kind: "restart_stricter_sandbox",
            enabled: true,
          },
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

  for (const w of topWarnings) {
    if (!w || w.kind !== "sandbox_escape_requested") continue;
    const sessionId =
      typeof w.sessionId === "string" && w.sessionId.length > 0 ? w.sessionId : undefined;
    const evidenceRef =
      typeof w.actionId === "string" && w.actionId.length > 0
        ? w.actionId
        : typeof w.eventId === "string" && w.eventId.length > 0
          ? w.eventId
          : undefined;
    const dedupeKey = computeAttentionDedupeKey({
      kind: "sandbox_escape_requested",
      projectSlug:
        typeof w.projectSlug === "string" && w.projectSlug.length > 0
          ? w.projectSlug
          : undefined,
      taskId: typeof w.taskId === "string" && w.taskId.length > 0 ? w.taskId : undefined,
      sessionId,
      evidenceRef,
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    /** @type {AttentionItem} */
    const item = {
      id: input.makeId("att"),
      kind: "sandbox_escape_requested",
      severity: "critical",
      title: "Sandbox escape requested",
      detail: sessionId
        ? `Session ${sessionId} is requesting elevated sandbox permission${
            typeof w.source === "string" ? ` (${w.source})` : ""
          }.`
        : `Sandbox escape requested${
            typeof w.source === "string" ? ` (${w.source})` : ""
          }.`,
      source: "structured",
      clearCondition: "structured escape resolution (granted/denied) or human ack",
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupeKey,
      recommendedActions: [
        {
          id: "escalate_sandbox",
          label: "Escalate sandbox",
          kind: "escalate_sandbox",
          enabled: true,
        },
        { id: "deny", label: "Deny", kind: "deny", enabled: true },
        {
          id: "restart_stricter_sandbox",
          label: "Restart with stricter sandbox",
          kind: "restart_stricter_sandbox",
          enabled: true,
        },
      ],
    };
    if (typeof w.projectSlug === "string" && w.projectSlug.length > 0) {
      item.projectSlug = w.projectSlug;
    }
    if (typeof w.taskId === "string" && w.taskId.length > 0) item.taskId = w.taskId;
    if (sessionId) item.sessionId = sessionId;
    if (evidenceRef) item.evidenceRef = evidenceRef;
    out.push(item);
  }

  return out;
}
