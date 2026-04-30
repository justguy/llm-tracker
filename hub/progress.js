import { STATUS_VALUES } from "./status-vocabulary.js";
import { ACTIONABILITY_VALUES, buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const SCORE = { not_started: 0, in_progress: 0.5, complete: 1, deferred: 0 };

export function zeroCounts() {
  const c = {};
  for (const s of STATUS_VALUES) c[s] = 0;
  return c;
}

export function countsFor(tasks) {
  const counts = zeroCounts();
  for (const t of tasks) {
    if (counts[t.status] !== undefined) counts[t.status] += 1;
  }
  return counts;
}

export function pctFor(tasks) {
  if (tasks.length === 0) return 0;
  let score = 0;
  let denom = 0;
  for (const t of tasks) {
    if (t.status === "deferred") continue;
    denom += 1;
    score += SCORE[t.status] ?? 0;
  }
  return denom === 0 ? 0 : Math.round((score / denom) * 100);
}

export function deriveBlocked(tasks) {
  const context = buildProjectTaskContext({ data: { tasks } });
  const blocked = {};
  for (const t of tasks) {
    const summary = summarizeTask(t, context);
    if (summary.actionability === "blocked_by_task" && summary.blocked_by.length > 0) {
      blocked[t.id] = summary.blocked_by;
    }
  }
  return blocked;
}

function zeroActionabilityCounts() {
  const counts = {};
  for (const value of ACTIONABILITY_VALUES) counts[value] = 0;
  return counts;
}

export function deriveActionabilitySummary(data) {
  const context = buildProjectTaskContext({ data });
  const counts = zeroActionabilityCounts();
  const byTask = {};

  for (const task of data.tasks || []) {
    if (task.status !== "not_started" && task.status !== "in_progress") continue;
    const summary = summarizeTask(task, context);
    if (counts[summary.actionability] !== undefined) counts[summary.actionability] += 1;
    byTask[task.id] = {
      actionability: summary.actionability,
      actionable: summary.actionable,
      blocked_by: summary.blocked_by,
      decision_required: summary.decision_required,
      decision_reason: summary.decision_reason,
      not_actionable_reason: summary.not_actionable_reason
    };
  }

  return {
    counts,
    byTask
  };
}

export function deriveProject(data) {
  const perSwimlane = {};
  for (const lane of data.meta.swimlanes) {
    const laneTasks = data.tasks.filter((t) => t.placement.swimlaneId === lane.id);
    perSwimlane[lane.id] = {
      counts: countsFor(laneTasks),
      pct: pctFor(laneTasks),
      total: laneTasks.length
    };
  }
  return {
    counts: countsFor(data.tasks),
    pct: pctFor(data.tasks),
    total: data.tasks.length,
    perSwimlane,
    blocked: deriveBlocked(data.tasks),
    actionability: deriveActionabilitySummary(data)
  };
}
