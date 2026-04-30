import { normalizeEffort, normalizeTaskReferences } from "./references.js";

const KNOWN_PRIORITY_WEIGHTS = {
  p0: 100,
  p1: 70,
  p2: 40,
  p3: 10
};

export const ACTIONABILITY_VALUES = ["executable", "blocked_by_task", "decision_gated", "parked"];

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

export function taskTags(task) {
  if (!Array.isArray(task?.context?.tags)) return [];
  return task.context.tags.filter((value) => typeof value === "string" && value.trim());
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function traceabilityEntry(values) {
  const entry = {};
  for (const [key, value] of Object.entries(values)) {
    const clean = cleanString(value);
    if (clean) entry[key] = clean;
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

export function taskTraceability(task) {
  const context = task?.context || {};
  const traceability = {};
  const roadmap = traceabilityEntry({
    section: context.roadmap_section || context.roadmapSection || context.roadmap,
    reference: context.roadmap_reference || context.roadmapReference
  });
  const executionReport = traceabilityEntry({
    title: context.execution_report || context.executionReport,
    reference: context.execution_report_reference || context.executionReportReference
  });
  const architecture = traceabilityEntry({
    title: context.architecture_truth_doc || context.architectureTruthDoc || context.architecture_doc,
    reference: context.architecture_reference || context.architectureReference
  });

  if (roadmap) traceability.roadmap = roadmap;
  if (executionReport) traceability.execution_report = executionReport;
  if (architecture) traceability.architecture = architecture;
  return traceability;
}

export function isAggregateTask(task, projectContext = {}) {
  const taskContext = task?.context || {};
  const tags = taskTags(task);
  const hasChildren =
    projectContext?.childParentIds instanceof Set ? projectContext.childParentIds.has(task?.id) : false;
  const hasSubtaskCounts =
    Number.isInteger(taskContext.task_count) ||
    Number.isInteger(taskContext.open_subtasks) ||
    Number.isInteger(taskContext.completed_subtasks);
  const hasRoadmapEnvelope =
    tags.includes("roadmap") &&
    typeof taskContext.source_title === "string" &&
    taskContext.source_title.trim().length > 0;

  return task?.kind === "group" || hasChildren || hasSubtaskCounts || hasRoadmapEnvelope;
}

export function blockingDependencies(task, context) {
  const byId = context?.byId instanceof Map ? context.byId : context instanceof Map ? context : new Map();
  return (task?.dependencies || []).filter((dep) => {
    const depTask = byId.get(dep);
    return depTask && depTask.status !== "complete" && !isAggregateTask(depTask, context);
  });
}

export function deriveActionability(task, context) {
  const blockedBy = blockingDependencies(task, context);
  const decisionRequired = taskRequiresApproval(task);
  const aggregate = isAggregateTask(task, context);

  if (task?.status === "complete" || task?.status === "deferred" || aggregate) {
    return {
      actionability: "parked",
      blocked_by: blockedBy,
      decision_required: decisionRequired,
      decision_reason: null,
      not_actionable_reason:
        task?.status === "complete"
          ? "Task is already complete."
          : task?.status === "deferred"
          ? "Task is deferred."
          : "Task is an aggregate container row, not directly executable."
    };
  }

  if (blockedBy.length > 0) {
    return {
      actionability: "blocked_by_task",
      blocked_by: blockedBy,
      decision_required: decisionRequired,
      decision_reason: null,
      not_actionable_reason: `Blocked by task${blockedBy.length === 1 ? "" : "s"}: ${blockedBy.join(", ")}.`
    };
  }

  if (decisionRequired.length > 0) {
    return {
      actionability: "decision_gated",
      blocked_by: [],
      decision_required: decisionRequired,
      decision_reason: `Decision required before execution: ${decisionRequired.join(", ")}.`,
      not_actionable_reason: `Decision required before execution: ${decisionRequired.join(", ")}.`
    };
  }

  return {
    actionability: "executable",
    blocked_by: [],
    decision_required: [],
    decision_reason: null,
    not_actionable_reason: null
  };
}

export function buildProjectTaskContext({ data, history = [] }) {
  const tasks = data?.tasks || [];
  return {
    byId: new Map(tasks.map((task) => [task.id, task])),
    childParentIds: new Set(
      tasks
        .map((task) => (typeof task.parent_id === "string" ? task.parent_id.trim() : ""))
        .filter(Boolean)
    ),
    currentRev: data?.meta?.rev ?? null,
    priorities: data?.meta?.priorities || [],
    touchMap: buildTaskTouchMap(history)
  };
}

export function summarizeTask(task, context) {
  const blockingOn = blockingDependencies(task, context);
  const dependenciesResolved = blockingOn.length === 0;
  const aggregate = isAggregateTask(task, context);
  const actionability = deriveActionability(task, context);
  const ready = actionability.actionability === "executable";
  const blockedKind =
    actionability.actionability === "blocked_by_task"
      ? "deps"
      : actionability.actionability === "decision_gated"
      ? "decision_gated"
      : actionability.actionability === "parked"
      ? "parked"
      : null;

  return {
    id: task.id,
    title: task.title,
    goal: task.goal || null,
    status: task.status,
    assignee: task.assignee ?? null,
    priorityId: task.placement?.priorityId ?? null,
    swimlaneId: task.placement?.swimlaneId ?? null,
    effort: normalizeEffort(task.effort),
    aggregate,
    actionability: actionability.actionability,
    actionable: ready,
    ready,
    blocked_kind: blockedKind,
    blocked_by: actionability.blocked_by,
    blocking_on: blockingOn,
    blocker_reason: taskBlockerReason(task),
    decision_required: actionability.decision_required,
    decision_reason: actionability.decision_reason,
    not_actionable_reason: actionability.not_actionable_reason,
    requires_approval: taskRequiresApproval(task),
    traceability: taskTraceability(task),
    dependenciesResolved,
    references: normalizeTaskReferences(task),
    comment: taskComment(task),
    lastTouchedRev: lastTouchedRevFor(task, context.touchMap),
    priorityWeight: priorityWeight(task.placement?.priorityId, context.priorities)
  };
}
