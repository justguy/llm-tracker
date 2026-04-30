import { buildWorkspaceLookup } from "./cross-project-deps.js";
import { readHistory } from "./snapshots.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const DEFAULT_STALE_AFTER_REVS = 10;
const MIN_STALE_AFTER_REVS = 1;
const MAX_STALE_AFTER_REVS = 1000;

export function clampStaleAfterRevs(value) {
  if (!Number.isFinite(value)) return DEFAULT_STALE_AFTER_REVS;
  const intVal = Math.floor(value);
  if (intVal < MIN_STALE_AFTER_REVS) return MIN_STALE_AFTER_REVS;
  if (intVal > MAX_STALE_AFTER_REVS) return MAX_STALE_AFTER_REVS;
  return intVal;
}

function buildLastTouchInfo(history = []) {
  const out = new Map();
  for (const entry of history) {
    const tasks = entry?.delta?.tasks;
    if (!tasks) continue;
    for (const taskId of Object.keys(tasks)) {
      out.set(taskId, { rev: entry.rev, ts: entry.ts || null });
    }
  }
  return out;
}

function lastTouchFor(task, touchInfo) {
  const fromHistory = touchInfo.get(task?.id) || null;
  const taskRev = Number.isInteger(task?.rev) ? task.rev : null;
  const taskTs = typeof task?.updatedAt === "string" && task.updatedAt ? task.updatedAt : null;
  return {
    rev: taskRev !== null ? taskRev : fromHistory?.rev ?? null,
    ts: taskTs !== null ? taskTs : fromHistory?.ts ?? null
  };
}

export function buildHygienePayload({
  slug,
  data,
  history = [],
  externalLookup = null,
  now = new Date().toISOString(),
  staleAfterRevs = DEFAULT_STALE_AFTER_REVS
}) {
  const context = buildProjectTaskContext({ data, history, externalLookup });
  const tasks = data?.tasks || [];
  const swimlanes = data?.meta?.swimlanes || [];
  const priorities = data?.meta?.priorities || [];
  const currentRev = context.currentRev;
  const staleAfter = clampStaleAfterRevs(staleAfterRevs);

  const taskCountByLane = new Map();
  for (const lane of swimlanes) {
    taskCountByLane.set(lane.id, 0);
  }
  for (const task of tasks) {
    const laneId = task?.placement?.swimlaneId;
    if (!laneId) continue;
    taskCountByLane.set(laneId, (taskCountByLane.get(laneId) || 0) + 1);
  }

  const totalLanes = swimlanes.length;
  const emptySwimlanes = swimlanes
    .filter((lane) => (taskCountByLane.get(lane.id) || 0) === 0)
    .map((lane) => {
      const removable = totalLanes > 1;
      return {
        id: lane.id,
        label: lane.label || null,
        description: lane.description || null,
        taskCount: 0,
        removable,
        reason: removable
          ? null
          : "Only swimlane in project; removing it would leave no lane for placement."
      };
    });

  const usedPriorityIds = new Set();
  for (const task of tasks) {
    const priorityId = task?.placement?.priorityId;
    if (priorityId) usedPriorityIds.add(priorityId);
  }
  const orphanedPriorities = priorities
    .filter((priority) => !usedPriorityIds.has(priority.id))
    .map((priority) => ({
      id: priority.id,
      label: priority.label || null,
      referencedBy: 0
    }));

  const lastTouchInfo = buildLastTouchInfo(history);
  const staleInProgress = [];
  for (const task of tasks) {
    if (task?.status !== "in_progress") continue;
    const touch = lastTouchFor(task, lastTouchInfo);
    const lastRev = touch.rev;
    const revsSinceTouched =
      currentRev != null && lastRev != null ? Math.max(0, currentRev - lastRev) : null;
    if (revsSinceTouched == null || revsSinceTouched < staleAfter) continue;
    staleInProgress.push({
      id: task.id,
      title: task.title,
      assignee: task.assignee ?? null,
      priorityId: task.placement?.priorityId ?? null,
      swimlaneId: task.placement?.swimlaneId ?? null,
      lastTouchedRev: lastRev,
      revsSinceTouched,
      lastTouchedAt: touch.ts
    });
  }
  staleInProgress.sort((a, b) => {
    const av = a.revsSinceTouched ?? Number.MAX_SAFE_INTEGER;
    const bv = b.revsSinceTouched ?? Number.MAX_SAFE_INTEGER;
    if (bv !== av) return bv - av;
    return a.id.localeCompare(b.id);
  });

  const blockedWithoutReason = [];
  const decisionGatedWithoutComment = [];
  for (const task of tasks) {
    if (task?.status === "complete" || task?.status === "deferred") continue;
    const summary = summarizeTask(task, context);
    if (summary.actionability === "blocked_by_task") {
      // A task is "explained" if either a blocker_reason or a comment is
      // present. Flag only when both are missing.
      if (!summary.blocker_reason && !summary.comment) {
        blockedWithoutReason.push({
          id: task.id,
          title: task.title,
          status: task.status,
          priorityId: summary.priorityId,
          swimlaneId: summary.swimlaneId,
          blocking_on: summary.blocking_on,
          missingFields: ["blocker_reason", "comment"]
        });
      }
    } else if (summary.actionability === "decision_gated" && !summary.comment) {
      decisionGatedWithoutComment.push({
        id: task.id,
        title: task.title,
        status: task.status,
        priorityId: summary.priorityId,
        swimlaneId: summary.swimlaneId,
        decision_required: summary.decision_required,
        missingFields: ["comment"]
      });
    }
  }
  blockedWithoutReason.sort((a, b) => a.id.localeCompare(b.id));
  decisionGatedWithoutComment.sort((a, b) => a.id.localeCompare(b.id));

  return {
    packType: "hygiene",
    project: slug,
    rev: currentRev,
    generatedAt: now,
    thresholds: { staleAfterRevs: staleAfter },
    counts: {
      emptySwimlanes: emptySwimlanes.length,
      removableSwimlanes: emptySwimlanes.filter((lane) => lane.removable).length,
      orphanedPriorities: orphanedPriorities.length,
      staleInProgress: staleInProgress.length,
      blockedWithoutReason: blockedWithoutReason.length,
      decisionGatedWithoutComment: decisionGatedWithoutComment.length
    },
    emptySwimlanes,
    orphanedPriorities,
    staleInProgress,
    blockedWithoutReason,
    decisionGatedWithoutComment
  };
}

export function getHygienePayload({ workspace, slug, entry, externalLookup, now, staleAfterRevs }) {
  if (!entry?.data) return null;
  const history = readHistory(workspace, slug);
  const lookup =
    externalLookup ||
    buildWorkspaceLookup(workspace, { selfSlug: slug, selfData: entry.data });
  return buildHygienePayload({
    slug,
    data: entry.data,
    history,
    externalLookup: lookup,
    now,
    staleAfterRevs
  });
}

export const HYGIENE_DEFAULTS = {
  staleAfterRevs: DEFAULT_STALE_AFTER_REVS,
  staleAfterRevsMin: MIN_STALE_AFTER_REVS,
  staleAfterRevsMax: MAX_STALE_AFTER_REVS
};
