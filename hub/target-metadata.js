import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getDaemonStatus } from "./runtime.js";

export function isLinkedTrackerPath(filePath) {
  if (!filePath) return false;
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function targetMetadata(workspace, slug, entry = null, { port = undefined } = {}) {
  const registrationFile = entry?.path || (workspace ? join(workspace, "trackers", `${slug}.json`) : null);
  let file = registrationFile;
  if (file) {
    try {
      file = realpathSync(file);
    } catch {}
  }

  const daemonPort = port === undefined && workspace ? (getDaemonStatus(workspace).meta?.port ?? null) : (port ?? null);
  const topology =
    registrationFile && isLinkedTrackerPath(registrationFile) ? "repo-linked" : "shared-workspace";

  return {
    workspace,
    port: daemonPort,
    file: file || null,
    registrationFile: registrationFile || null,
    topology
  };
}
