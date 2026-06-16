import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  renameSync,
  statSync,
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
  let target = file;
  try {
    const l = lstatSync(file);
    if (l.isSymbolicLink()) target = realpathSync(file);
  } catch {}
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, target);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

function overlayFileIsStaleComparedToTarget(workspace, slug, trackerPath) {
  const overlayFile = runtimeOverlayPath(workspace, slug);
  if (!existsSync(overlayFile)) return false;
  try {
    const targetFile = durableWritePath(trackerPath, true);
    return statSync(targetFile).mtimeMs > statSync(overlayFile).mtimeMs;
  } catch {
    return false;
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

function applyChangedBaseRuntimeFields(baseProject, overlayAppliedProject, previousBaseProject) {
  const data = clone(overlayAppliedProject);
  if (!previousBaseProject || !data) return data;

  if (data.meta && baseProject?.meta && previousBaseProject?.meta) {
    for (const field of META_RUNTIME_FIELDS) {
      if (sameValue(baseProject.meta[field], previousBaseProject.meta[field])) continue;
      if (field in baseProject.meta) {
        data.meta[field] = clone(baseProject.meta[field]);
      } else {
        delete data.meta[field];
      }
    }
  }

  if (Array.isArray(data.tasks) && Array.isArray(baseProject?.tasks) && Array.isArray(previousBaseProject?.tasks)) {
    const baseById = new Map(baseProject.tasks.map((task) => [task.id, task]));
    const previousById = new Map(previousBaseProject.tasks.map((task) => [task.id, task]));
    data.tasks = data.tasks.map((task) => {
      const baseTask = baseById.get(task.id);
      const previousTask = previousById.get(task.id);
      if (!baseTask || !previousTask) return task;
      const next = { ...task };
      for (const field of TASK_RUNTIME_FIELDS) {
        if (sameValue(baseTask[field], previousTask[field])) continue;
        if (field in baseTask) {
          next[field] = clone(baseTask[field]);
        } else {
          delete next[field];
        }
      }
      return next;
    });
  }

  return data;
}

export function loadProjectWithRuntimeOverlay({
  workspace,
  slug,
  trackerPath,
  baseProject,
  previousBaseProject = null,
  migrateLegacyOverlay = false
}) {
  const base = clone(baseProject);
  const overlayBacked = isOverlayBackedTracker(trackerPath);
  if (!overlayBacked || !migrateLegacyOverlay) {
    return { base, data: clone(baseProject), overlayEnabled: false };
  }
  const overlay = readRuntimeOverlay(workspace, slug);
  if (!overlay) {
    return { base, data: clone(baseProject), overlayEnabled: false };
  }
  if (overlayFileIsStaleComparedToTarget(workspace, slug, trackerPath)) {
    return {
      base,
      data: clone(baseProject),
      overlayEnabled: false,
      legacyOverlayIgnored: true
    };
  }
  const overlaid = applyRuntimeOverlay(baseProject, overlay);
  return {
    base: clone(overlaid),
    data: previousBaseProject
      ? applyChangedBaseRuntimeFields(baseProject, overlaid, previousBaseProject)
      : overlaid,
    overlayEnabled: false,
    legacyOverlayMigrated: true
  };
}

export function persistProjectWithRuntimeOverlay({
  workspace,
  slug,
  trackerPath,
  baseProject,
  effectiveProject,
  overlayEnabled
}) {
  atomicWriteJson(durableWritePath(trackerPath, overlayEnabled), effectiveProject);
  clearRuntimeOverlay(workspace, slug);
  return {
    base: clone(effectiveProject),
    overlayEnabled: false
  };
}
