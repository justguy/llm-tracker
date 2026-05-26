import { isAbsolute, relative, resolve, sep } from "node:path";

export const ATTRIBUTION_STRENGTHS = Object.freeze(["strong", "likely", "ambiguous", "unknown"]);
export const RUNTIME_ATTRIBUTIONS = Object.freeze([
  "worktree",
  "single_active_session",
  "ambiguous",
  "unknown",
]);

const INACTIVE_SESSION_STATUSES = new Set([
  "archived",
  "cancelled",
  "complete",
  "completed",
  "done",
  "failed",
  "stopped",
]);

export function classifyRepoChangeAttribution({
  repoRoot,
  path,
  sessions = [],
  projectSlug = null,
} = {}) {
  if (!isNonEmptyString(repoRoot)) {
    throw new TypeError("classifyRepoChangeAttribution: repoRoot is required");
  }
  if (!isNonEmptyString(path)) {
    throw new TypeError("classifyRepoChangeAttribution: path is required");
  }
  if (!Array.isArray(sessions)) {
    throw new TypeError("classifyRepoChangeAttribution: sessions must be an array");
  }

  const filePath = repoChangeAbsolutePath(repoRoot, path);
  const activeSessions = sessions.filter((session) => sessionMatchesProject(session, projectSlug));
  const matches = activeSessions
    .map((session) => sessionMatchForFile(session, filePath))
    .filter(Boolean);
  const sessionIds = matches.map((match) => match.session.id).filter(isNonEmptyString);

  if (matches.length === 0) {
    return attributionResult("unknown", "unknown", [], "no_active_session_matches_repo_root");
  }
  if (matches.length > 1) {
    return attributionResult("ambiguous", "ambiguous", sessionIds, "multiple_active_sessions_match");
  }

  const match = matches[0];
  if (match.rootKind === "worktree" && worktreeRootIsUnique(match.root, activeSessions, match.session)) {
    return attributionResult("strong", "worktree", sessionIds, "unique_session_worktree_matches_path");
  }

  return attributionResult("likely", "single_active_session", sessionIds, "single_active_session_matches");
}

export function runtimeAttributionForStrength(strength) {
  switch (strength) {
    case "strong":
      return "worktree";
    case "likely":
      return "single_active_session";
    case "ambiguous":
    case "unknown":
      return strength;
    default:
      throw new TypeError("runtimeAttributionForStrength: unknown attribution strength");
  }
}

export function repoChangeAbsolutePath(repoRoot, path) {
  if (!isNonEmptyString(repoRoot) || !isNonEmptyString(path)) return null;
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
}

export function activeSessionIdsForRepo({ repoRoot, path = ".", sessions = [], projectSlug = null } = {}) {
  return classifyRepoChangeAttribution({ repoRoot, path, sessions, projectSlug }).sessionIds;
}

function attributionResult(strength, runtimeAttribution, sessionIds, reason) {
  return {
    strength,
    runtimeAttribution,
    sessionIds,
    activeSessionIds: sessionIds,
    possibleSessionIds: sessionIds,
    reason,
  };
}

function sessionMatchesProject(session, projectSlug) {
  if (!session || typeof session !== "object") return false;
  if (!isActiveSession(session)) return false;
  if (isNonEmptyString(projectSlug) && isNonEmptyString(session.projectSlug)) {
    return session.projectSlug === projectSlug;
  }
  return true;
}

export function isActiveSession(session) {
  return session && !INACTIVE_SESSION_STATUSES.has(String(session.status || "").toLowerCase());
}

function sessionMatchForFile(session, filePath) {
  const roots = sessionBindingRoots(session);
  for (const root of roots) {
    if (isSameOrChild(filePath, root.root)) return { session, ...root };
  }
  return null;
}

function sessionBindingRoots(session) {
  return [
    { rootKind: "worktree", root: firstString(session.worktreePath, session.worktree) },
    { rootKind: "repo", root: session.repoRoot },
    { rootKind: "cwd", root: session.cwd },
  ].filter((item) => isNonEmptyString(item.root));
}

function worktreeRootIsUnique(root, sessions, owner) {
  if (!isNonEmptyString(root)) return false;
  return sessions.every((session) => {
    if (session === owner) return true;
    const other = firstString(session.worktreePath, session.worktree);
    return !isNonEmptyString(other) || !sameRoot(root, other);
  });
}

function isSameOrChild(candidate, root) {
  if (!isNonEmptyString(candidate) || !isNonEmptyString(root)) return false;
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sameRoot(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}${sep}`) ||
    normalizedRight.startsWith(`${normalizedLeft}${sep}`)
  );
}

function firstString(...values) {
  return values.find(isNonEmptyString) || null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
