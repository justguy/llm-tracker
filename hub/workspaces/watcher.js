import { isAbsolute, relative, resolve, sep } from "node:path";

import { WORKSPACE_CONFIG_DEFAULTS } from "../config/defaults.js";
import { makeRuntimeId } from "../runtime/ids.js";
import { ChokidarWatcherBackend } from "./backends/chokidar.js";
import { NodeFsWatchBackend } from "./backends/node-fs-watch.js";

export const WATCHER_EVENT_TYPES = Object.freeze(["add", "change", "unlink"]);
export const DEFAULT_WATCHER_CONFIG = Object.freeze(
  structuredClone(WORKSPACE_CONFIG_DEFAULTS.sessionHub.watcher),
);

/**
 * @typedef {Object} WatcherBackend
 * @property {string} name
 * @property {(paths: string|string[], options: object) => { close: () => void|Promise<void> }} watch
 */

export class ProjectWorkspaceWatcher {
  constructor({
    workspaceRoot,
    workspace = workspaceRoot,
    runtimeStore = null,
    backend = null,
    config = null,
    watcherConfig = null,
    onEvent = null,
    now = () => new Date().toISOString(),
    makeId = makeRuntimeId,
  } = {}) {
    this.workspace = requiredString(workspace, "ProjectWorkspaceWatcher: workspaceRoot is required");
    this.runtimeStore = runtimeStore;
    this.watcherConfig = resolveWatcherConfig(watcherConfig || config);
    this.backend = assertWatcherBackend(
      backend || createWatcherBackend({ watcherConfig: this.watcherConfig }),
    );
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.now = now;
    this.makeId = makeId;
    this.handles = new Set();
  }

  watchProject(project, { sessions = [], onEvent = null } = {}) {
    const roots = resolveProjectWatchRoots(project, sessions);
    const handles = [];
    for (const repoRoot of roots) {
      const ignored = createIgnoreMatcher(this.watcherConfig.ignore, repoRoot);
      const handle = this.backend.watch(repoRoot, {
        ...watcherBackendOptions(this.watcherConfig),
        ignored,
        onEvent: (backendEvent) => {
          void this.receiveBackendEvent(project, repoRoot, backendEvent, { sessions, onEvent });
        },
      });
      this.handles.add(handle);
      handles.push(handle);
    }
    return handles;
  }

  watchProjects(projects, options = {}) {
    const handles = [];
    for (const project of projects || []) handles.push(...this.watchProject(project, options));
    return handles;
  }

  async receiveBackendEvent(project, repoRoot, backendEvent, { sessions = [], onEvent = null } = {}) {
    const ignored = createIgnoreMatcher(this.watcherConfig.ignore, repoRoot);
    const event = buildRepoChangeEvent({
      project,
      repoRoot,
      backendEvent,
      workspace: this.workspace,
      sessions,
      ignored,
      now: this.now,
      makeId: this.makeId,
    });
    if (!event) return null;
    const sink = typeof onEvent === "function" ? onEvent : this.onEvent;
    if (sink) await sink(event);
    if (this.runtimeStore && typeof this.runtimeStore.append === "function") {
      await this.runtimeStore.append(event);
    }
    return event;
  }

  async close() {
    const handles = Array.from(this.handles);
    this.handles.clear();
    for (const handle of handles) {
      if (handle && typeof handle.close === "function") await handle.close();
    }
  }
}

export function createWatcherBackend({ watcherConfig = null, config = null } = {}) {
  const resolved = resolveWatcherConfig(watcherConfig || config);
  if (resolved.backend === "node_fs_watch") return new NodeFsWatchBackend();
  return new ChokidarWatcherBackend();
}

export function assertWatcherBackend(backend) {
  if (!backend || typeof backend !== "object" || typeof backend.watch !== "function") {
    throw new TypeError("ProjectWorkspaceWatcher requires a WatcherBackend with watch()");
  }
  return backend;
}

export function resolveWatcherConfig(config = null) {
  const direct =
    config && typeof config === "object" && config.sessionHub && config.sessionHub.watcher
      ? config.sessionHub.watcher
      : config && typeof config === "object" && config.watcher
        ? config.watcher
        : config;
  const override = direct && typeof direct === "object" ? direct : {};
  return {
    ...DEFAULT_WATCHER_CONFIG,
    ...override,
    ignore: Array.isArray(override.ignore)
      ? override.ignore.slice()
      : DEFAULT_WATCHER_CONFIG.ignore.slice(),
  };
}

export function watcherBackendOptions(config = null) {
  const resolved = resolveWatcherConfig(config);
  return {
    usePolling: resolved.usePolling,
    atomic: resolved.atomic,
    awaitWriteFinish: resolved.awaitWriteFinish,
  };
}

export function buildRepoChangeEvent({
  project,
  repoRoot,
  backendEvent,
  workspace,
  sessions = [],
  ignored = null,
  now = () => new Date().toISOString(),
  makeId = makeRuntimeId,
} = {}) {
  const event = normalizeWatcherEvent(backendEvent?.event);
  if (!event) return null;
  const path = repoRelativePath(repoRoot, backendEvent.path);
  if (!path) return null;
  if (typeof ignored === "function" && ignored(backendEvent.path)) return null;
  const projectSlug = resolveProjectSlug(project);
  if (!projectSlug) return null;
  const matchingSessions = activeSessionsForRoot(sessions, projectSlug, repoRoot);
  const activeSessionIds = matchingSessions.map((session) => session.id).filter(isNonEmptyString);
  const possibleSessionIds = sessionsForRoot(sessions, projectSlug, repoRoot)
    .map((session) => session.id)
    .filter(isNonEmptyString);
  return {
    schemaVersion: 1,
    id: makeId("evt"),
    ts: now(),
    type: "repo.change",
    source: "watcher",
    workspace: requiredString(workspace, "buildRepoChangeEvent: workspace is required"),
    projectSlug,
    repoRoot: resolve(repoRoot),
    path,
    event,
    activeSessionIds,
    possibleSessionIds,
    attribution: attributionForSessions(matchingSessions),
    relatedTaskIds: relatedTaskIdsForRoot(project, repoRoot),
  };
}

export function normalizeWatcherEvent(event) {
  return WATCHER_EVENT_TYPES.includes(event) ? event : null;
}

export function resolveProjectWatchRoots(project, sessions = []) {
  const roots = [];
  addRoot(roots, project?.cwd);
  addRoot(roots, project?.repoRoot);
  addRoot(roots, project?.root);
  addRoot(roots, project?.projectRoot);
  addRoot(roots, project?.worktreePath);
  addRoot(roots, project?.data?.cwd);
  addRoot(roots, project?.data?.repoRoot);
  addRoot(roots, project?.data?.root);
  addRoot(roots, project?.data?.projectRoot);
  addRoot(roots, project?.data?.worktreePath);
  addRoot(roots, inferLinkedTrackerRepoRoot(project?.file || project?.path));

  for (const task of projectTasks(project)) {
    for (const repo of taskRepos(task)) {
      addRoot(roots, repo.root);
      addRoot(roots, repo.worktree);
      addRoot(roots, repo.worktreePath);
    }
  }
  const projectSlug = resolveProjectSlug(project);
  for (const session of sessions || []) {
    if (projectSlug && session?.projectSlug && session.projectSlug !== projectSlug) continue;
    addRoot(roots, session?.cwd);
    addRoot(roots, session?.repoRoot);
    addRoot(roots, session?.worktreePath);
  }
  return dedupeResolvedRoots(roots);
}

export function createIgnoreMatcher(patterns = DEFAULT_WATCHER_CONFIG.ignore, repoRoot = null) {
  const compiled = (Array.isArray(patterns) ? patterns : []).filter(isNonEmptyString);
  return (filePath) => {
    const rel = repoRoot ? repoRelativePath(repoRoot, filePath) : normalizeSlashes(filePath);
    if (!rel) return false;
    return compiled.some((pattern) => globishMatch(pattern, rel));
  };
}

export function repoRelativePath(repoRoot, filePath) {
  if (!isNonEmptyString(filePath)) return null;
  const normalized =
    isNonEmptyString(repoRoot) && isAbsolute(filePath)
      ? relative(resolve(repoRoot), resolve(filePath))
      : filePath;
  const posixPath = normalizeSlashes(normalized);
  if (!posixPath || posixPath === ".." || posixPath.startsWith("../")) return null;
  return posixPath || ".";
}

function projectTasks(project) {
  if (Array.isArray(project?.tasks)) return project.tasks;
  if (Array.isArray(project?.data?.tasks)) return project.data.tasks;
  return [];
}

function taskRepos(task) {
  const repos = task?.repos;
  if (!repos || typeof repos !== "object") return [];
  return [repos.primary, ...(Array.isArray(repos.secondary) ? repos.secondary : [])].filter(Boolean);
}

function relatedTaskIdsForRoot(project, repoRoot) {
  const ids = [];
  for (const task of projectTasks(project)) {
    if (!isNonEmptyString(task?.id)) continue;
    const matches = taskRepos(task).some((repo) =>
      [repo.root, repo.worktree, repo.worktreePath].some((root) => sameRootOrChild(root, repoRoot)),
    );
    if (matches) ids.push(task.id);
  }
  return ids;
}

function activeSessionsForRoot(sessions, projectSlug, repoRoot) {
  return sessionsForRoot(sessions, projectSlug, repoRoot).filter((session) => !isInactive(session));
}

function sessionsForRoot(sessions, projectSlug, repoRoot) {
  return (sessions || []).filter((session) => {
    if (session?.projectSlug && session.projectSlug !== projectSlug) return false;
    return [session?.cwd, session?.repoRoot, session?.worktreePath].some((root) =>
      sameRootOrChild(root, repoRoot),
    );
  });
}

function attributionForSessions(sessions) {
  if (sessions.length === 0) return "unknown";
  return sessions.length === 1 ? "single_active_session" : "ambiguous";
}

function isInactive(session) {
  return ["done", "stopped", "archived"].includes(session?.status);
}

function resolveProjectSlug(project) {
  return (
    stringOrNull(project?.slug) ||
    stringOrNull(project?.projectSlug) ||
    stringOrNull(project?.data?.slug) ||
    stringOrNull(project?.data?.projectSlug)
  );
}

function inferLinkedTrackerRepoRoot(filePath) {
  if (!isNonEmptyString(filePath) || !isAbsolute(filePath)) return null;
  const posixPath = normalizeSlashes(resolve(filePath));
  for (const marker of ["/.llm-tracker/trackers/", "/.phalanx/"]) {
    const index = posixPath.indexOf(marker);
    if (index > 0) return posixPath.slice(0, index);
  }
  return null;
}

function addRoot(roots, value) {
  if (isNonEmptyString(value)) roots.push(value);
}

function dedupeResolvedRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const resolved = resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function sameRootOrChild(candidate, repoRoot) {
  if (!isNonEmptyString(candidate) || !isNonEmptyString(repoRoot)) return false;
  const left = resolve(candidate);
  const right = resolve(repoRoot);
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function globishMatch(pattern, value) {
  const normalizedPattern = normalizeSlashes(pattern).replace(/^\/+/, "");
  const normalizedValue = normalizeSlashes(value).replace(/^\/+/, "");
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedValue === prefix.slice(0, -1) || normalizedValue.startsWith(prefix);
  }
  const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`);
  return regex.test(normalizedValue);
}

function globToRegExpSource(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function stringOrNull(value) {
  return isNonEmptyString(value) ? value : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function requiredString(value, message) {
  if (!isNonEmptyString(value)) throw new TypeError(message);
  return value;
}
