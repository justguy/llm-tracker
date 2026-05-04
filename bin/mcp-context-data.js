import { join } from "node:path";
import { daemonMetaPath, getDaemonStatus, runtimeDir } from "../hub/runtime.js";
import { listProjectEntries } from "../hub/project-loader.js";
import { targetMetadata } from "../hub/target-metadata.js";

export const HELP_URI = "tracker://help";
export const WORKSPACE_STATUS_URI = "tracker://workspace/status";
export const WORKSPACE_RUNTIME_URI = "tracker://workspace/runtime";
export const PROJECTS_URI = "tracker://projects";

export const READ_TOOL_NAMES = [
  "tracker_help",
  "tracker_projects",
  "tracker_projects_status",
  "tracker_project_status",
  "tracker_next",
  "tracker_search",
  "tracker_fuzzy_search",
  "tracker_brief",
  "tracker_why",
  "tracker_decisions",
  "tracker_execute",
  "tracker_verify",
  "tracker_blockers",
  "tracker_changed",
  "tracker_handoff",
  "tracker_history",
  "tracker_hygiene"
];

export const WRITE_TOOL_NAMES = [
  "tracker_patch",
  "tracker_create_swimlane",
  "tracker_update_swimlane",
  "tracker_move_swimlane",
  "tracker_delete_swimlane",
  "tracker_start",
  "tracker_pick",
  "tracker_undo",
  "tracker_redo",
  "tracker_reload"
];

export function makeResourceContent(uri, mimeType, text) {
  return {
    contents: [
      {
        uri,
        mimeType,
        text
      }
    ]
  };
}

export function makePrompt(description, text) {
  return {
    description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text
        }
      }
    ]
  };
}

export function summarizeProject(entry, workspace = null) {
  if (!entry.ok) {
    return {
      slug: entry.slug,
      ok: false,
      path: entry.path,
      error: entry.message
    };
  }

  const target = targetMetadata(workspace, entry.slug, entry);
  return {
    slug: entry.slug,
    ok: true,
    path: entry.path,
    ...target,
    name: entry.data?.meta?.name || null,
    rev: entry.rev,
    total: entry.derived?.total ?? 0,
    pct: entry.derived?.pct ?? 0,
    counts: entry.derived?.counts || {},
    actionability: entry.derived?.actionability || {},
    blockedCount: Object.keys(entry.derived?.blocked || {}).length,
    ...(entry.warning ? { warning: entry.warning } : {})
  };
}

export function projectStatusPayload(workspace, entry) {
  if (!entry.ok) {
    return {
      workspace,
      slug: entry.slug,
      ok: false,
      path: entry.path,
      error: entry.message
    };
  }

  const target = targetMetadata(workspace, entry.slug, entry);
  return {
    workspace,
    ...(entry.warning ? { warning: entry.warning } : {}),
    ...target,
    project: {
      slug: entry.slug,
      name: entry.data?.meta?.name || null,
      path: entry.path,
      ...target,
      target,
      rev: entry.rev,
      total: entry.derived?.total ?? 0,
      pct: entry.derived?.pct ?? 0,
      counts: entry.derived?.counts || {},
      actionability: entry.derived?.actionability || {},
      blocked: entry.derived?.blocked || {},
      perSwimlane: entry.derived?.perSwimlane || {},
      scratchpad: entry.data?.meta?.scratchpad || "",
      updatedAt: entry.data?.meta?.updatedAt || null,
      ...(entry.warning ? { warning: entry.warning } : {})
    }
  };
}

export function buildProjectStatusUri(slug) {
  return `tracker://projects/${encodeURIComponent(slug)}/status`;
}

export function parseProjectStatusUri(uri) {
  const match = uri.match(/^tracker:\/\/projects\/([^/]+)\/status$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function workspaceStatusPayload(workspace) {
  const projects = listProjectEntries(workspace).map((entry) => summarizeProject(entry, workspace));
  const daemon = getDaemonStatus(workspace);

  return {
    workspace,
    trackerDir: join(workspace, "trackers"),
    patchesDir: join(workspace, "patches"),
    runtimeDir: runtimeDir(workspace),
    daemon: {
      running: daemon.running,
      stale: daemon.stale,
      pid: daemon.meta?.pid ?? null,
      port: daemon.meta?.port ?? null,
      metaFile: daemonMetaPath(workspace),
      logFile: daemon.logFile
    },
    mcp: {
      readToolsRequireDaemon: false,
      writeToolsRequireDaemon: true,
      readTools: READ_TOOL_NAMES,
      writeTools: WRITE_TOOL_NAMES
    },
    projectCount: projects.length,
    projects
  };
}

export function workspaceRuntimePayload(workspace) {
  const daemon = getDaemonStatus(workspace);

  return {
    workspace,
    trackersDir: join(workspace, "trackers"),
    patchesDir: join(workspace, "patches"),
    runtimeDir: runtimeDir(workspace),
    daemonMetaPath: daemonMetaPath(workspace),
    daemonLogPath: daemon.logFile,
    daemon: {
      running: daemon.running,
      stale: daemon.stale,
      pid: daemon.meta?.pid ?? null,
      port: daemon.meta?.port ?? null
    },
    patchWorkflow: {
      preferredWritePath:
        daemon.running || daemon.stale
          ? "Use hub-backed HTTP or MCP write tools when available."
          : "Use patch files when the hub is not reachable.",
      patchDirectory: join(workspace, "patches"),
      exampleFilename: "<slug>.<timestamp>.json",
      examplePath: join(workspace, "patches", "<slug>.<timestamp>.json"),
      errorFileRule:
        "Rejected patch files produce a sibling .errors.json file with structured validation details."
    },
    daemonRule: {
      readToolsRequireDaemon: false,
      writeToolsRequireDaemon: true,
      writeTools: WRITE_TOOL_NAMES
    }
  };
}
