import { listProjectEntries } from "./project-loader.js";

const EXTERNAL_DELIMITER = ":";

export function parseDependencyRef(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const colonIdx = trimmed.indexOf(EXTERNAL_DELIMITER);
  if (colonIdx === -1) {
    return { kind: "local", taskId: trimmed, raw: trimmed };
  }
  const slug = trimmed.slice(0, colonIdx).trim();
  const taskId = trimmed.slice(colonIdx + 1).trim();
  if (!slug || !taskId) return null;
  return { kind: "external", slug, taskId, raw: trimmed };
}

export function isExternalDependencyRef(value) {
  const parsed = parseDependencyRef(value);
  return parsed?.kind === "external";
}

// Build a lookup function `(slug, taskId) => { exists, status, title }` over
// the projects loaded in `entries`. Each entry is the shape returned by
// `loadProjectEntry` / `listProjectEntries`.
export function buildLookupFromEntries(entries = []) {
  const projectsBySlug = new Map();
  for (const entry of entries) {
    if (!entry?.ok || !entry.slug || !entry.data) continue;
    const taskMap = new Map();
    for (const task of entry.data.tasks || []) {
      if (task && typeof task.id === "string") taskMap.set(task.id, task);
    }
    projectsBySlug.set(entry.slug, taskMap);
  }
  return (slug, taskId) => {
    const tasks = projectsBySlug.get(slug);
    if (!tasks) return { exists: false, status: null, title: null };
    const task = tasks.get(taskId);
    if (!task) return { exists: false, status: null, title: null };
    return {
      exists: true,
      status: task.status || null,
      title: task.title || null
    };
  };
}

// Build a lookup that reads other projects from the workspace lazily, and
// caches them for the duration of a single payload build. The optional
// `selfSlug` skips re-reading the project we are already analyzing.
export function buildWorkspaceLookup(workspace, { selfSlug = null, selfData = null } = {}) {
  if (!workspace) {
    return () => ({ exists: false, status: null, title: null });
  }
  let cache = null;
  return (slug, taskId) => {
    if (!slug || !taskId) return { exists: false, status: null, title: null };
    if (slug === selfSlug && selfData) {
      const task = (selfData.tasks || []).find((t) => t?.id === taskId);
      if (!task) return { exists: false, status: null, title: null };
      return {
        exists: true,
        status: task.status || null,
        title: task.title || null
      };
    }
    if (!cache) {
      cache = buildLookupFromEntries(listProjectEntries(workspace));
    }
    return cache(slug, taskId);
  };
}

// Build a lookup that consults a running Store first (in-memory authoritative
// state), so HTTP/WebSocket-driven readers do not need to re-read tracker
// files from disk.
export function buildStoreLookup(store) {
  if (!store || typeof store.list !== "function" || typeof store.get !== "function") {
    return () => ({ exists: false, status: null, title: null });
  }
  return (slug, taskId) => {
    if (!slug || !taskId) return { exists: false, status: null, title: null };
    const entry = store.get(slug);
    if (!entry?.data) return { exists: false, status: null, title: null };
    const task = (entry.data.tasks || []).find((t) => t?.id === taskId);
    if (!task) return { exists: false, status: null, title: null };
    return {
      exists: true,
      status: task.status || null,
      title: task.title || null
    };
  };
}
