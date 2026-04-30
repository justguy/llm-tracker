import { buildWorkspaceLookup } from "./cross-project-deps.js";
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

export function buildBlockersPayload({
  slug,
  data,
  history = [],
  externalLookup = null,
  now = new Date().toISOString()
}) {
  const context = buildProjectTaskContext({ data, history, externalLookup });
  const summaries = (data?.tasks || [])
    .filter((task) => task.status === "not_started" || task.status === "in_progress")
    .map((task) => summarizeTask(task, context));

  const byId = new Map(summaries.map((task) => [task.id, task]));
  const externalById = new Map();
  for (const summary of summaries) {
    for (const ext of summary.external_dependencies || []) {
      externalById.set(ext.raw, ext);
    }
  }

  const blocked = summaries
    .filter((task) => task.blocking_on.length > 0)
    .map((task) => ({
      ...task,
      blocking_task_details: task.blocking_on
        .map((depId) => {
          const local = byId.get(depId);
          if (local) {
            return {
              id: local.id,
              title: local.title,
              status: local.status,
              priorityId: local.priorityId,
              swimlaneId: local.swimlaneId,
              external: false
            };
          }
          const external = externalById.get(depId);
          if (external) {
            return {
              id: external.raw,
              project: external.slug,
              taskId: external.taskId,
              title: external.title,
              status: external.status,
              exists: external.exists,
              external: true
            };
          }
          return null;
        })
        .filter(Boolean)
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
      if (task) {
        return {
          ...task,
          blockedCount: blockedTasks.length,
          blocks: blockedTasks.sort((a, b) => a.id.localeCompare(b.id))
        };
      }
      const external = externalById.get(taskId);
      if (external) {
        return {
          id: external.raw,
          project: external.slug,
          taskId: external.taskId,
          title: external.title,
          status: external.status,
          exists: external.exists,
          external: true,
          priorityWeight: 0,
          blockedCount: blockedTasks.length,
          blocks: blockedTasks.sort((a, b) => a.id.localeCompare(b.id))
        };
      }
      return null;
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

export function getBlockersPayload({ workspace, slug, entry, externalLookup, now }) {
  if (!entry?.data) return null;
  const history = readHistory(workspace, slug);
  const lookup =
    externalLookup ||
    buildWorkspaceLookup(workspace, { selfSlug: slug, selfData: entry.data });
  return buildBlockersPayload({
    slug,
    data: entry.data,
    history,
    externalLookup: lookup,
    now
  });
}
