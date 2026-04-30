import { buildBriefPayload, getBriefPayload } from "./briefs.js";

function executionContract(task) {
  return {
    definition_of_done: task.definition_of_done || [],
    constraints: task.constraints || [],
    expected_changes: task.expected_changes || [],
    allowed_paths: task.allowed_paths || [],
    approval_required_for: task.requires_approval || [],
    traceability: task.traceability || {}
  };
}

function buildExecutionPlan(task, references = []) {
  const plan = [];

  if (task.actionability === "executable" || task.ready) {
    plan.push({
      kind: "start",
      text: "Task is ready for execution now"
    });
  } else if (task.actionability === "blocked_by_task" || task.blocked_by?.length > 0 || task.blocking_on?.length > 0) {
    plan.push({
      kind: "blockers",
      text: `Resolve blockers first: ${(task.blocked_by || task.blocking_on || []).join(", ")}`
    });
  } else if (task.actionability === "decision_gated") {
    plan.push({
      kind: "decision_required",
      text: task.decision_reason || `Stop for decision before execution: ${(task.decision_required || []).join(", ")}`
    });
  } else if (task.actionability === "parked") {
    plan.push({
      kind: "parked",
      text: task.not_actionable_reason || "Task is not currently actionable"
    });
  }

  for (const path of task.expected_changes || []) {
    plan.push({
      kind: "expected_change",
      text: `Expect to touch ${path}`
    });
  }

  if ((task.allowed_paths || []).length > 0) {
    plan.push({
      kind: "allowed_paths",
      text: `Keep edits within ${task.allowed_paths.join(", ")}`
    });
  }

  for (const constraint of task.constraints || []) {
    plan.push({
      kind: "constraint",
      text: constraint
    });
  }

  for (const approval of task.requires_approval || []) {
    plan.push({
      kind: "approval",
      text: `Stop for approval before: ${approval}`
    });
  }

  if (references.length > 0) {
    plan.push({
      kind: "reading_list",
      text: `Start from ${references.map((reference) => reference.value).join(", ")}`
    });
  }

  for (const item of task.definition_of_done || []) {
    plan.push({
      kind: "done_when",
      text: item
    });
  }

  return plan;
}

export function buildExecutePayload({
  slug,
  data,
  history = [],
  taskId,
  references = null,
  snippets = [],
  now = new Date().toISOString()
}) {
  const brief = buildBriefPayload({
    slug,
    data,
    history,
    taskId,
    references,
    snippets,
    now
  });
  if (!brief) return null;

  return {
    ...brief,
    packType: "execute",
    readiness: {
      actionability: brief.task.actionability,
      actionable: brief.task.actionable,
      ready: brief.task.ready,
      blocked_kind: brief.task.blocked_kind,
      blocked_by: brief.task.blocked_by,
      blocking_on: brief.task.blocking_on,
      decision_required: brief.task.decision_required,
      decision_reason: brief.task.decision_reason,
      not_actionable_reason: brief.task.not_actionable_reason,
      requires_approval: brief.task.requires_approval
    },
    executionContract: executionContract(brief.task),
    executionPlan: buildExecutionPlan(brief.task, brief.references)
  };
}

export function getExecutePayload({ workspace, slug, entry, taskId, now }) {
  const result = getBriefPayload({ workspace, slug, entry, taskId, now });
  if (!result.ok) return result;

  return {
    ok: true,
    payload: {
      ...result.payload,
      packType: "execute",
      readiness: {
        actionability: result.payload.task.actionability,
        actionable: result.payload.task.actionable,
        ready: result.payload.task.ready,
        blocked_kind: result.payload.task.blocked_kind,
        blocked_by: result.payload.task.blocked_by,
        blocking_on: result.payload.task.blocking_on,
        decision_required: result.payload.task.decision_required,
        decision_reason: result.payload.task.decision_reason,
        not_actionable_reason: result.payload.task.not_actionable_reason,
        requires_approval: result.payload.task.requires_approval
      },
      executionContract: executionContract(result.payload.task),
      executionPlan: buildExecutionPlan(result.payload.task, result.payload.references)
    }
  };
}
