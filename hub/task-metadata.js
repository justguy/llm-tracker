import { normalizeEffort, normalizeTaskReferences } from "./references.js";
import { parseDependencyRef } from "./cross-project-deps.js";

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

function approvalsFromRepos(task) {
  const list = task?.repos?.approval_required_for;
  if (!Array.isArray(list)) return [];
  return list
    .filter((value) => typeof value === "string" && value.trim())
    .map((repo) => `repo:${repo.trim()}`);
}

export function taskRequiresApproval(task) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };

  if (Array.isArray(task?.approval_required_for)) {
    for (const value of task.approval_required_for) {
      if (typeof value === "string" && value.trim()) push(value.trim());
    }
  }
  for (const value of approvalsFromRepos(task)) {
    push(value);
  }
  return out;
}

export function taskRepos(task) {
  const repos = task?.repos;
  if (!repos || typeof repos !== "object") return null;

  const primary = typeof repos.primary === "string" && repos.primary.trim() ? repos.primary.trim() : null;
  const secondary = Array.isArray(repos.secondary)
    ? repos.secondary.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
    : [];
  const allowedPathsRaw = repos.allowed_paths && typeof repos.allowed_paths === "object" ? repos.allowed_paths : null;
  const allowedPaths = {};
  if (allowedPathsRaw) {
    for (const [repo, paths] of Object.entries(allowedPathsRaw)) {
      if (!Array.isArray(paths)) continue;
      const cleaned = paths.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
      if (cleaned.length > 0) allowedPaths[repo] = cleaned;
    }
  }
  const approvalRequiredFor = Array.isArray(repos.approval_required_for)
    ? repos.approval_required_for
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    : [];

  if (!primary && secondary.length === 0 && Object.keys(allowedPaths).length === 0 && approvalRequiredFor.length === 0) {
    return null;
  }

  return {
    primary,
    secondary,
    allowed_paths: allowedPaths,
    approval_required_for: approvalRequiredFor
  };
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
  const externalLookup =
    typeof context?.externalLookup === "function" ? context.externalLookup : null;

  return (task?.dependencies || []).filter((dep) => {
    const ref = parseDependencyRef(dep);
    if (!ref) return false;
    if (ref.kind === "external") {
      if (!externalLookup) return true; // unknown external dep is treated as blocking
      const resolved = externalLookup(ref.slug, ref.taskId);
      // Treat missing external tasks as blocking too — agents/humans should
      // notice the broken reference rather than have it silently unblock.
      if (!resolved || !resolved.exists) return true;
      return resolved.status !== "complete";
    }
    const depTask = byId.get(ref.taskId);
    return depTask && depTask.status !== "complete" && !isAggregateTask(depTask, context);
  });
}

export function externalDependencyDetails(task, context) {
  const externalLookup =
    typeof context?.externalLookup === "function" ? context.externalLookup : null;
  const out = [];
  for (const dep of task?.dependencies || []) {
    const ref = parseDependencyRef(dep);
    if (!ref || ref.kind !== "external") continue;
    const resolved = externalLookup ? externalLookup(ref.slug, ref.taskId) : null;
    out.push({
      raw: ref.raw,
      slug: ref.slug,
      taskId: ref.taskId,
      exists: resolved?.exists === true,
      status: resolved?.status ?? null,
      title: resolved?.title ?? null,
      blocking: !resolved || !resolved.exists || resolved.status !== "complete"
    });
  }
  return out;
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

export function buildProjectTaskContext({ data, history = [], externalLookup = null }) {
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
    touchMap: buildTaskTouchMap(history),
    externalLookup: typeof externalLookup === "function" ? externalLookup : null,
    slug: data?.meta?.slug || null
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
    repos: taskRepos(task),
    external_dependencies: externalDependencyDetails(task, context),
    traceability: taskTraceability(task),
    dependenciesResolved,
    references: normalizeTaskReferences(task),
    comment: taskComment(task),
    lastTouchedRev: lastTouchedRevFor(task, context.touchMap),
    priorityWeight: priorityWeight(task.placement?.priorityId, context.priorities)
  };
}
