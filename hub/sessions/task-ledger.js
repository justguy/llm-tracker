// hub/sessions/task-ledger.js — SH-2-25 (TDD v0.5 §23.2 #29/#35)
//
// Computes SessionTaskLedgerItem[] on demand. This module never writes
// `boundTasks` or other multi-task derived fields onto SessionRecord.

import { scoreRunCandidates } from "../run-session/candidates.js";

export const SESSION_TASK_LEDGER_RELATIONS = Object.freeze([
  "active_job",
  "queued_next",
  "completed_in_session",
  "suggested_next",
  "mentioned",
]);

export const SESSION_TASK_LEDGER_SOURCES = Object.freeze([
  "job_registry",
  "tracker_queue",
  "human",
  "recommendation",
]);

const ACTIVE_JOB_STATUSES = new Set([
  "starting",
  "running",
  "blocked",
  "verifying",
]);

const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "cancelled",
  "rolled_over",
]);

const DEFAULT_SUGGESTION_LIMIT = 5;

export class SessionTaskLedgerService {
  constructor(deps = {}) {
    const {
      projection,
      jobRegistry,
      store,
      getTasksForProject,
      getRunCandidates,
      suggestionLimit = DEFAULT_SUGGESTION_LIMIT,
    } = deps;
    if (!projection || !(projection.sessions instanceof Map) || typeof projection.toSnapshots !== "function") {
      throw new Error("SessionTaskLedgerService: projection (with sessions Map + toSnapshots) required");
    }
    this.projection = projection;
    this.jobRegistry = jobRegistry;
    this.store = store;
    this.getTasksForProject = typeof getTasksForProject === "function" ? getTasksForProject : null;
    this.getRunCandidates = typeof getRunCandidates === "function" ? getRunCandidates : null;
    this.suggestionLimit = Number.isInteger(suggestionLimit) && suggestionLimit > 0
      ? suggestionLimit
      : DEFAULT_SUGGESTION_LIMIT;
  }

  getLedger(sessionId) {
    return this.get(sessionId);
  }

  get(sessionId) {
    if (typeof sessionId !== "string") return null;
    const session = this.projection.sessions.get(sessionId);
    if (!session) return null;

    const snapshots = this.projection.toSnapshots();
    const jobs =
      this.jobRegistry && typeof this.jobRegistry.list === "function"
        ? this.jobRegistry.list()
        : Array.isArray(snapshots.jobs)
          ? snapshots.jobs.map((job) => ({ ...job }))
          : [];
    const sessions = Array.isArray(snapshots.sessions) ? snapshots.sessions : [];

    return buildSessionTaskLedger({
      session,
      jobs,
      sessions,
      projectEntry: session.projectSlug ? this.#projectEntry(session.projectSlug) : null,
      getTasksForProject: this.getTasksForProject,
      getRunCandidates: this.getRunCandidates,
      suggestionLimit: this.suggestionLimit,
    });
  }

  #projectEntry(projectSlug) {
    if (!this.store || typeof this.store.get !== "function") return null;
    return this.store.get(projectSlug) || null;
  }
}

export function buildSessionTaskLedger(input = {}) {
  const {
    session,
    jobs = [],
    sessions = [],
    projectEntry = null,
    getTasksForProject,
    getRunCandidates,
    suggestionLimit = DEFAULT_SUGGESTION_LIMIT,
  } = input;
  if (!session || typeof session !== "object") {
    throw new TypeError("buildSessionTaskLedger: session is required");
  }
  if (!Array.isArray(jobs)) {
    throw new TypeError("buildSessionTaskLedger: jobs must be an array");
  }

  const sessionJobs = jobs.filter((job) => job && job.sessionId === session.id);
  const injectedTasks =
    typeof getTasksForProject === "function" && typeof session.projectSlug === "string"
      ? getTasksForProject(session.projectSlug)
      : null;
  const tasks = Array.isArray(injectedTasks)
    ? injectedTasks
    : Array.isArray(projectEntry?.data?.tasks)
      ? projectEntry.data.tasks
      : [];
  const taskById = new Map(tasks.filter((task) => task && typeof task.id === "string").map((task) => [task.id, task]));
  const ledger = [];
  const seenTaskIds = new Set();

  const push = (item) => {
    if (!item || typeof item.taskId !== "string" || item.taskId.length === 0) return;
    if (seenTaskIds.has(item.taskId)) return;
    seenTaskIds.add(item.taskId);
    ledger.push(item);
  };

  const activeJob = findActiveJob(session, sessionJobs, jobs);
  if (activeJob) {
    push(itemFromJob(activeJob, "active_job", "job_registry", taskById));
  }

  for (const job of orderedQueuedJobs(session, sessionJobs, jobs)) {
    push(itemFromJob(job, "queued_next", "tracker_queue", taskById));
  }

  for (const job of sessionJobs) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      push(itemFromJob(job, "completed_in_session", "job_registry", taskById));
    }
  }

  if (typeof session.projectSlug === "string" && session.projectSlug.length > 0 && tasks.length > 0) {
    const candidates =
      typeof getRunCandidates === "function"
        ? getRunCandidates({ session, jobs, sessions, tasks })
        : scoreRunCandidates({
            tasks,
            sessions,
            jobs,
            options: { projectSlug: session.projectSlug },
          });
    for (const candidate of candidates.slice(0, Math.max(1, suggestionLimit))) {
      push({
        taskId: candidate.taskId,
        relation: "suggested_next",
        taskStatus: taskStatus(taskById.get(candidate.taskId), null),
        source: "recommendation",
      });
    }
  }

  if (typeof session.taskId === "string" && session.taskId.length > 0) {
    push({
      taskId: session.taskId,
      relation: "mentioned",
      taskStatus: taskStatus(taskById.get(session.taskId), null),
      source: "human",
    });
  }

  return ledger;
}

function findActiveJob(session, sessionJobs, allJobs) {
  if (typeof session.activeJobId === "string" && session.activeJobId.length > 0) {
    const mirrored = allJobs.find((job) => job && job.id === session.activeJobId) || null;
    if (isSessionJob(mirrored, session) && ACTIVE_JOB_STATUSES.has(mirrored.status)) return mirrored;
  }
  return sessionJobs.find((job) => ACTIVE_JOB_STATUSES.has(job.status)) || null;
}

function orderedQueuedJobs(session, sessionJobs, allJobs) {
  const byId = new Map(allJobs.filter((job) => job && typeof job.id === "string").map((job) => [job.id, job]));
  const ordered = [];
  const seen = new Set();
  if (Array.isArray(session.queuedJobIds)) {
    for (const jobId of session.queuedJobIds) {
      const job = byId.get(jobId);
      if (isSessionJob(job, session) && job.status === "queued" && !seen.has(job.id)) {
        ordered.push(job);
        seen.add(job.id);
      }
    }
  }
  const fallback = sessionJobs
    .filter((job) => job.status === "queued" && !seen.has(job.id))
    .sort(compareQueuedJobs);
  return ordered.concat(fallback);
}

function isSessionJob(job, session) {
  return Boolean(job && job.sessionId === session.id);
}

function compareQueuedJobs(a, b) {
  const at = typeof a.queuedAt === "string" ? a.queuedAt : "";
  const bt = typeof b.queuedAt === "string" ? b.queuedAt : "";
  if (at !== bt) return at < bt ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

function itemFromJob(job, relation, source, taskById) {
  return {
    taskId: job.taskId,
    jobId: job.id,
    relation,
    taskStatus: taskStatus(taskById.get(job.taskId), job),
    source,
  };
}

function taskStatus(task, fallbackJob) {
  if (task && typeof task.status === "string" && task.status.length > 0) return task.status;
  if (fallbackJob && typeof fallbackJob.status === "string" && fallbackJob.status.length > 0) return fallbackJob.status;
  return "unknown";
}
