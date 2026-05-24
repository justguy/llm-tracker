// hub/runtime/paths.js — Session Hub Phase 1 (TDD v0.5 §5.1, §23.2 #11, #13)
//
// Derives all `.runtime/*` file paths from a workspace root. Pure path math,
// no fs I/O: callers (RuntimeStore, snapshot writers, layout module) own
// directory creation and atomic-write semantics.

import path from "node:path";

/**
 * @typedef {Object} RuntimePaths
 * @property {string} runtimeDir          `<workspaceRoot>/.runtime`
 * @property {string} runtimeEvents       runtime-events JSONL
 * @property {string} repoEvents          repo-events JSONL
 * @property {string} sessionsSnapshot    sessions snapshot JSON
 * @property {string} jobsSnapshot        jobs snapshot JSON
 * @property {string} skillRunsSnapshot   skill-runs snapshot JSON
 * @property {string} sessionStdioDir     stdio capture directory
 * @property {string} layoutsDir          layouts directory
 * @property {string} sessionHubLayout    session-hub layout JSON
 */

/**
 * @param {{ workspaceRoot: string }} opts
 * @returns {RuntimePaths}
 */
export function makePaths({ workspaceRoot } = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError("makePaths: workspaceRoot must be a non-empty string");
  }
  if (!path.isAbsolute(workspaceRoot)) {
    throw new TypeError(
      `makePaths: workspaceRoot must be absolute, got ${JSON.stringify(workspaceRoot)}`,
    );
  }
  const runtimeDir = path.join(workspaceRoot, ".runtime");
  const layoutsDir = path.join(runtimeDir, "layouts");
  return Object.freeze({
    runtimeDir,
    runtimeEvents: path.join(runtimeDir, "runtime-events.jsonl"),
    repoEvents: path.join(runtimeDir, "repo-events.jsonl"),
    sessionsSnapshot: path.join(runtimeDir, "sessions.snapshot.json"),
    jobsSnapshot: path.join(runtimeDir, "jobs.snapshot.json"),
    skillRunsSnapshot: path.join(runtimeDir, "skill-runs.snapshot.json"),
    sessionStdioDir: path.join(runtimeDir, "session-stdio"),
    layoutsDir,
    sessionHubLayout: path.join(layoutsDir, "session-hub.json"),
  });
}
