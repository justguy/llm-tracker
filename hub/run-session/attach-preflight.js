// hub/run-session/attach-preflight.js — SH-3-20
//
// Pure AttachTaskModal preflight. This module only reads already-projected
// session/job/tracker state and returns modal-friendly checks; it never appends
// runtime events or mutates registries.

import { TERMINAL_JOB_STATUS } from "../jobs/registry.js";
import { BUILT_IN_PROFILES_BY_ID } from "../jobs/profiles.js";
import { WORKSPACE_CONFIG_DEFAULTS } from "../config/defaults.js";

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
const TERMINAL_SESSION_STATUSES = new Set(["done", "stopped", "rolled_over", "archived"]);
const DEFAULT_PROFILE_ID = "code-implementer";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function check(id, label, status, severity, detail, extra = {}) {
  return { id, label, status, severity, detail, ...extra };
}

function sameProject(record, projectSlug) {
  const value = record?.projectSlug ?? record?.project?.slug;
  return !nonEmptyString(value) || value === projectSlug;
}

function sameTaskBinding(record, projectSlug, taskId) {
  return isRecord(record) && record.taskId === taskId && sameProject(record, projectSlug);
}

function findTaskBinding({ projectSlug, taskId, sessionId, jobs, sessions }) {
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!sameTaskBinding(job, projectSlug, taskId)) continue;
    if (TERMINAL_JOB_STATUS.includes(job.status)) continue;
    return {
      sessionId: nonEmptyString(job.sessionId) ? job.sessionId : null,
      jobId: nonEmptyString(job.id) ? job.id : null,
      ownSession: job.sessionId === sessionId,
    };
  }

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!sameTaskBinding(session, projectSlug, taskId)) continue;
    if (!ACTIVE_SESSION_STATUSES.has(session.status)) continue;
    return {
      sessionId: nonEmptyString(session.id) ? session.id : null,
      jobId: nonEmptyString(session.activeJobId) ? session.activeJobId : null,
      ownSession: session.id === sessionId,
    };
  }
  return null;
}

function taskPathEvidence(task) {
  const values = [];
  const refs = [];
  if (nonEmptyString(task.reference)) refs.push(task.reference);
  if (Array.isArray(task.references)) refs.push(...task.references);
  for (const ref of refs) {
    if (!nonEmptyString(ref)) continue;
    const withoutLine = ref.replace(/:\d+(?:-\d+)?$/, "");
    if (withoutLine && withoutLine === ref && /^[a-z]+:\/\//i.test(ref)) continue;
    if (withoutLine) values.push(withoutLine);
  }
  const touched = task.context?.files_touched;
  if (Array.isArray(touched)) {
    for (const file of touched) {
      if (nonEmptyString(file)) values.push(file);
    }
  }
  return [...new Set(values.filter((value) => !value.startsWith("/") && !value.includes("\0")))];
}

function allowedPathsForTask(task) {
  const out = [];
  if (Array.isArray(task.allowed_paths)) out.push(...task.allowed_paths);
  const primary = task.repos?.primary;
  if (Array.isArray(primary?.allowed_paths)) out.push(...primary.allowed_paths);
  for (const repo of Array.isArray(task.repos?.secondary) ? task.repos.secondary : []) {
    if (Array.isArray(repo?.allowed_paths)) out.push(...repo.allowed_paths);
  }
  return [...new Set(out.filter(nonEmptyString))];
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function pathMatchesAllowed(path, allowed) {
  const normalizedPath = normalizeRelativePath(path);
  const normalizedAllowed = normalizeRelativePath(allowed);
  if (!normalizedPath || !normalizedAllowed || normalizedAllowed.includes("\0")) return false;
  if (allowed === "**" || allowed === "*") return true;
  if (normalizedAllowed.endsWith("/**")) {
    const prefix = normalizedAllowed.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedAllowed.endsWith("/*")) {
    const prefix = normalizedAllowed.slice(0, -2);
    const rest = normalizedPath.startsWith(`${prefix}/`) ? normalizedPath.slice(prefix.length + 1) : null;
    return rest !== null && rest.length > 0 && !rest.includes("/");
  }
  if (/[*?]/.test(normalizedAllowed)) {
    return globToRegExp(normalizedAllowed).test(normalizedPath);
  }
  return normalizedPath === normalizedAllowed || normalizedPath.startsWith(`${normalizedAllowed}/`);
}

function resolveProfile(profileId) {
  const id = nonEmptyString(profileId) ? profileId : DEFAULT_PROFILE_ID;
  return { id, profile: BUILT_IN_PROFILES_BY_ID.get(id) || null };
}

function contextBudgetFor(session, input) {
  const raw = isRecord(input.contextBudget) ? input.contextBudget : {};
  const capacity =
    nonNegativeNumber(raw.capacity) ? raw.capacity :
      nonNegativeNumber(raw.limit) ? raw.limit :
        nonNegativeNumber(session?.contextUsage?.limit) ? session.contextUsage.limit :
          nonNegativeNumber(session?.ctxMax) ? session.ctxMax :
            null;
  const currentUsed =
    nonNegativeNumber(raw.currentUsed) ? raw.currentUsed :
      nonNegativeNumber(raw.used) ? raw.used :
        nonNegativeNumber(session?.contextUsage?.used) ? session.contextUsage.used :
          nonNegativeNumber(session?.contextUsage?.percent) && nonNegativeNumber(capacity)
            ? (session.contextUsage.percent / 100) * capacity
            : null;
  const estBriefTokens =
    nonNegativeNumber(raw.estBriefTokens) ? raw.estBriefTokens :
      nonNegativeNumber(input.estBriefTokens) ? input.estBriefTokens :
        nonNegativeNumber(input.contextBriefTokens) ? input.contextBriefTokens :
          0;
  return { capacity, currentUsed, estBriefTokens };
}

function resolveOverflowWarnPercent(config) {
  const percent = config?.attach?.contextOverflowWarnPercent ?? config?.contextOverflowWarnPercent;
  if (Number.isFinite(percent) && percent > 0 && percent <= 1) return percent;
  return WORKSPACE_CONFIG_DEFAULTS.sessionHub.attach.contextOverflowWarnPercent;
}

function worktreeValue(session) {
  return session?.worktreePath || session?.repoRoot || session?.cwd || null;
}

function activeWorktreeConflicts(session, sessions) {
  const own = worktreeValue(session);
  if (!nonEmptyString(own)) return [];
  return (Array.isArray(sessions) ? sessions : [])
    .filter((other) => {
      if (!isRecord(other) || other.id === session.id) return false;
      if (!ACTIVE_SESSION_STATUSES.has(other.status)) return false;
      return worktreeValue(other) === own;
    })
    .map((other) => other.id)
    .filter(nonEmptyString);
}

/**
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.projectSlug
 * @param {string} input.taskId
 * @param {object | null} input.session
 * @param {object | null} input.task
 * @param {object[]} [input.sessions]
 * @param {object[]} [input.jobs]
 * @param {string} [input.profileId]
 * @param {{ attach?: { contextOverflowWarnPercent?: number } }} [input.config]
 * @returns {{ checks: object[], hasFail: boolean, hasWarn: boolean }}
 */
export function buildAttachTaskPreflight(input = {}) {
  if (!isRecord(input)) throw new TypeError("buildAttachTaskPreflight: input must be an object");
  const { sessionId, projectSlug, taskId, session, task } = input;
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const checks = [];

  const binding = nonEmptyString(projectSlug) && nonEmptyString(taskId)
    ? findTaskBinding({ projectSlug, taskId, sessionId, jobs, sessions })
    : null;
  checks.push(
    binding
      ? check(
          "task_not_already_bound",
          "task not already bound",
          "fail",
          "high",
          binding.ownSession
            ? "task is already bound to this session"
            : `task is already bound to ${binding.sessionId || "another session"}`,
          { kind: "task_already_bound_other_session", binding },
        )
      : check("task_not_already_bound", "task not already bound", "ok", "none", "no active binding found"),
  );

  if (!session) {
    checks.push(check("session_accepts_new_task", "session accepts new task", "fail", "high", "session not found"));
  } else if (TERMINAL_SESSION_STATUSES.has(session.status)) {
    checks.push(
      check("session_accepts_new_task", "session accepts new task", "fail", "high", `session is ${session.status}`),
    );
  } else if (session.taskId === taskId) {
    checks.push(
      check("session_accepts_new_task", "session accepts new task", "fail", "high", "session already has this task"),
    );
  } else {
    checks.push(
      check(
        "session_accepts_new_task",
        "session accepts new task",
        "ok",
        "none",
        session.activeJobId ? "session can queue a successor task" : "session can accept a task binding",
      ),
    );
  }

  if (!task) {
    checks.push(check("task_scope_allowed_paths", "task scope inside allowed_paths", "fail", "high", "task not found"));
  } else {
    const allowed = allowedPathsForTask(task);
    const paths = taskPathEvidence(task);
    const outside = paths.filter((path) => !allowed.some((entry) => pathMatchesAllowed(path, entry)));
    if (paths.length > 0 && allowed.length === 0) {
      checks.push(
        check("task_scope_allowed_paths", "task scope inside allowed_paths", "warn", "medium", "task has path evidence but no allowed_paths"),
      );
    } else if (outside.length > 0) {
      checks.push(
        check("task_scope_allowed_paths", "task scope inside allowed_paths", "fail", "high", "task path evidence escapes allowed_paths", {
          outside,
        }),
      );
    } else {
      checks.push(
        check(
          "task_scope_allowed_paths",
          "task scope inside allowed_paths",
          "ok",
          "none",
          paths.length > 0 ? "task path evidence is within allowed_paths" : "no task path evidence to constrain",
        ),
      );
    }
  }

  const { id: profileId, profile } = resolveProfile(input.profileId);
  const expectedKind = task?.context?.jobKind || task?.context?.profileKind || null;
  if (!profile) {
    checks.push(check("profile_compatible", "profile compatible", "fail", "high", `unknown profile: ${profileId}`));
  } else if (nonEmptyString(expectedKind) && profile.kind !== expectedKind) {
    checks.push(
      check("profile_compatible", "profile compatible", "fail", "high", `profile kind ${profile.kind} does not match ${expectedKind}`),
    );
  } else {
    checks.push(check("profile_compatible", "profile compatible", "ok", "none", `${profileId} can run ${profile.kind} work`));
  }

  const conflicts = session ? activeWorktreeConflicts(session, sessions) : [];
  checks.push(
    conflicts.length > 0
      ? check("no_worktree_conflict", "no worktree conflict", "warn", "medium", `worktree is shared with ${conflicts.join(", ")}`, {
          conflictingSessionIds: conflicts,
        })
      : check("no_worktree_conflict", "no worktree conflict", "ok", "none", "no active session shares the worktree"),
  );

  const { capacity, currentUsed, estBriefTokens } = contextBudgetFor(session, input);
  const warnPercent = resolveOverflowWarnPercent(input.config);
  if (!nonNegativeNumber(capacity) || !nonNegativeNumber(currentUsed)) {
    checks.push(check("context_room_available", "context room available", "ok", "none", "no context budget reported"));
  } else {
    const projected = currentUsed + estBriefTokens;
    if (projected > capacity) {
      checks.push(
        check("context_room_available", "context room available", "fail", "high", `projected context ${projected}/${capacity} exceeds capacity`, {
          kind: "attach_context_overflow",
          currentUsed,
          estBriefTokens,
          capacity,
          warnPercent,
        }),
      );
    } else if (projected >= capacity * warnPercent) {
      checks.push(
        check("context_room_available", "context room available", "warn", "medium", `projected context ${projected}/${capacity} crosses attach warning threshold`, {
          kind: "attach_context_overflow",
          currentUsed,
          estBriefTokens,
          capacity,
          warnPercent,
        }),
      );
    } else {
      checks.push(check("context_room_available", "context room available", "ok", "none", `projected context ${projected}/${capacity}`));
    }
  }

  return {
    checks,
    hasFail: checks.some((item) => item.status === "fail"),
    hasWarn: checks.some((item) => item.status === "warn"),
  };
}
