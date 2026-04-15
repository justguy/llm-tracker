import { readHistory } from "./snapshots.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const EFFORT_BONUS = {
  xs: 8,
  s: 5,
  m: 2,
  l: -2,
  xl: -6
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
  return score;
}

function buildReason(summary, index) {
  const reasons = [];

  if (summary.ready) {
    reasons.push(index === 0 ? "highest-ranked ready task" : "ready for work now");
  } else if (summary.blocked_kind === "deps" && summary.blocking_on.length > 0) {
    reasons.push(`blocked on dependencies: ${summary.blocking_on.join(", ")}`);
  }

  if (summary.priorityId) reasons.push(`${summary.priorityId} priority`);
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
  if (a.ready !== b.ready) return a.ready ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  if (a.priorityWeight !== b.priorityWeight) return b.priorityWeight - a.priorityWeight;
  return a.id.localeCompare(b.id);
}

export function buildNextPayload({ slug, data, history = [], limit = 5, now = new Date().toISOString() }) {
  const context = buildProjectTaskContext({ data, history });

  const summaries = (data?.tasks || [])
    .filter((task) => task.status === "not_started" || task.status === "in_progress")
    .map((task) => {
      const summary = summarizeTask(task, context);
      return {
        ...summary,
        score: scoreTask(summary, context.currentRev)
      };
    })
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
    recommendedTaskId: ranked[0]?.id ?? null,
    next: ranked
  };
}

export function getNextPayload({ workspace, slug, entry, limit = 5, now }) {
  if (!entry?.data) return null;
  const history = readHistory(workspace, slug);
  return buildNextPayload({
    slug,
    data: entry.data,
    history,
    limit,
    now
  });
}
