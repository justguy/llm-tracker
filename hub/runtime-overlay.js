import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { runtimeDir } from "./runtime.js";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function runtimeOverlayPath(workspace, slug) {
  return join(runtimeDir(workspace), "overlays", `${slug}.json`);
}

function isLinkedTrackerPath(trackerPath) {
  try {
    return lstatSync(trackerPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function durableWritePath(trackerPath) {
  try {
    return isLinkedTrackerPath(trackerPath) ? realpathSync(trackerPath) : trackerPath;
  } catch {
    return trackerPath;
  }
}

export function clearRuntimeOverlay(workspace, slug) {
  const file = runtimeOverlayPath(workspace, slug);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {}
}

export function loadProjectWithRuntimeOverlay({
  workspace,
  slug,
  trackerPath,
  baseProject
}) {
  const base = clone(baseProject);
  return {
    base,
    data: clone(baseProject),
    overlayEnabled: false,
    legacyOverlayPresent: isLinkedTrackerPath(trackerPath) && existsSync(runtimeOverlayPath(workspace, slug))
  };
}

export function persistProjectWithRuntimeOverlay({
  workspace,
  slug,
  trackerPath,
  effectiveProject
}) {
  atomicWriteJson(durableWritePath(trackerPath), effectiveProject);
  clearRuntimeOverlay(workspace, slug);
  return {
    base: clone(effectiveProject),
    overlayEnabled: false
  };
}
