import { isAbsolute, relative, resolve } from "node:path";

const NUL = "\0";
const WIN_DRIVE_RE = /^[A-Za-z]:/;
const URI_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|file|data|ssh|git):)/i;

export function normalizeRepoRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function repoRelativeChangedPath(repoRoot, filePath) {
  if (!isNonEmptyString(filePath)) return null;
  const raw =
    isNonEmptyString(repoRoot) && isAbsolute(filePath)
      ? relative(resolve(repoRoot), resolve(filePath))
      : filePath;
  const normalized = normalizeRepoRelativePath(raw);
  if (!normalized || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

export function isValidAllowedPathPattern(pattern) {
  if (!isNonEmptyString(pattern)) return false;
  if (pattern.length > 512) return false;
  if (pattern.includes(NUL)) return false;
  if (pattern.startsWith("/")) return false;
  if (WIN_DRIVE_RE.test(pattern)) return false;
  if (URI_SCHEME_RE.test(pattern)) return false;
  if (pattern.includes("\\")) return false;
  return !pattern.split("/").some((segment) => segment === "..");
}

export function allowedPathGlobToRegExp(pattern) {
  if (!isValidAllowedPathPattern(pattern)) {
    throw new TypeError("allowedPathGlobToRegExp: pattern must be a valid repo-relative glob");
  }
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
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
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function pathMatchesAllowedPath(path, pattern) {
  const normalizedPath = normalizeRepoRelativePath(path);
  if (!normalizedPath || !isValidAllowedPathPattern(pattern)) return false;
  const normalizedPattern = normalizeRepoRelativePath(pattern);
  if (!isValidAllowedPathPattern(normalizedPattern)) return false;
  if (normalizedPattern === "**" || normalizedPattern === "*") return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    const rest = normalizedPath.startsWith(`${prefix}/`)
      ? normalizedPath.slice(prefix.length + 1)
      : null;
    return rest !== null && rest.length > 0 && !rest.includes("/");
  }
  if (/[*?]/.test(normalizedPattern)) {
    return allowedPathGlobToRegExp(normalizedPattern).test(normalizedPath);
  }
  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

export function createAllowedPathMatcher(patterns) {
  const normalizedPatterns = normalizeAllowedPathPatterns(patterns);
  return {
    hasAllowedPaths: Array.isArray(patterns),
    patterns: normalizedPatterns,
    matches(path) {
      if (!Array.isArray(patterns)) return true;
      return normalizedPatterns.some((pattern) => pathMatchesAllowedPath(path, pattern));
    },
  };
}

export function normalizeAllowedPathPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  const out = [];
  const seen = new Set();
  for (const pattern of patterns) {
    if (!isValidAllowedPathPattern(pattern)) continue;
    const normalized = normalizeRepoRelativePath(pattern);
    if (!isValidAllowedPathPattern(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function taskRepoRefs(task) {
  const refs = [];
  if (task?.repos?.primary && typeof task.repos.primary === "object") refs.push(task.repos.primary);
  if (Array.isArray(task?.repos?.secondary)) {
    refs.push(...task.repos.secondary.filter((ref) => ref && typeof ref === "object"));
  }
  return refs;
}

export function allowedPathPatternsForTaskRepo(task, repoRoot) {
  const refs = taskRepoRefs(task).filter((ref) => repoRefMatchesRoot(ref, repoRoot));
  const hasAllowedPaths = refs.some((ref) =>
    Object.prototype.hasOwnProperty.call(ref, "allowed_paths"),
  );
  if (!hasAllowedPaths && Array.isArray(task?.allowed_paths)) {
    return {
      hasAllowedPaths: true,
      patterns: normalizeAllowedPathPatterns(task.allowed_paths),
    };
  }
  if (!hasAllowedPaths) return { hasAllowedPaths: false, patterns: [] };
  return {
    hasAllowedPaths: true,
    patterns: normalizeAllowedPathPatterns(refs.flatMap((ref) => ref.allowed_paths || [])),
  };
}

export function evaluateAllowedPathForRepoChange({ task, repoRoot, path, filePath } = {}) {
  const changedPath = repoRelativeChangedPath(repoRoot, filePath || path);
  if (!changedPath) {
    return {
      changedPath: null,
      hasAllowedPaths: false,
      patterns: [],
      matched: true,
      outsideAllowedPaths: false,
      reason: "path_outside_repo",
    };
  }
  const { hasAllowedPaths, patterns } = allowedPathPatternsForTaskRepo(task, repoRoot);
  if (!hasAllowedPaths) {
    return {
      changedPath,
      hasAllowedPaths: false,
      patterns: [],
      matched: true,
      outsideAllowedPaths: false,
      reason: "allowed_paths_absent",
    };
  }
  const matched = patterns.some((pattern) => pathMatchesAllowedPath(changedPath, pattern));
  return {
    changedPath,
    hasAllowedPaths: true,
    patterns,
    matched,
    outsideAllowedPaths: !matched,
    reason: matched ? "allowed_path_matched" : "outside_allowed_paths",
  };
}

export function annotateRepoChangeWithAllowedPaths(event, task) {
  const result = evaluateAllowedPathForRepoChange({
    task,
    repoRoot: event?.repoRoot,
    path: event?.path,
  });
  if (!result.outsideAllowedPaths) return { event, result, conflict: null };
  const annotated = { ...event, outsideAllowedPaths: true };
  const conflict = {
    id: `${event.id}:outside_allowed_paths`,
    kind: "outside_allowed_paths",
    projectSlug: event.projectSlug,
    taskId: task?.id,
    paths: [result.changedPath],
    path: result.changedPath,
    eventId: event.id,
    evidenceRef: event.id,
    repoRoot: event.repoRoot,
    allowedPaths: result.patterns,
  };
  return { event: annotated, result, conflict };
}

function repoRefMatchesRoot(ref, repoRoot) {
  if (!ref || typeof ref !== "object") return false;
  return [ref.root, ref.worktree, ref.worktreePath].some((root) => sameRoot(root, repoRoot));
}

function sameRoot(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  return resolve(left) === resolve(right);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
