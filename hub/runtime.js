import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

export function runtimeDir(workspace) {
  return join(workspace, ".runtime");
}

export function ensureRuntimeDir(workspace) {
  const dir = runtimeDir(workspace);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function daemonMetaPath(workspace) {
  return join(runtimeDir(workspace), "daemon.json");
}

export function daemonLogPath(workspace) {
  return join(runtimeDir(workspace), "daemon.log");
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function readDaemonMeta(workspace) {
  const file = daemonMetaPath(workspace);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function writeDaemonMeta(workspace, meta) {
  ensureRuntimeDir(workspace);
  atomicWriteJson(daemonMetaPath(workspace), meta);
}

export function removeDaemonMeta(workspace) {
  const file = daemonMetaPath(workspace);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {}
}

export function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

export function getDaemonStatus(workspace) {
  const meta = readDaemonMeta(workspace);
  const logFile = meta?.logFile || daemonLogPath(workspace);
  if (!meta) {
    return { running: false, stale: false, meta: null, logFile };
  }
  const running = isPidRunning(meta.pid);
  return {
    running,
    stale: !running,
    meta,
    logFile
  };
}
