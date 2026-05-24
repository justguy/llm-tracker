// hub/run-session/candidates.js — sh-3-02 (TDD v0.5 §6.7, §8A.2; PRD §6.7)
//
// RunCandidateService scoring engine. Ranks runnable tasks for
// [+ NEXT IN LANE] and Hub [+ RUN] entry points. The scoring function is
// pure and deterministic — same inputs always produce the same ranking
// — and returns explanation strings (reasons[] / penalties[]) so the UI
// can show *why* a task was recommended (TDD §8A.2).
//
// Weights (TDD §6.7):
//   +100 if task is in the selected lane
//   +80  if dependencies are satisfied
//   +60  if task is marked next/recommended
//   +40  if priority is high
//   +30  if repo/worktree metadata is present
//   +20  if verify plan is present
//   -100 if task already has an active job
//   -80  if blocked
//   -50  if another active session shares the same worktree
//   -40  if allowed_paths is missing for a risky repo
//
// "Risky repo": the §6.7 PRD/TDD text describes the penalty but does not
// define a schema flag for risk. Per task.repos in
// schema/tracker-task-extensions.schema.json there is no `risky` field,
// so we interpret the rule operationally: a repo binding that pins a
// `worktree` (i.e. the task intends to write into a real workspace) but
// has no `allowed_paths` is the risky case. This is the most defensible
// reading without inventing schema fields, and matches what a reviewer
// would flag manually.

export const RUN_CANDIDATE_WEIGHTS = Object.freeze({
  inSelectedLane: 100,
  dependenciesSatisfied: 80,
  nextOrRecommended: 60,
  highPriority: 40,
  repoMetadataPresent: 30,
  verifyPlanPresent: 20,
  taskAlreadyHasActiveJob: -100,
  blocked: -80,
  sharedWorktreeWithActiveSession: -50,
  riskyRepoMissingAllowedPaths: -40,
});

export const DEFAULT_HIGH_PRIORITY_IDS = Object.freeze(["p0", "p1"]);
export const NON_RUNNABLE_STATUSES = Object.freeze([
  "complete",
  "archived",
  "cancelled",
]);
const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "blocked",
  "verifying",
]);
const ACTIVE_SESSION_STATUSES = new Set([
  "starting",
  "active",
  "running",
  "idle",
  "waiting_for_human",
  "waiting_for_approval",
  "quiet",
  "context_high",
  "stopping",
  "resuming",
  "unknown",
  "not_responding",
  "blocked",
]);

/**
 * @typedef {object} RunCandidate
 * @property {string} projectSlug
 * @property {string} taskId
 * @property {string} [laneId]
 * @property {number} score
 * @property {string[]} reasons
 * @property {string[]} penalties
 */

/**
 * Score and rank tasks for a Run Session candidate picker.
 *
 * @param {object} input
 * @param {Array<object>} input.tasks       - tracker tasks for one project.
 * @param {Array<object>} [input.sessions]  - active sessions (any project).
 * @param {Array<object>} [input.jobs]      - jobs (any project).
 * @param {object} input.options
 * @param {string} input.options.projectSlug
 * @param {string} [input.options.laneId]   - "selected lane" for +100 bonus.
 * @param {Iterable<string>} [input.options.recommendedTaskIds] - tasks the
 *   project explicitly recommends (e.g. project meta.next list). Used for
 *   the +60 next/recommended bonus.
 * @param {Iterable<string>} [input.options.highPriorityIds] - priorityIds
 *   that count as "high" (default: ["p0", "p1"]).
 * @returns {RunCandidate[]} sorted by score desc, then taskId asc.
 */
export function scoreRunCandidates(input) {
  const { tasks, sessions = [], jobs = [], options } = input ?? {};
  if (!options || typeof options !== "object") {
    throw new TypeError("scoreRunCandidates: options is required");
  }
  const { projectSlug } = options;
  if (typeof projectSlug !== "string" || projectSlug.length === 0) {
    throw new TypeError("scoreRunCandidates: options.projectSlug is required");
  }
  if (!Array.isArray(tasks)) {
    throw new TypeError("scoreRunCandidates: tasks must be an array");
  }
  if (!Array.isArray(sessions)) {
    throw new TypeError("scoreRunCandidates: sessions must be an array");
  }
  if (!Array.isArray(jobs)) {
    throw new TypeError("scoreRunCandidates: jobs must be an array");
  }

  const laneId = options.laneId;
  const recommendedTaskIds = new Set(options.recommendedTaskIds ?? []);
  const highPriorityIds = new Set(options.highPriorityIds ?? DEFAULT_HIGH_PRIORITY_IDS);

  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const activeJobByTaskId = buildActiveJobByTaskId(jobs, projectSlug);
  const activeWorktrees = buildActiveSessionWorktrees(sessions);

  const candidates = [];
  for (const task of tasks) {
    if (!isRunnable(task)) continue;
    const { score, reasons, penalties } = scoreTask(task, {
      laneId,
      recommendedTaskIds,
      highPriorityIds,
      tasksById,
      activeJobByTaskId,
      activeWorktrees,
    });
    candidates.push({
      projectSlug,
      taskId: task.id,
      laneId: taskLaneId(task),
      score,
      reasons,
      penalties,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  return candidates;
}

function isRunnable(task) {
  if (!task || typeof task !== "object") return false;
  if (typeof task.id !== "string" || task.id.length === 0) return false;
  if (task.archived === true) return false;
  return !NON_RUNNABLE_STATUSES.includes(task.status);
}

function buildActiveJobByTaskId(jobs, projectSlug) {
  const map = new Map();
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    if (typeof job.taskId !== "string") continue;
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
    const jobProjectSlug = job.projectSlug ?? job.project?.slug;
    if (typeof jobProjectSlug === "string" && jobProjectSlug !== projectSlug) continue;
    if (!map.has(job.taskId)) map.set(job.taskId, job);
  }
  return map;
}

function buildActiveSessionWorktrees(sessions) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    if (s.status != null && !ACTIVE_SESSION_STATUSES.has(s.status)) continue;
    const path = s.worktreePath ?? s.worktree;
    if (typeof path !== "string" || path.length === 0) continue;
    const list = map.get(path) ?? [];
    list.push(s);
    map.set(path, list);
  }
  return map;
}

function scoreTask(task, ctx) {
  const reasons = [];
  const penalties = [];
  let score = 0;

  const laneOfTask = taskLaneId(task);
  if (ctx.laneId && laneOfTask === ctx.laneId) {
    score += RUN_CANDIDATE_WEIGHTS.inSelectedLane;
    reasons.push(`+${RUN_CANDIDATE_WEIGHTS.inSelectedLane} in selected lane "${ctx.laneId}"`);
  }

  const blockingDeps = blockingDependencyIds(task, ctx.tasksById);
  if (blockingDeps.length === 0) {
    score += RUN_CANDIDATE_WEIGHTS.dependenciesSatisfied;
    reasons.push(`+${RUN_CANDIDATE_WEIGHTS.dependenciesSatisfied} dependencies satisfied`);
  }

  if (ctx.recommendedTaskIds.has(task.id)) {
    score += RUN_CANDIDATE_WEIGHTS.nextOrRecommended;
    reasons.push(`+${RUN_CANDIDATE_WEIGHTS.nextOrRecommended} marked next/recommended`);
  }

  const priorityId = taskPriorityId(task);
  if (typeof priorityId === "string" && ctx.highPriorityIds.has(priorityId)) {
    score += RUN_CANDIDATE_WEIGHTS.highPriority;
    reasons.push(`+${RUN_CANDIDATE_WEIGHTS.highPriority} priority ${priorityId}`);
  }

  if (hasRepoMetadata(task)) {
    score += RUN_CANDIDATE_WEIGHTS.repoMetadataPresent;
    reasons.push(`+${RUN_CANDIDATE_WEIGHTS.repoMetadataPresent} repo/worktree metadata present`);
  }

  if (hasVerifyPlan(task)) {
    score += RUN_CANDIDATE_WEIGHTS.verifyPlanPresent;
    reasons.push(`+${RUN_CANDIDATE_WEIGHTS.verifyPlanPresent} verify plan present`);
  }

  const activeJob = ctx.activeJobByTaskId.get(task.id);
  if (activeJob) {
    score += RUN_CANDIDATE_WEIGHTS.taskAlreadyHasActiveJob;
    penalties.push(
      `${RUN_CANDIDATE_WEIGHTS.taskAlreadyHasActiveJob} task already has active job ${activeJob.id}`,
    );
  }

  if (isBlocked(task) || blockingDeps.length > 0) {
    score += RUN_CANDIDATE_WEIGHTS.blocked;
    const detail =
      blockingDeps.length > 0 ? ` blocked by ${blockingDeps.join(", ")}` : "";
    penalties.push(`${RUN_CANDIDATE_WEIGHTS.blocked} task is blocked${detail}`);
  }

  const sharedWorktreeMatch = findSharedWorktree(task, ctx.activeWorktrees);
  if (sharedWorktreeMatch) {
    score += RUN_CANDIDATE_WEIGHTS.sharedWorktreeWithActiveSession;
    penalties.push(
      `${RUN_CANDIDATE_WEIGHTS.sharedWorktreeWithActiveSession} worktree ${sharedWorktreeMatch.worktree} already used by ${sharedWorktreeMatch.sessionIds.join(",")}`,
    );
  }

  const riskyRepoMatch = findRiskyRepoMissingAllowedPaths(task);
  if (riskyRepoMatch) {
    score += RUN_CANDIDATE_WEIGHTS.riskyRepoMissingAllowedPaths;
    penalties.push(
      `${RUN_CANDIDATE_WEIGHTS.riskyRepoMissingAllowedPaths} repo ${riskyRepoMatch.root} pins worktree without allowed_paths`,
    );
  }

  return { score, reasons, penalties };
}

function blockingDependencyIds(task, tasksById) {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  const blocking = [];
  for (const depId of deps) {
    const dep = tasksById.get(depId);
    if (!dep || dep.status !== "complete") blocking.push(depId);
  }
  return blocking;
}

function taskLaneId(task) {
  return task.placement?.swimlaneId ?? task.swimlaneId ?? task.laneId;
}

function taskPriorityId(task) {
  return task.placement?.priorityId ?? task.priorityId;
}

function hasRepoMetadata(task) {
  const repos = task.repos;
  if (!repos || typeof repos !== "object") return false;
  if (repos.primary && typeof repos.primary === "object" && typeof repos.primary.root === "string") {
    return true;
  }
  if (Array.isArray(repos.secondary) && repos.secondary.length > 0) {
    return repos.secondary.some(
      (r) => r && typeof r === "object" && typeof r.root === "string",
    );
  }
  return false;
}

function hasVerifyPlan(task) {
  const verify = task.verify;
  return Boolean(
    verify && typeof verify === "object" && Array.isArray(verify.items) && verify.items.length > 0,
  );
}

function isBlocked(task) {
  if (task.status === "blocked") return true;
  if (typeof task.blocked_kind === "string" && task.blocked_kind.length > 0) return true;
  if (Array.isArray(task.blocked_by) && task.blocked_by.length > 0) return true;
  return false;
}

function repoRefList(task) {
  const repos = task.repos;
  if (!repos || typeof repos !== "object") return [];
  const refs = [];
  if (repos.primary && typeof repos.primary === "object") refs.push(repos.primary);
  if (Array.isArray(repos.secondary)) {
    for (const r of repos.secondary) {
      if (r && typeof r === "object") refs.push(r);
    }
  }
  return refs;
}

function findSharedWorktree(task, activeWorktrees) {
  for (const ref of repoRefList(task)) {
    if (typeof ref.worktree !== "string" || ref.worktree.length === 0) continue;
    const sessions = activeWorktrees.get(ref.worktree);
    if (sessions && sessions.length > 0) {
      return {
        worktree: ref.worktree,
        sessionIds: sessions.map((s) => s.id).filter((id) => typeof id === "string"),
      };
    }
  }
  return null;
}

function findRiskyRepoMissingAllowedPaths(task) {
  for (const ref of repoRefList(task)) {
    const pinsWorktree = typeof ref.worktree === "string" && ref.worktree.length > 0;
    if (!pinsWorktree) continue;
    const hasAllowedPaths = Array.isArray(ref.allowed_paths) && ref.allowed_paths.length > 0;
    if (!hasAllowedPaths) return ref;
  }
  return null;
}
