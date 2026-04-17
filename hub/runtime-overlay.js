import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { runtimeDir } from "./runtime.js";

const META_RUNTIME_FIELDS = ["scratchpad", "updatedAt", "rev"];
const TASK_RUNTIME_FIELDS = ["status", "assignee", "blocker_reason", "updatedAt", "rev"];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function ensureOverlayDir(workspace) {
  const dir = join(runtimeDir(workspace), "overlays");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function taskRuntimeState(task) {
  const out = {};
  for (const field of TASK_RUNTIME_FIELDS) {
    if (field in task) out[field] = clone(task[field]);
  }
  return out;
}

export function runtimeOverlayPath(workspace, slug) {
  return join(runtimeDir(workspace), "overlays", `${slug}.json`);
}

export function isOverlayBackedTracker(trackerPath) {
  try {
    return lstatSync(trackerPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function durableWritePath(trackerPath, overlayEnabled) {
  if (!overlayEnabled) return trackerPath;
  try {
    return realpathSync(trackerPath);
  } catch {
    return trackerPath;
  }
}

export function readRuntimeOverlay(workspace, slug) {
  const file = runtimeOverlayPath(workspace, slug);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function clearRuntimeOverlay(workspace, slug) {
  const file = runtimeOverlayPath(workspace, slug);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {}
}

export function applyRuntimeOverlay(baseProject, overlay) {
  const data = clone(baseProject);
  if (!overlay || !data) return data;

  if (overlay.meta && data.meta) {
    for (const field of META_RUNTIME_FIELDS) {
      if (field in overlay.meta) data.meta[field] = clone(overlay.meta[field]);
    }
  }

  if (overlay.tasks && Array.isArray(data.tasks)) {
    const overlayTasks = overlay.tasks || {};
    data.tasks = data.tasks.map((task) => {
      const runtime = overlayTasks[task.id];
      if (!runtime) return task;
      const next = { ...task };
      for (const field of TASK_RUNTIME_FIELDS) {
        if (field in runtime) next[field] = clone(runtime[field]);
      }
      return next;
    });
  }

  return data;
}

export function loadProjectWithRuntimeOverlay({ workspace, slug, trackerPath, baseProject }) {
  const overlayEnabled = isOverlayBackedTracker(trackerPath);
  const base = clone(baseProject);
  if (!overlayEnabled) {
    return { base, data: clone(baseProject), overlayEnabled };
  }
  return {
    base,
    data: applyRuntimeOverlay(baseProject, readRuntimeOverlay(workspace, slug)),
    overlayEnabled
  };
}

export function splitRuntimeOverlay(baseProject, effectiveProject) {
  const previousBase = clone(baseProject) || clone(effectiveProject);
  const base = clone(previousBase);
  const overlay = { meta: {}, tasks: {} };

  if (effectiveProject?.meta) {
    base.meta = base.meta || {};
    for (const [key, value] of Object.entries(effectiveProject.meta)) {
      if (META_RUNTIME_FIELDS.includes(key)) {
        overlay.meta[key] = clone(value);
        continue;
      }
      base.meta[key] = clone(value);
    }
    for (const field of META_RUNTIME_FIELDS) {
      if (previousBase?.meta && field in previousBase.meta) {
        base.meta[field] = clone(previousBase.meta[field]);
      }
    }
  }

  const baseById = new Map((previousBase?.tasks || []).map((task) => [task.id, task]));
  base.tasks = (effectiveProject?.tasks || []).map((task) => {
    const previousTask = baseById.get(task.id);
    const nextTask = clone(previousTask) || clone(task);
    for (const [key, value] of Object.entries(task)) {
      if (TASK_RUNTIME_FIELDS.includes(key)) continue;
      nextTask[key] = clone(value);
    }
    overlay.tasks[task.id] = taskRuntimeState(task);
    return nextTask;
  });

  return { base, overlay };
}

export function persistProjectWithRuntimeOverlay({
  workspace,
  slug,
  trackerPath,
  baseProject,
  effectiveProject,
  overlayEnabled
}) {
  if (!overlayEnabled) {
    atomicWriteJson(trackerPath, effectiveProject);
    clearRuntimeOverlay(workspace, slug);
    return {
      base: clone(effectiveProject),
      overlayEnabled: false
    };
  }

  const { base, overlay } = splitRuntimeOverlay(baseProject, effectiveProject);
  atomicWriteJson(durableWritePath(trackerPath, true), base);
  ensureOverlayDir(workspace);
  atomicWriteJson(runtimeOverlayPath(workspace, slug), overlay);
  return {
    base,
    overlayEnabled: true
  };
}
