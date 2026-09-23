import { html } from "htm/preact";
import { TaskSessionBadge } from "./TaskSessionBadge.js";

export const TASK_CARD_STATE_ACTIONS = Object.freeze({
  unbound_runnable: Object.freeze(["+ RUN SESSION"]),
  bound_active: Object.freeze(["OPEN SESSION", "CHECKPOINT", "ROLLOVER"]),
  bound_quiet: Object.freeze(["OPEN SESSION", "PING", "ROLLOVER"]),
  done_active_job: Object.freeze(["CLOSEOUT", "VERIFY", "ARCHIVE SESSION"]),
  failed_abandoned: Object.freeze(["RESUME", "RUN SUCCESSOR"]),
  conflict: Object.freeze(["VIEW CONFLICT", "CREATE WORKTREE"]),
});

const QUIET_STATUSES = new Set(["quiet", "not_responding", "not responding", "stale"]);
const FAILED_STATUSES = new Set(["failed", "abandoned", "cancelled", "canceled"]);
const DONE_STATUSES = new Set(["complete", "done"]);

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lower(value) {
  return text(value).toLowerCase();
}

function hasActiveJob(task, session = null) {
  return Boolean(text(task?.activeJobId) || text(task?.jobId) || text(session?.activeJobId) || text(session?.jobId));
}

function hasConflict(task) {
  if (task?.hasConflict === true || task?.hasConflicts === true) return true;
  if (Array.isArray(task?.conflicts) && task.conflicts.length > 0) return true;
  if (Array.isArray(task?.conflictIds) && task.conflictIds.length > 0) return true;
  return false;
}

function boundSession(task, sessions = []) {
  if (isRecord(task?.activeSession)) return task.activeSession;
  if (isRecord(task?.session)) return task.session;
  const taskId = text(task?.id) || text(task?.taskId);
  const sessionId = text(task?.activeSessionId) || text(task?.sessionId);
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isRecord(session)) continue;
    if (sessionId && (text(session.id) || text(session.sessionId)) === sessionId) return session;
    if (taskId && (text(session.taskId) || text(session.activeTaskId)) === taskId) return session;
  }
  return null;
}

export function resolveTaskCardState({ task = null, sessions = [] } = {}) {
  if (!isRecord(task)) return "unbound_runnable";
  const session = boundSession(task, sessions);
  const taskStatus = lower(task.status);
  const sessionStatus = lower(session?.status);
  if (hasConflict(task)) return "conflict";
  if (FAILED_STATUSES.has(taskStatus) || FAILED_STATUSES.has(sessionStatus)) return "failed_abandoned";
  if (DONE_STATUSES.has(taskStatus) && hasActiveJob(task, session)) return "done_active_job";
  if (session) {
    if (QUIET_STATUSES.has(sessionStatus)) return "bound_quiet";
    return "bound_active";
  }
  return "unbound_runnable";
}

export function taskCardActionsForState(state) {
  return TASK_CARD_STATE_ACTIONS[state] || TASK_CARD_STATE_ACTIONS.unbound_runnable;
}

function taskTitle(task) {
  return text(task?.title) || text(task?.id) || "Task";
}

export function TaskCard({
  task = null,
  sessions = [],
  state = null,
  onAction,
} = {}) {
  const resolvedState = text(state) || resolveTaskCardState({ task, sessions });
  const actions = taskCardActionsForState(resolvedState);
  return html`
    <article class="project-task-card" data-task-id=${text(task?.id)} data-task-state=${resolvedState}>
      <header class="project-task-card__header">
        <strong class="project-task-card__title">${taskTitle(task)}</strong>
        <${TaskSessionBadge} task=${task} sessions=${sessions} />
      </header>
      <div class="project-task-card__actions" aria-label="Task card actions">
        ${actions.map((label) => html`
          <button
            key=${label}
            class="project-task-card__action"
            type="button"
            data-action=${label}
            onClick=${() => {
              if (typeof onAction === "function") {
                onAction({ action: label, state: resolvedState, task });
              }
            }}
          >
            [${label}]
          </button>
        `)}
      </div>
    </article>
  `;
}
