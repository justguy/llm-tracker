import { readHistory } from "./snapshots.js";
import { normalizeTaskReferences } from "./references.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const DEFAULT_DECISION_LIMIT = 20;

function lastDecisionRev(task, history = []) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const delta = history[index]?.delta?.tasks?.[task.id];
    if (!delta) continue;
    if (Object.prototype.hasOwnProperty.call(delta, "comment")) {
      return history[index].rev;
    }
    if (delta.__added__ && typeof delta.__added__.comment === "string" && delta.__added__.comment.trim()) {
      return history[index].rev;
    }
  }
  return null;
}

function sortDecisions(a, b) {
  if ((b.lastDecisionRev ?? -1) !== (a.lastDecisionRev ?? -1)) {
    return (b.lastDecisionRev ?? -1) - (a.lastDecisionRev ?? -1);
  }
  if ((b.lastTouchedRev ?? -1) !== (a.lastTouchedRev ?? -1)) {
    return (b.lastTouchedRev ?? -1) - (a.lastTouchedRev ?? -1);
  }
  if ((b.priorityWeight ?? 0) !== (a.priorityWeight ?? 0)) {
    return (b.priorityWeight ?? 0) - (a.priorityWeight ?? 0);
  }
  return a.id.localeCompare(b.id);
}

export function buildDecisionsPayload({
  slug,
  data,
  history = [],
  limit = DEFAULT_DECISION_LIMIT,
  now = new Date().toISOString()
}) {
  const context = buildProjectTaskContext({ data, history });
  const all = (data?.tasks || [])
    .filter((task) => typeof task.comment === "string" && task.comment.trim())
    .map((task) => {
      const summary = summarizeTask(task, context);
      return {
        id: task.id,
        title: task.title,
        goal: task.goal || null,
        status: summary.status,
        priorityId: summary.priorityId,
        swimlaneId: summary.swimlaneId,
        effort: summary.effort,
        comment: summary.comment,
        lastTouchedRev: summary.lastTouchedRev,
        lastDecisionRev: lastDecisionRev(task, history) ?? summary.lastTouchedRev,
        selectedBecause: "task comment present",
        references: normalizeTaskReferences(task).map((value) => ({
          value,
          selectedBecause: "task reference attached to the decision"
        })),
        priorityWeight: summary.priorityWeight
      };
    })
    .sort(sortDecisions);

  const capped = all.slice(0, Math.max(1, Math.min(limit, DEFAULT_DECISION_LIMIT)));

  return {
    packType: "decisions",
    project: slug,
    rev: context.currentRev,
    generatedAt: now,
    decisions: capped.map(({ priorityWeight, ...decision }) => decision),
    truncation: {
      decisions: {
        applied: capped.length < all.length,
        returned: capped.length,
        totalAvailable: all.length,
        maxCount: DEFAULT_DECISION_LIMIT
      }
    }
  };
}

export function getDecisionsPayload({ workspace, slug, entry, limit = DEFAULT_DECISION_LIMIT, now }) {
  if (!entry?.data) return null;
  const history = readHistory(workspace, slug);
  return buildDecisionsPayload({
    slug,
    data: entry.data,
    history,
    limit,
    now
  });
}
