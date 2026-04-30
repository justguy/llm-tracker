import { readHistory } from "./snapshots.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const EFFORT_BONUS = {
  xs: 8,
  s: 5,
  m: 2,
  l: -2,
  xl: -6
};
const AGGREGATE_PENALTY = 100;
const ACTIONABILITY_RANK = {
  executable: 0,
  decision_gated: 1,
  blocked_by_task: 2,
  parked: 3
};

function freshnessBonus(lastTouchedRev, currentRev) {
  if (!Number.isInteger(lastTouchedRev) || !Number.isInteger(currentRev)) return 0;
  const age = currentRev - lastTouchedRev;
  if (age <= 1) return 4;
  if (age <= 3) return 2;
  if (age <= 7) return 1;
  return 0;
}

function scoreTask(summary, currentRev) {
  let score = summary.priorityWeight;
  if (summary.dependenciesResolved) score += 25;
  if (summary.status === "in_progress") score += 15;
  if (summary.references.length > 0) score += 10;
  if (summary.comment) score += 8;
  score += EFFORT_BONUS[summary.effort] ?? 0;
  score += freshnessBonus(summary.lastTouchedRev, currentRev);
  if (summary.requires_approval.length > 0) score -= 12;
  if (summary.aggregate) score -= AGGREGATE_PENALTY;
  return score;
}

function buildReason(summary, index) {
  const reasons = [];

  if (summary.actionability === "executable") {
    reasons.push(index === 0 ? "highest-ranked executable task" : "executable now");
  } else if (summary.actionability === "blocked_by_task" && summary.blocked_by.length > 0) {
    reasons.push(`blocked by task${summary.blocked_by.length === 1 ? "" : "s"}: ${summary.blocked_by.join(", ")}`);
  } else if (summary.actionability === "decision_gated") {
    reasons.push(summary.decision_reason || "decision required before execution");
  } else if (summary.actionability === "parked") {
    reasons.push(summary.not_actionable_reason || "parked");
  }

  if (summary.priorityId) reasons.push(`${summary.priorityId} priority`);
  if (summary.aggregate) reasons.push("aggregate roadmap/container row");
  if (summary.dependenciesResolved) reasons.push("dependencies satisfied");
  if (summary.references.length > 0) reasons.push("explicit references available");
  if (summary.comment) reasons.push("decision note present");
  if (summary.status === "in_progress") reasons.push("already in progress");
  if (summary.effort) reasons.push(`estimated effort ${summary.effort}`);
  if (summary.requires_approval.length > 0) {
    reasons.push(`requires approval for ${summary.requires_approval.join(", ")}`);
  }

  return reasons;
}

function sortSummaries(a, b) {
  const actionabilityDelta = (ACTIONABILITY_RANK[a.actionability] ?? 99) - (ACTIONABILITY_RANK[b.actionability] ?? 99);
  if (actionabilityDelta !== 0) return actionabilityDelta;
  if (a.ready !== b.ready) return a.ready ? -1 : 1;
  if (a.aggregate !== b.aggregate) return a.aggregate ? 1 : -1;
  if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  if (a.priorityWeight !== b.priorityWeight) return b.priorityWeight - a.priorityWeight;
  return a.id.localeCompare(b.id);
}

function actionabilityCounts(summaries) {
  const counts = {
    executable: 0,
    blocked_by_task: 0,
    decision_gated: 0,
    parked: 0
  };
  for (const summary of summaries) {
    if (counts[summary.actionability] !== undefined) counts[summary.actionability] += 1;
  }
  return counts;
}

function isRankable(summary, { includeGated }) {
  if (summary.actionability === "executable") return true;
  if (includeGated && summary.actionability === "decision_gated") return true;
  return false;
}

export function buildNextPayload({
  slug,
  data,
  history = [],
  limit = 5,
  includeGated = false,
  now = new Date().toISOString()
}) {
  const context = buildProjectTaskContext({ data, history });

  const activeSummaries = (data?.tasks || [])
    .filter((task) => task.status === "not_started" || task.status === "in_progress")
    .map((task) => {
      const summary = summarizeTask(task, context);
      return {
        ...summary,
          score: scoreTask(summary, context.currentRev)
      };
    });

  const counts = actionabilityCounts(activeSummaries);
  const summaries = activeSummaries
    .filter((summary) => isRankable(summary, { includeGated }))
    .sort(sortSummaries)
    .slice(0, Math.max(1, Math.min(limit, 5)));

  const ranked = summaries.map((summary, index) => ({
    ...summary,
    reason: buildReason(summary, index)
  }));

  return {
    project: slug,
    rev: context.currentRev,
    generatedAt: now,
    includeGated: includeGated === true,
    actionabilityCounts: counts,
    hiddenByActionability: {
      blocked_by_task: counts.blocked_by_task,
      decision_gated: includeGated ? 0 : counts.decision_gated,
      parked: counts.parked
    },
    recommendedTaskId: ranked[0]?.id ?? null,
    next: ranked
  };
}

export function getNextPayload({ workspace, slug, entry, limit = 5, includeGated = false, now }) {
  if (!entry?.data) return null;
  const history = readHistory(workspace, slug);
  return buildNextPayload({
    slug,
    data: entry.data,
    history,
    limit,
    includeGated,
    now
  });
}
