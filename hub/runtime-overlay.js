import {
  existsSync,
  lstatSync,
  mkdirSync,
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
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

function applyBaseRuntimeOverrides(baseProject, overlayAppliedProject, overlay) {
  const data = clone(overlayAppliedProject);
  if (!overlay || !data) return data;

  if (data.meta && baseProject?.meta) {
    for (const field of META_RUNTIME_FIELDS) {
      const baseHas = field in baseProject.meta;
      const overlayHas = !!overlay.meta && field in overlay.meta;
      if (!overlayHas) continue;
      if (baseHas && !sameValue(baseProject.meta[field], overlay.meta[field])) {
        data.meta[field] = clone(baseProject.meta[field]);
      } else if (!baseHas) {
        delete data.meta[field];
      }
    }
  }

  if (Array.isArray(data.tasks) && Array.isArray(baseProject?.tasks)) {
    const baseById = new Map(baseProject.tasks.map((task) => [task.id, task]));
    data.tasks = data.tasks.map((task) => {
      const baseTask = baseById.get(task.id);
      const overlayTask = overlay.tasks?.[task.id];
      if (!baseTask || !overlayTask) return task;
      const next = { ...task };
      for (const field of TASK_RUNTIME_FIELDS) {
        const baseHas = field in baseTask;
        const overlayHas = field in overlayTask;
        if (!overlayHas) continue;
        if (baseHas && !sameValue(baseTask[field], overlayTask[field])) {
          next[field] = clone(baseTask[field]);
        } else if (!baseHas) {
          delete next[field];
        }
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
  previousBaseProject = null
}) {
  const overlayEnabled = isOverlayBackedTracker(trackerPath);
  const base = clone(baseProject);
  if (!overlayEnabled) {
    return { base, data: clone(baseProject), overlayEnabled };
  }
  const overlay = readRuntimeOverlay(workspace, slug);
  const preferBaseRuntime = overlayFileIsStaleComparedToTarget(workspace, slug, trackerPath);
  const overlaid = applyRuntimeOverlay(baseProject, overlay);
  return {
    base,
    data: previousBaseProject
      ? applyChangedBaseRuntimeFields(baseProject, overlaid, previousBaseProject)
      : preferBaseRuntime
        ? applyBaseRuntimeOverrides(baseProject, overlaid, overlay)
        : overlaid,
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
