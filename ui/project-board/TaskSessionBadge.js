import { html } from "htm/preact";

const TERMINAL_SESSION_STATUSES = new Set(["done", "stopped", "archived", "failed", "cancelled"]);

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function taskIdOf(task) {
  return text(task?.id) || text(task?.taskId);
}

function sessionIdOf(session) {
  return text(session?.id) || text(session?.sessionId);
}

function sessionTaskId(session) {
  return text(session?.taskId) ||
    text(session?.activeTaskId) ||
    text(session?.task?.id) ||
    text(session?.activeJob?.taskId);
}

function taskSessionId(task) {
  return text(task?.sessionId) ||
    text(task?.activeSessionId) ||
    text(task?.session?.id) ||
    text(task?.activeSession?.id);
}

function isActiveSession(session) {
  if (!isRecord(session)) return false;
  const status = text(session.status).toLowerCase();
  if (TERMINAL_SESSION_STATUSES.has(status)) return false;
  return Boolean(sessionIdOf(session));
}

function taskEmbeddedSession(task) {
  if (isRecord(task?.activeSession)) return task.activeSession;
  if (isRecord(task?.session)) return task.session;
  return null;
}

export function findTaskSession(task, sessions = []) {
  if (!isRecord(task)) return null;
  const embedded = taskEmbeddedSession(task);
  if (isActiveSession(embedded)) return embedded;
  const targetTaskId = taskIdOf(task);
  const targetSessionId = taskSessionId(task);
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isActiveSession(session)) continue;
    if (targetSessionId && sessionIdOf(session) === targetSessionId) return session;
    if (targetTaskId && sessionTaskId(session) === targetTaskId) return session;
  }
  return null;
}

export function formatSessionActivity(value) {
  const raw = text(value);
  if (!raw) return "activity unknown";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

export function taskSessionBadgeModel({ task, sessions = [] } = {}) {
  const session = findTaskSession(task, sessions);
  if (!session) return null;
  return {
    sessionId: sessionIdOf(session),
    taskId: taskIdOf(task) || sessionTaskId(session),
    tier: text(session.tier) || text(session.runtime) || "session",
    status: text(session.status) || "unknown",
    lastActivity: formatSessionActivity(session.lastActivityAt || session.lastActivity || session.updatedAt || session.ts),
  };
}

export function TaskSessionBadgeView({ model = null } = {}) {
  if (!model) return null;
  return html`
    <span
      class="task-session-badge"
      data-session-id=${model.sessionId}
      data-task-id=${model.taskId || ""}
      title=${`${model.tier} ${model.status} ${model.lastActivity}`}
    >
      <span class="task-session-badge__tier">${model.tier}</span>
      <span class=${`task-session-badge__status task-session-badge__status--${model.status}`}>${model.status}</span>
      <span class="task-session-badge__activity">${model.lastActivity}</span>
    </span>
  `;
}

export function TaskSessionBadge({ task = null, sessions = [] } = {}) {
  return html`<${TaskSessionBadgeView} model=${taskSessionBadgeModel({ task, sessions })} />`;
}
