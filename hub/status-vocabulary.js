export const STATUS_VALUES = ["not_started", "in_progress", "complete", "deferred"];

export const LEGACY_STATUS_ALIASES = {
  partial: "in_progress"
};

function legacyStatusToCanonical(status) {
  if (typeof status !== "string") return null;
  return LEGACY_STATUS_ALIASES[status.trim().toLowerCase()] || null;
}

function noteNormalization(notes, taskId, from, to) {
  if (!notes?.warnings) return;
  notes.warnings.push(`tasks[${taskId}].status normalized legacy value "${from}" -> "${to}"`);
}

function normalizeTaskStatus(task, taskId, notes) {
  if (!task || typeof task !== "object" || !("status" in task)) return false;
  const normalized = legacyStatusToCanonical(task.status);
  if (!normalized || normalized === task.status) return false;
  noteNormalization(notes, taskId, task.status, normalized);
  task.status = normalized;
  return true;
}

export function normalizeProjectStatuses(input, notes = null) {
  if (!input || typeof input !== "object") return { data: input, changed: false };

  const cloned = JSON.parse(JSON.stringify(input));
  let changed = false;

  if (Array.isArray(cloned.tasks)) {
    cloned.tasks = cloned.tasks.map((task, index) => {
      const next = task && typeof task === "object" ? { ...task } : task;
      if (normalizeTaskStatus(next, next?.id || String(index), notes)) changed = true;
      return next;
    });
  } else if (cloned.tasks && typeof cloned.tasks === "object") {
    const nextTasks = {};
    for (const [taskId, task] of Object.entries(cloned.tasks)) {
      const next = task && typeof task === "object" ? { ...task } : task;
      if (normalizeTaskStatus(next, taskId, notes)) changed = true;
      nextTasks[taskId] = next;
    }
    cloned.tasks = nextTasks;
  }

  return { data: cloned, changed };
}
