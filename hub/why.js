import { buildWorkspaceLookup } from "./cross-project-deps.js";
import { readHistory } from "./snapshots.js";
import { selectBriefReferences } from "./briefs.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const WHY_HISTORY_LIMIT = 3;

function stringArray(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string" && value.trim());
}

function summarizeTaskForWhy(task, context) {
  const summary = summarizeTask(task, context);
  return {
    id: summary.id,
    title: summary.title,
    goal: task.goal || null,
    status: summary.status,
    assignee: summary.assignee,
    priorityId: summary.priorityId,
    swimlaneId: summary.swimlaneId,
    effort: summary.effort,
    actionability: summary.actionability,
    actionable: summary.actionable,
    ready: summary.ready,
    blocked_kind: summary.blocked_kind,
    blocked_by: summary.blocked_by,
    blocking_on: summary.blocking_on,
    blocker_reason: summary.blocker_reason,
    decision_required: summary.decision_required,
    decision_reason: summary.decision_reason,
    not_actionable_reason: summary.not_actionable_reason,
    requires_approval: summary.requires_approval,
    repos: summary.repos,
    external_dependencies: summary.external_dependencies,
    traceability: summary.traceability,
    comment: summary.comment,
    lastTouchedRev: summary.lastTouchedRev,
    dependencies: stringArray(task.dependencies),
    related: stringArray(task.related)
  };
}

function summarizeTaskIds(taskIds, context) {
  return taskIds
    .map((taskId) => context.byId.get(taskId))
    .filter(Boolean)
    .map((task) => summarizeTaskForWhy(task, context));
}

function collectTaskHistory(history = [], taskId) {
  return history
    .filter((entry) => Object.prototype.hasOwnProperty.call(entry?.delta?.tasks || {}, taskId))
    .sort((a, b) => (b.rev ?? -1) - (a.rev ?? -1))
    .map((entry) => {
      const delta = entry?.delta?.tasks?.[taskId] || {};
      return {
        rev: entry.rev,
        ts: entry.ts,
        summary: Array.isArray(entry.summary) ? entry.summary : [],
        changedKeys: delta.__added__ ? ["__added__"] : delta.__removed__ ? ["__removed__"] : Object.keys(delta).sort()
      };
    });
}

function reverseDependencies(data = {}) {
  const reverse = new Map();
  for (const task of data?.tasks || []) {
    for (const dependencyId of task?.dependencies || []) {
      const current = reverse.get(dependencyId) || [];
      current.push(task.id);
      reverse.set(dependencyId, current);
    }
  }
  return reverse;
}

function buildWhyReasons(task, summary, downstreamIds) {
  const reasons = [];

  if (summary.comment) {
    reasons.push({
      kind: "decision_note",
      text: summary.comment
    });
  }

  if (task.goal) {
    reasons.push({
      kind: "goal",
      text: task.goal
    });
  }

  if (summary.priorityId || summary.swimlaneId) {
    reasons.push({
      kind: "priority",
      text: `${summary.priorityId || "p?"} priority in ${summary.swimlaneId || "unknown swimlane"}`
    });
  }

  const traceability = summary.traceability || {};
  if (traceability.roadmap) {
    const details = [traceability.roadmap.section, traceability.roadmap.reference].filter(Boolean).join(" · ");
    reasons.push({
      kind: "roadmap",
      text: `Roadmap home: ${details}`
    });
  }
  if (traceability.execution_report) {
    const details = [traceability.execution_report.title, traceability.execution_report.reference].filter(Boolean).join(" · ");
    reasons.push({
      kind: "execution_report",
      text: `Execution report linkage: ${details}`
    });
  }
  if (traceability.architecture) {
    const details = [traceability.architecture.title, traceability.architecture.reference].filter(Boolean).join(" · ");
    reasons.push({
      kind: "architecture",
      text: `Architecture truth linkage: ${details}`
    });
  }

  if (summary.actionability === "blocked_by_task" && summary.blocked_by.length > 0) {
    reasons.push({
      kind: "blocked",
      text: `Blocked by ${summary.blocked_by.join(", ")}`
    });
  } else if (summary.actionability === "decision_gated") {
    reasons.push({
      kind: "decision_gated",
      text: summary.decision_reason || "Decision required before execution"
    });
  } else if (summary.ready) {
    reasons.push({
      kind: "ready",
      text: "Ready for work now"
    });
  }

  if (downstreamIds.length > 0) {
    reasons.push({
      kind: "unblocks",
      text: `Unblocks ${downstreamIds.join(", ")}`
    });
  }

  if (summary.requires_approval.length > 0) {
    reasons.push({
      kind: "approval",
      text: `Requires approval for ${summary.requires_approval.join(", ")}`
    });
  }

  if (summary.effort) {
    reasons.push({
      kind: "effort",
      text: `Estimated effort ${summary.effort}`
    });
  }

  if (summary.lastTouchedRev !== null) {
    reasons.push({
      kind: "freshness",
      text: `Last touched in rev ${summary.lastTouchedRev}`
    });
  }

  return reasons;
}

export function buildWhyPayload({
  slug,
  data,
  history = [],
  externalLookup = null,
  taskId,
  now = new Date().toISOString()
}) {
  const context = buildProjectTaskContext({ data, history, externalLookup });
  const task = context.byId.get(taskId);
  if (!task) return null;

  const taskPack = summarizeTaskForWhy(task, context);
  const downstreamIds = (reverseDependencies(data).get(taskId) || []).sort();
  const references = selectBriefReferences(task, context);
  const recentHistory = collectTaskHistory(history, taskId).slice(0, WHY_HISTORY_LIMIT);

  return {
    packType: "why",
    project: slug,
    taskId,
    rev: context.currentRev,
    generatedAt: now,
    task: taskPack,
    why: buildWhyReasons(task, taskPack, downstreamIds),
    blockedBy: summarizeTaskIds(taskPack.blocking_on, context),
    unblocks: summarizeTaskIds(downstreamIds, context),
    references,
    recentHistory,
    truncation: {
      history: {
        applied: collectTaskHistory(history, taskId).length > recentHistory.length,
        returned: recentHistory.length,
        totalAvailable: collectTaskHistory(history, taskId).length,
        maxCount: WHY_HISTORY_LIMIT
      }
    }
  };
}

export function getWhyPayload({ workspace, slug, entry, externalLookup, taskId, now }) {
  if (!entry?.data) return { ok: false, status: 404, message: "not found" };
  const history = readHistory(workspace, slug);
  const lookup =
    externalLookup ||
    buildWorkspaceLookup(workspace, { selfSlug: slug, selfData: entry.data });
  const payload = buildWhyPayload({
    slug,
    data: entry.data,
    history,
    externalLookup: lookup,
    taskId,
    now
  });
  if (!payload) return { ok: false, status: 404, message: "task not found" };
  return { ok: true, payload };
}
