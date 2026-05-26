import { join } from "node:path";
import { daemonMetaPath, getDaemonStatus, runtimeDir } from "../hub/runtime.js";
import { listProjectEntries } from "../hub/project-loader.js";

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
  "tracker_history"
];

export const JOB_MUTATION_TOOL_NAMES = [
  "tracker_job_start",
  "tracker_job_checkpoint",
  "tracker_job_complete",
  "tracker_job_rollover",
  "tracker_job_unblock",
  "tracker_job_verify_run",
  "tracker_job_verify_resolve"
];

export const SESSION_BOOTSTRAP_TOOL_NAMES = [
  "tracker_session_start"
];

export const SESSION_TOKEN_MUTATION_TOOL_NAMES = [
  "tracker_session_heartbeat",
  "tracker_session_status",
  "tracker_session_note",
  "tracker_session_blocked",
  "tracker_session_unblocked",
  "tracker_session_handoff",
  "tracker_session_context_usage",
  "tracker_session_complete",
  "tracker_session_broadcast",
  "tracker_session_ask"
];

export const JOB_TOOL_NAMES = [
  ...JOB_MUTATION_TOOL_NAMES,
  "tracker_job_status",
  "tracker_job_context_pack",
  "tracker_job_skill_plan",
  "tracker_job_verify_pack"
];

export const SKILL_MUTATION_TOOL_NAMES = [
  "tracker_skill_run_start",
  "tracker_skill_run_complete",
  "tracker_skill_run_skip",
  "tracker_skill_run_fail"
];

export const SKILL_TOOL_NAMES = [
  "tracker_skills_list",
  "tracker_job_profiles",
  ...SKILL_MUTATION_TOOL_NAMES
];

export const WRITE_TOOL_NAMES = [
  "tracker_patch",
  "tracker_pick",
  "tracker_undo",
  "tracker_redo",
  "tracker_reload",
  ...SESSION_BOOTSTRAP_TOOL_NAMES,
  ...SESSION_TOKEN_MUTATION_TOOL_NAMES,
  ...JOB_MUTATION_TOOL_NAMES,
  ...SKILL_MUTATION_TOOL_NAMES
];

export const SESSION_TOKEN_REQUIRED_TOOL_NAMES = [
  ...SESSION_TOKEN_MUTATION_TOOL_NAMES,
  ...JOB_MUTATION_TOOL_NAMES,
  ...SKILL_MUTATION_TOOL_NAMES
];

export const WORKSPACE_WRITE_TOOL_NAMES = [
  "tracker_patch",
  "tracker_pick",
  "tracker_undo",
  "tracker_redo",
  "tracker_reload"
];

export const SESSION_TOOL_NAMES = [
  ...SESSION_BOOTSTRAP_TOOL_NAMES,
  ...SESSION_TOKEN_MUTATION_TOOL_NAMES,
  "tracker_session_list",
  "tracker_session_context"
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

export function summarizeProject(entry) {
  if (!entry.ok) {
    return {
      slug: entry.slug,
      ok: false,
      path: entry.path,
      error: entry.message
    };
  }

  return {
    slug: entry.slug,
    ok: true,
    path: entry.path,
    name: entry.data?.meta?.name || null,
    rev: entry.rev,
    total: entry.derived?.total ?? 0,
    pct: entry.derived?.pct ?? 0,
    counts: entry.derived?.counts || {},
    blockedCount: Object.keys(entry.derived?.blocked || {}).length
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

  return {
    workspace,
    project: {
      slug: entry.slug,
      name: entry.data?.meta?.name || null,
      path: entry.path,
      rev: entry.rev,
      total: entry.derived?.total ?? 0,
      pct: entry.derived?.pct ?? 0,
      counts: entry.derived?.counts || {},
      blocked: entry.derived?.blocked || {},
      perSwimlane: entry.derived?.perSwimlane || {},
      scratchpad: entry.data?.meta?.scratchpad || "",
      updatedAt: entry.data?.meta?.updatedAt || null
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
  const projects = listProjectEntries(workspace).map(summarizeProject);
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
      jobToolsRequireDaemon: true,
      skillToolsRequireDaemon: true,
      readTools: READ_TOOL_NAMES,
      writeTools: WRITE_TOOL_NAMES,
      workspaceWriteTools: WORKSPACE_WRITE_TOOL_NAMES,
      sessionBootstrapTools: SESSION_BOOTSTRAP_TOOL_NAMES,
      sessionTokenMutationTools: SESSION_TOKEN_MUTATION_TOOL_NAMES,
      sessionTokenRequiredTools: SESSION_TOKEN_REQUIRED_TOOL_NAMES,
      sessionTools: SESSION_TOOL_NAMES,
      jobTools: JOB_TOOL_NAMES,
      skillTools: SKILL_TOOL_NAMES
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
      jobToolsRequireDaemon: true,
      skillToolsRequireDaemon: true,
      writeTools: WRITE_TOOL_NAMES,
      workspaceWriteTools: WORKSPACE_WRITE_TOOL_NAMES,
      sessionBootstrapTools: SESSION_BOOTSTRAP_TOOL_NAMES,
      sessionTokenMutationTools: SESSION_TOKEN_MUTATION_TOOL_NAMES,
      sessionTokenRequiredTools: SESSION_TOKEN_REQUIRED_TOOL_NAMES,
      sessionTools: SESSION_TOOL_NAMES,
      jobTools: JOB_TOOL_NAMES,
      skillTools: SKILL_TOOL_NAMES
    }
  };
}
