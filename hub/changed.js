import { readHistory } from "./snapshots.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

function parseChangeKind(key) {
  if (key === "__added__") return "added";
  if (key === "__removed__") return "removed";
  if (key === "status") return "status";
  if (key === "placement") return "placement";
  if (key === "dependencies") return "dependencies";
  if (key === "assignee") return "assignee";
  if (key === "comment" || key === "blocker_reason") return "notes";
  if (key === "reference" || key === "references") return "references";
  if (key === "effort") return "effort";
  return "edit";
}

function collectChanges(history = [], fromRev = 0) {
  const taskChanges = new Map();
  const metaChanges = new Map();
  const orderChangedRevs = [];

  for (const entry of history) {
    if (!Number.isInteger(entry?.rev) || entry.rev <= fromRev) continue;

    for (const key of Object.keys(entry?.delta?.meta || {})) {
      metaChanges.set(key, entry.rev);
    }

    if (Array.isArray(entry?.delta?.order)) {
      orderChangedRevs.push(entry.rev);
    }

    for (const [taskId, delta] of Object.entries(entry?.delta?.tasks || {})) {
      const existing = taskChanges.get(taskId) || {
        id: taskId,
        changedInRevs: [],
        changeKinds: new Set(),
        changedKeys: new Set(),
        added: false,
        removed: false,
        lastChangedRev: null
      };

      existing.changedInRevs.push(entry.rev);
      existing.lastChangedRev = entry.rev;

      if (delta?.__added__) {
        existing.added = true;
        existing.changeKinds.add("added");
        existing.changedKeys.add("__added__");
      } else if (delta?.__removed__) {
        existing.removed = true;
        existing.changeKinds.add("removed");
        existing.changedKeys.add("__removed__");
      } else {
        for (const key of Object.keys(delta || {})) {
          existing.changedKeys.add(key);
          existing.changeKinds.add(parseChangeKind(key));
        }
      }

      taskChanges.set(taskId, existing);
    }
  }

  return { taskChanges, metaChanges, orderChangedRevs };
}

function sortChanged(a, b) {
  if ((b.lastChangedRev ?? -1) !== (a.lastChangedRev ?? -1)) {
    return (b.lastChangedRev ?? -1) - (a.lastChangedRev ?? -1);
  }
  if ((b.priorityWeight ?? 0) !== (a.priorityWeight ?? 0)) {
    return (b.priorityWeight ?? 0) - (a.priorityWeight ?? 0);
  }
  return a.id.localeCompare(b.id);
}

export function buildChangedPayload({
  slug,
  data,
  history = [],
  fromRev = 0,
  limit = 20,
  now = new Date().toISOString()
}) {
  const context = buildProjectTaskContext({ data, history });
  const { taskChanges, metaChanges, orderChangedRevs } = collectChanges(history, fromRev);

  const changed = Array.from(taskChanges.values())
    .map((change) => {
      const task = context.byId.get(change.id);
      const summary = task ? summarizeTask(task, context) : null;
      return {
        ...(summary || {
          id: change.id,
          title: null,
          goal: null,
          status: "removed",
          assignee: null,
          priorityId: null,
          swimlaneId: null,
          effort: null,
          actionability: "parked",
          actionable: false,
          ready: false,
          blocked_kind: null,
          blocked_by: [],
          blocking_on: [],
          blocker_reason: null,
          decision_required: [],
          decision_reason: null,
          not_actionable_reason: "Task was removed.",
          requires_approval: [],
          dependenciesResolved: false,
          references: [],
          comment: null,
          lastTouchedRev: null,
          priorityWeight: 0
        }),
        added: change.added,
        removed: change.removed,
        changedInRevs: change.changedInRevs,
        lastChangedRev: change.lastChangedRev,
        changeKinds: Array.from(change.changeKinds).sort(),
        changedKeys: Array.from(change.changedKeys).sort()
      };
    })
    .sort(sortChanged)
    .slice(0, Math.max(1, Math.min(limit, 50)));

  return {
    project: slug,
    rev: context.currentRev,
    fromRev,
    generatedAt: now,
    changed,
    metaChanges: Array.from(metaChanges.entries())
      .map(([key, lastChangedRev]) => ({ key, lastChangedRev }))
      .sort((a, b) => b.lastChangedRev - a.lastChangedRev || a.key.localeCompare(b.key)),
    orderChangedRevs
  };
}

export function getChangedPayload({ workspace, slug, entry, fromRev = 0, limit = 20, now }) {
  if (!entry?.data) return null;
  const history = readHistory(workspace, slug);
  return buildChangedPayload({
    slug,
    data: entry.data,
    history,
    fromRev,
    limit,
    now
  });
}
