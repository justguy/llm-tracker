import { readHistory } from "./snapshots.js";
import { hasNormalizedReferences, normalizeEffort, normalizeTaskReferences } from "./references.js";

const KNOWN_PRIORITY_WEIGHTS = {
  p0: 100,
  p1: 70,
  p2: 40,
  p3: 10
};

const EFFORT_BONUS = {
  xs: 8,
  s: 5,
  m: 2,
  l: -2,
  xl: -6
};

function priorityWeight(priorityId, priorities = []) {
  if (KNOWN_PRIORITY_WEIGHTS[priorityId] !== undefined) {
    return KNOWN_PRIORITY_WEIGHTS[priorityId];
  }

  const idx = priorities.findIndex((p) => p.id === priorityId);
  if (idx === -1) return 0;
  return Math.max(10, 100 - idx * 20);
}

function lastTouchedRevFor(task, touchMap) {
  if (Number.isInteger(task?.rev)) return task.rev;
  return touchMap.get(task?.id) ?? null;
}

function buildTaskTouchMap(history = []) {
  const out = new Map();
  for (const entry of history) {
    for (const taskId of Object.keys(entry?.delta?.tasks || {})) {
      out.set(taskId, entry.rev);
    }
  }
  return out;
}

function freshnessBonus(lastTouchedRev, currentRev) {
  if (!Number.isInteger(lastTouchedRev) || !Number.isInteger(currentRev)) return 0;
  const age = currentRev - lastTouchedRev;
  if (age <= 1) return 4;
  if (age <= 3) return 2;
  if (age <= 7) return 1;
  return 0;
}

function scoreTask(task, options) {
  const {
    priorities,
    currentRev,
    lastTouchedRev,
    dependenciesResolved,
    hasReferences,
    hasComment,
    requiresApproval
  } = options;

  let score = priorityWeight(task.placement?.priorityId, priorities);
  if (dependenciesResolved) score += 25;
  if (task.status === "in_progress") score += 15;
  if (hasReferences) score += 10;
  if (hasComment) score += 8;
  score += EFFORT_BONUS[normalizeEffort(task.effort)] ?? 0;
  score += freshnessBonus(lastTouchedRev, currentRev);
  if (requiresApproval.length > 0) score -= 12;
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
  const byId = new Map((data?.tasks || []).map((task) => [task.id, task]));
  const touchMap = buildTaskTouchMap(history);
  const currentRev = data?.meta?.rev ?? null;

  const summaries = (data?.tasks || [])
    .filter((task) => task.status === "not_started" || task.status === "in_progress")
    .map((task) => {
      const blockingOn = (task.dependencies || []).filter((dep) => {
        const depTask = byId.get(dep);
        return depTask && depTask.status !== "complete";
      });
      const dependenciesResolved = blockingOn.length === 0;
      const references = normalizeTaskReferences(task);
      const comment = typeof task.comment === "string" && task.comment.trim() ? task.comment : null;
      const requiresApproval = Array.isArray(task.approval_required_for)
        ? task.approval_required_for.filter((value) => typeof value === "string" && value.trim())
        : [];
      const lastTouchedRev = lastTouchedRevFor(task, touchMap);
      const effort = normalizeEffort(task.effort);

      return {
        id: task.id,
        title: task.title,
        status: task.status,
        priorityId: task.placement?.priorityId ?? null,
        swimlaneId: task.placement?.swimlaneId ?? null,
        effort,
        ready: dependenciesResolved,
        blocked_kind: dependenciesResolved ? null : "deps",
        blocking_on: blockingOn,
        requires_approval: requiresApproval,
        dependenciesResolved,
        references,
        comment,
        lastTouchedRev,
        priorityWeight: priorityWeight(task.placement?.priorityId, data?.meta?.priorities || []),
        score: scoreTask(task, {
          priorities: data?.meta?.priorities || [],
          currentRev,
          lastTouchedRev,
          dependenciesResolved,
          hasReferences: hasNormalizedReferences(task),
          hasComment: !!comment,
          requiresApproval
        })
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
    rev: currentRev,
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
