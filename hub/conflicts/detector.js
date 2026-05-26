import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { annotateRepoChangeWithAllowedPaths } from "../workspaces/allowed-paths.js";

export const CONFLICT_KINDS = Object.freeze([
  "multiple_sessions_same_file",
  "multiple_sessions_same_worktree",
  "outside_allowed_paths",
  "task_claim_conflict",
  "stale_tracker_rev",
]);

const TERMINAL_SESSION_STATUSES = new Set([
  "archived",
  "cancelled",
  "complete",
  "completed",
  "done",
  "failed",
  "stopped",
]);

const TERMINAL_JOB_STATUSES = new Set(["completed", "cancelled", "rolled_over"]);

export function detectConflicts(input = {}) {
  if (!input || typeof input !== "object") return [];
  const conflicts = [];
  addMultipleSessionsSameFileConflicts(conflicts, input);
  addMultipleSessionsSameWorktreeConflicts(conflicts, input);
  addOutsideAllowedPathsConflicts(conflicts, input);
  addTaskClaimConflicts(conflicts, input);
  addStaleTrackerRevConflicts(conflicts, input);
  return dedupeConflicts(conflicts);
}

export function conflictId(kind, parts = []) {
  const digest = createHash("sha1")
    .update(JSON.stringify([kind, ...parts.map((part) => normalizeIdPart(part))]))
    .digest("hex")
    .slice(0, 12);
  return `cf_${kind}_${digest}`;
}

function addMultipleSessionsSameFileConflicts(out, input) {
  const grouped = new Map();
  for (const event of repoEvents(input)) {
    if (!isRepoChangeEvent(event)) continue;
    const repoRoot = normalizeRoot(event.repoRoot);
    const path = normalizePath(event.path);
    if (!repoRoot || !path) continue;
    const key = `${stringOr(input.projectSlug, event.projectSlug)}\0${repoRoot}\0${path}`;
    const item =
      grouped.get(key) ||
      {
        projectSlug: stringOr(event.projectSlug, input.projectSlug),
        repoRoot,
        path,
        eventIds: [],
        sessionIds: [],
      };
    if (isNonEmptyString(event.id)) item.eventIds.push(event.id);
    item.sessionIds.push(...sessionIdsFromEvent(event));
    grouped.set(key, item);
  }

  for (const item of grouped.values()) {
    const sessionIds = uniqueStrings(item.sessionIds);
    if (sessionIds.length < 2) continue;
    out.push({
      id: conflictId("multiple_sessions_same_file", [
        item.projectSlug,
        item.repoRoot,
        item.path,
        sessionIds,
      ]),
      kind: "multiple_sessions_same_file",
      projectSlug: item.projectSlug,
      repoRoot: item.repoRoot,
      path: item.path,
      paths: [item.path],
      sessionIds,
      activeSessionIds: sessionIds,
      eventIds: uniqueStrings(item.eventIds),
      evidenceRef: firstString(item.eventIds),
      message: `Multiple active sessions changed ${item.path}.`,
    });
  }
}

function addMultipleSessionsSameWorktreeConflicts(out, input) {
  const grouped = new Map();
  for (const session of sessions(input)) {
    if (!isActiveSession(session)) continue;
    const root = normalizeRoot(firstString([session.worktreePath, session.worktree, session.repoRoot, session.cwd]));
    const sessionId = stringOr(session.id, session.sessionId);
    if (!root || !sessionId) continue;
    const projectSlug = stringOr(session.projectSlug, input.projectSlug);
    const key = `${projectSlug}\0${root}`;
    const item =
      grouped.get(key) ||
      {
        projectSlug,
        worktreePath: root,
        sessionIds: [],
      };
    item.sessionIds.push(sessionId);
    grouped.set(key, item);
  }

  for (const item of grouped.values()) {
    const sessionIds = uniqueStrings(item.sessionIds);
    if (sessionIds.length < 2) continue;
    out.push({
      id: conflictId("multiple_sessions_same_worktree", [
        item.projectSlug,
        item.worktreePath,
        sessionIds,
      ]),
      kind: "multiple_sessions_same_worktree",
      projectSlug: item.projectSlug,
      worktreePath: item.worktreePath,
      sessionIds,
      activeSessionIds: sessionIds,
      message: `Multiple active sessions share worktree ${item.worktreePath}.`,
      recommendedActions: [
        { id: "create_worktree", kind: "create_worktree", label: "Create worktree", enabled: true },
        { id: "open_conflicts", kind: "open_conflicts", label: "Open conflicts", enabled: true },
        { id: "acknowledge", kind: "acknowledge", label: "Acknowledge", enabled: true },
      ],
    });
  }
}

function addOutsideAllowedPathsConflicts(out, input) {
  const taskById = new Map(
    tasks(input)
      .filter((task) => isNonEmptyString(task?.id))
      .map((task) => [task.id, task]),
  );
  for (const event of repoEvents(input)) {
    if (!isRepoChangeEvent(event)) continue;
    let emittedFromTask = false;
    for (const taskId of relatedTaskIds(event)) {
      const task = taskById.get(taskId);
      if (!task) continue;
      const { conflict } = annotateRepoChangeWithAllowedPaths(event, task);
      if (conflict) {
        emittedFromTask = true;
        out.push(normalizeOutsideAllowedPathsConflict(conflict));
      }
    }
    if (event.outsideAllowedPaths === true && !emittedFromTask) {
      out.push(outsideAllowedPathsConflictFromEvent(event, firstRelatedTaskId(event)));
    }
  }
}

function addTaskClaimConflicts(out, input) {
  for (const entry of claimEntries(input)) {
    const error = claimError(entry);
    if (error !== "task_claim_conflict") continue;
    const activeJobId = stringOr(entry.activeJobId, entry.result?.activeJobId);
    const projectSlug = stringOr(entry.projectSlug, input.projectSlug);
    const taskId = stringOr(entry.taskId, entry.result?.taskId);
    out.push({
      id: conflictId("task_claim_conflict", [projectSlug, taskId, activeJobId]),
      kind: "task_claim_conflict",
      projectSlug,
      taskId,
      activeJobId,
      jobId: activeJobId,
      message: activeJobId
        ? `Task ${taskId || "(unknown)"} is already claimed by active job ${activeJobId}.`
        : `Task ${taskId || "(unknown)"} is already claimed by an active job.`,
    });
  }

  for (const item of activeJobsByTask(input)) {
    const jobs = item.jobs;
    if (jobs.length < 2) continue;
    const activeJobIds = jobs.map((job) => job.id).filter(isNonEmptyString);
    out.push({
      id: conflictId("task_claim_conflict", [item.projectSlug, item.taskId, activeJobIds]),
      kind: "task_claim_conflict",
      projectSlug: item.projectSlug,
      taskId: item.taskId,
      activeJobIds,
      jobIds: activeJobIds,
      message: `Multiple active jobs claim task ${item.taskId}.`,
    });
  }
}

function addStaleTrackerRevConflicts(out, input) {
  if (
    Number.isInteger(input.expectedTrackerRev) &&
    Number.isInteger(input.currentTrackerRev) &&
    input.expectedTrackerRev !== input.currentTrackerRev
  ) {
    out.push({
      id: conflictId("stale_tracker_rev", [
        input.projectSlug,
        input.taskId,
        input.expectedTrackerRev,
        input.currentTrackerRev,
      ]),
      kind: "stale_tracker_rev",
      projectSlug: stringOr(input.projectSlug),
      taskId: stringOr(input.taskId),
      expectedTrackerRev: input.expectedTrackerRev,
      currentRev: input.currentTrackerRev,
      currentTrackerRev: input.currentTrackerRev,
      message: `Tracker rev changed from ${input.expectedTrackerRev} to ${input.currentTrackerRev}.`,
    });
  }

  for (const entry of claimEntries(input)) {
    const error = claimError(entry);
    if (error !== "stale_tracker_rev") continue;
    const currentRev = integerOr(entry.currentRev, entry.currentTrackerRev, entry.result?.currentRev);
    const expectedRev = integerOr(entry.expectedTrackerRev, entry.result?.expectedTrackerRev);
    const projectSlug = stringOr(entry.projectSlug, input.projectSlug);
    const taskId = stringOr(entry.taskId, entry.result?.taskId);
    out.push({
      id: conflictId("stale_tracker_rev", [projectSlug, taskId, expectedRev, currentRev]),
      kind: "stale_tracker_rev",
      projectSlug,
      taskId,
      expectedTrackerRev: expectedRev,
      currentRev,
      currentTrackerRev: currentRev,
      message:
        Number.isInteger(currentRev) && Number.isInteger(expectedRev)
          ? `Tracker rev changed from ${expectedRev} to ${currentRev}.`
          : "Tracker revision is stale.",
    });
  }
}

function outsideAllowedPathsConflictFromEvent(event, taskId) {
  const path = normalizePath(event.path);
  return {
    id: conflictId("outside_allowed_paths", [event.id, event.projectSlug, taskId, event.repoRoot, path]),
    kind: "outside_allowed_paths",
    projectSlug: stringOr(event.projectSlug),
    taskId,
    sessionIds: sessionIdsFromEvent(event),
    activeSessionIds: sessionIdsFromEvent(event),
    repoRoot: normalizeRoot(event.repoRoot),
    path,
    paths: path ? [path] : [],
    eventId: stringOr(event.id),
    evidenceRef: stringOr(event.id),
    message: path ? `Watcher reports ${path} outside allowed_paths.` : "Watcher reports outside allowed_paths.",
  };
}

function normalizeOutsideAllowedPathsConflict(conflict) {
  const path = normalizePath(conflict.path || (Array.isArray(conflict.paths) ? conflict.paths[0] : ""));
  return {
    ...conflict,
    id: stringOr(conflict.id, conflictId("outside_allowed_paths", [conflict.eventId, conflict.taskId, path])),
    kind: "outside_allowed_paths",
    path,
    paths: Array.isArray(conflict.paths) ? uniqueStrings(conflict.paths.map(normalizePath)) : path ? [path] : [],
    evidenceRef: stringOr(conflict.evidenceRef, conflict.id, conflict.eventId),
  };
}

function activeJobsByTask(input) {
  const grouped = new Map();
  for (const job of jobs(input)) {
    if (!job || TERMINAL_JOB_STATUSES.has(String(job.status || "").toLowerCase())) continue;
    if (!isNonEmptyString(job.taskId)) continue;
    const projectSlug = stringOr(job.projectSlug, input.projectSlug);
    const key = `${projectSlug}\0${job.taskId}`;
    const item = grouped.get(key) || { projectSlug, taskId: job.taskId, jobs: [] };
    item.jobs.push(job);
    grouped.set(key, item);
  }
  return Array.from(grouped.values());
}

function dedupeConflicts(conflicts) {
  const seen = new Set();
  const out = [];
  for (const conflict of conflicts) {
    if (!conflict || !CONFLICT_KINDS.includes(conflict.kind)) continue;
    const id = stringOr(conflict.id, conflictId(conflict.kind, conflictKeyParts(conflict)));
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...conflict, id, conflictId: stringOr(conflict.conflictId, id) });
  }
  return out;
}

function conflictKeyParts(conflict) {
  return [
    conflict.projectSlug,
    conflict.taskId,
    conflict.sessionId,
    conflict.activeJobId,
    conflict.repoRoot,
    conflict.worktreePath,
    conflict.path,
    conflict.currentRev,
  ];
}

function repoEvents(input) {
  return arrayOr(input.repoEvents, input.events, input.runtimeEvents).filter(
    (event) => event?.type === "repo.change" || event?.type === "repo.burst" || event?.outsideAllowedPaths === true,
  );
}

function sessions(input) {
  return arrayOr(input.sessions, input.sessionRecords);
}

function jobs(input) {
  return arrayOr(input.jobs, input.jobRecords, input.activeJobs);
}

function tasks(input) {
  return arrayOr(input.tasks, input.trackerTasks, input.project?.tasks, input.project?.data?.tasks);
}

function claimEntries(input) {
  return arrayOr(input.claimResults, input.taskClaims, input.launchResults, input.runSessionResults);
}

function isRepoChangeEvent(event) {
  return event && typeof event === "object" && event.type === "repo.change";
}

function isActiveSession(session) {
  if (!session || typeof session !== "object") return false;
  return !TERMINAL_SESSION_STATUSES.has(String(session.status || "").toLowerCase());
}

function sessionIdsFromEvent(event) {
  return uniqueStrings([
    ...(Array.isArray(event.activeSessionIds) ? event.activeSessionIds : []),
    ...(Array.isArray(event.sessionIds) ? event.sessionIds : []),
    ...(isNonEmptyString(event.sessionId) ? [event.sessionId] : []),
  ]);
}

function relatedTaskIds(event) {
  return uniqueStrings([
    ...(Array.isArray(event.relatedTaskIds) ? event.relatedTaskIds : []),
    ...(isNonEmptyString(event.taskId) ? [event.taskId] : []),
  ]);
}

function firstRelatedTaskId(event) {
  return firstString(relatedTaskIds(event));
}

function claimError(entry) {
  return stringOr(entry?.error, entry?.result?.error);
}

function normalizeRoot(value) {
  if (!isNonEmptyString(value)) return null;
  return resolve(value);
}

function normalizePath(value) {
  if (!isNonEmptyString(value)) return null;
  const text = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!text || text === "." || text.includes("\0")) return null;
  if (isAbsolute(text)) return text;
  const normalized = relative(".", text).replace(/\\/g, "/");
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    if (!isNonEmptyString(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function arrayOr(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstString(values) {
  return (Array.isArray(values) ? values : [values]).find(isNonEmptyString) || null;
}

function stringOr(...values) {
  return values.find(isNonEmptyString) || undefined;
}

function integerOr(...values) {
  return values.find((value) => Number.isInteger(value));
}

function normalizeIdPart(value) {
  if (Array.isArray(value)) return value.map(normalizeIdPart).sort();
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort());
  return value ?? null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
