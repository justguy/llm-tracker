import { readHistory } from "./snapshots.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

function sortBlocked(a, b) {
  if (b.priorityWeight !== a.priorityWeight) return b.priorityWeight - a.priorityWeight;
  if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
  if (a.blocking_on.length !== b.blocking_on.length) return a.blocking_on.length - b.blocking_on.length;
  return a.id.localeCompare(b.id);
}

function sortBlocking(a, b) {
  if (b.blockedCount !== a.blockedCount) return b.blockedCount - a.blockedCount;
  if (b.priorityWeight !== a.priorityWeight) return b.priorityWeight - a.priorityWeight;
  return a.id.localeCompare(b.id);
}

export function buildBlockersPayload({ slug, data, history = [], now = new Date().toISOString() }) {
  const context = buildProjectTaskContext({ data, history });
  const summaries = (data?.tasks || [])
    .filter((task) => task.status === "not_started" || task.status === "in_progress")
    .map((task) => summarizeTask(task, context));

  const byId = new Map(summaries.map((task) => [task.id, task]));
  const blocked = summaries
    .filter((task) => task.blocking_on.length > 0)
    .map((task) => ({
      ...task,
      blocking_task_details: task.blocking_on
        .map((depId) => byId.get(depId))
        .filter(Boolean)
        .map((dep) => ({
          id: dep.id,
          title: dep.title,
          status: dep.status,
          priorityId: dep.priorityId,
          swimlaneId: dep.swimlaneId
        }))
    }))
    .sort(sortBlocked);

  const reverse = new Map();
  for (const task of blocked) {
    for (const depId of task.blocking_on) {
      const current = reverse.get(depId) || [];
      current.push({
        id: task.id,
        title: task.title,
        priorityId: task.priorityId,
        swimlaneId: task.swimlaneId
      });
      reverse.set(depId, current);
    }
  }

  const blocking = Array.from(reverse.entries())
    .map(([taskId, blockedTasks]) => {
      const task = byId.get(taskId);
      if (!task) return null;
      return {
        ...task,
        blockedCount: blockedTasks.length,
        blocks: blockedTasks.sort((a, b) => a.id.localeCompare(b.id))
      };
    })
    .filter(Boolean)
    .sort(sortBlocking);

  return {
    project: slug,
    rev: context.currentRev,
    generatedAt: now,
    blocked,
    blocking
  };
}

export function getBlockersPayload({ workspace, slug, entry, now }) {
  if (!entry?.data) return null;
  const history = readHistory(workspace, slug);
  return buildBlockersPayload({
    slug,
    data: entry.data,
    history,
    now
  });
}
