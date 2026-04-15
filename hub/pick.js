import { buildNextPayload } from "./next.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

function blockedMessage(summary) {
  if (summary.blocking_on.length === 0) {
    return `task "${summary.id}" is not ready to pick`;
  }
  return `task "${summary.id}" is blocked on dependencies: ${summary.blocking_on.join(", ")}`;
}

function assigneeConflict(summary, assignee) {
  if (summary.status !== "in_progress" || !summary.assignee) return null;
  if (!assignee) {
    return `task "${summary.id}" is already in progress by ${summary.assignee}; pass --assignee ${summary.assignee} or force the claim`;
  }
  if (assignee !== summary.assignee) {
    return `task "${summary.id}" is already in progress by ${summary.assignee}`;
  }
  return null;
}

function validatePickCandidate(summary, { assignee = null, force = false } = {}) {
  if (!summary) {
    return { ok: false, status: 404, message: "task not found" };
  }
  if (summary.status === "complete" || summary.status === "deferred") {
    return {
      ok: false,
      status: 409,
      message: `task "${summary.id}" cannot be picked from status ${summary.status}`
    };
  }
  if (!summary.ready && !force) {
    return {
      ok: false,
      status: 409,
      message: blockedMessage(summary)
    };
  }
  const conflict = assigneeConflict(summary, assignee);
  if (conflict && !force) {
    return {
      ok: false,
      status: 409,
      message: conflict
    };
  }
  return { ok: true };
}

export function resolvePickSelection({
  slug,
  data,
  history = [],
  taskId,
  assignee = null,
  force = false
}) {
  const context = buildProjectTaskContext({ data, history });

  if (taskId) {
    const task = context.byId.get(taskId);
    const summary = task ? summarizeTask(task, context) : null;
    const verdict = validatePickCandidate(summary, { assignee, force });
    if (!verdict.ok) return verdict;
    return {
      ok: true,
      taskId: summary.id,
      autoSelected: false,
      selectedBecause: "explicit task selection",
      task: summary
    };
  }

  const next = buildNextPayload({ slug, data, history, limit: 5 });
  let firstConflict = null;
  for (const candidate of next.next) {
    if (!candidate.ready) continue;
    const verdict = validatePickCandidate(candidate, { assignee, force });
    if (verdict.ok) {
      return {
        ok: true,
        taskId: candidate.id,
        autoSelected: true,
        selectedBecause: candidate.reason?.[0] || "top ready task from next ranking",
        task: candidate
      };
    }
    if (!firstConflict) firstConflict = verdict;
  }

  return (
    firstConflict || {
      ok: false,
      status: 409,
      message: "no ready task available to pick"
    }
  );
}

export function buildPickedPayload({
  slug,
  data,
  history = [],
  taskId,
  autoSelected = false,
  selectedBecause = null,
  noop = false,
  now = new Date().toISOString()
}) {
  const context = buildProjectTaskContext({ data, history });
  const task = context.byId.get(taskId);
  if (!task) return null;

  return {
    project: slug,
    rev: data?.meta?.rev ?? null,
    generatedAt: now,
    pickedTaskId: taskId,
    autoSelected,
    noop,
    selectedBecause,
    task: summarizeTask(task, context)
  };
}
