import { normalizeEffort, normalizeTaskReferences } from "./references.js";

const KNOWN_PRIORITY_WEIGHTS = {
  p0: 100,
  p1: 70,
  p2: 40,
  p3: 10
};

export function priorityWeight(priorityId, priorities = []) {
  if (KNOWN_PRIORITY_WEIGHTS[priorityId] !== undefined) {
    return KNOWN_PRIORITY_WEIGHTS[priorityId];
  }

  const idx = priorities.findIndex((p) => p.id === priorityId);
  if (idx === -1) return 0;
  return Math.max(10, 100 - idx * 20);
}

export function buildTaskTouchMap(history = []) {
  const out = new Map();
  for (const entry of history) {
    for (const taskId of Object.keys(entry?.delta?.tasks || {})) {
      out.set(taskId, entry.rev);
    }
  }
  return out;
}

export function lastTouchedRevFor(task, touchMap) {
  if (Number.isInteger(task?.rev)) return task.rev;
  return touchMap.get(task?.id) ?? null;
}

export function taskComment(task) {
  return typeof task?.comment === "string" && task.comment.trim() ? task.comment : null;
}

export function taskBlockerReason(task) {
  return typeof task?.blocker_reason === "string" && task.blocker_reason.trim()
    ? task.blocker_reason
    : null;
}

export function taskRequiresApproval(task) {
  if (!Array.isArray(task?.approval_required_for)) return [];
  return task.approval_required_for.filter((value) => typeof value === "string" && value.trim());
}

export function blockingDependencies(task, byId) {
  return (task?.dependencies || []).filter((dep) => {
    const depTask = byId.get(dep);
    return depTask && depTask.status !== "complete";
  });
}

export function buildProjectTaskContext({ data, history = [] }) {
  return {
    byId: new Map((data?.tasks || []).map((task) => [task.id, task])),
    currentRev: data?.meta?.rev ?? null,
    priorities: data?.meta?.priorities || [],
    touchMap: buildTaskTouchMap(history)
  };
}

export function summarizeTask(task, context) {
  const blockingOn = blockingDependencies(task, context.byId);
  const dependenciesResolved = blockingOn.length === 0;

  return {
    id: task.id,
    title: task.title,
    goal: task.goal || null,
    status: task.status,
    assignee: task.assignee ?? null,
    priorityId: task.placement?.priorityId ?? null,
    swimlaneId: task.placement?.swimlaneId ?? null,
    effort: normalizeEffort(task.effort),
    ready: dependenciesResolved,
    blocked_kind: dependenciesResolved ? null : "deps",
    blocking_on: blockingOn,
    blocker_reason: taskBlockerReason(task),
    requires_approval: taskRequiresApproval(task),
    dependenciesResolved,
    references: normalizeTaskReferences(task),
    comment: taskComment(task),
    lastTouchedRev: lastTouchedRevFor(task, context.touchMap),
    priorityWeight: priorityWeight(task.placement?.priorityId, context.priorities)
  };
}
