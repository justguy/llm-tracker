import { join } from "node:path";
import { daemonMetaPath, getDaemonStatus, runtimeDir } from "../hub/runtime.js";
import { listProjectEntries, loadProjectEntry, readWorkspaceHelp } from "../hub/project-loader.js";

const HELP_URI = "tracker://help";
const WORKSPACE_STATUS_URI = "tracker://workspace/status";
const WORKSPACE_RUNTIME_URI = "tracker://workspace/runtime";
const PROJECTS_URI = "tracker://projects";

const READ_TOOL_NAMES = [
  "tracker_help",
  "tracker_projects",
  "tracker_projects_status",
  "tracker_project_status",
  "tracker_next",
  "tracker_brief",
  "tracker_why",
  "tracker_decisions",
  "tracker_execute",
  "tracker_verify",
  "tracker_blockers",
  "tracker_changed",
  "tracker_history"
];

const WRITE_TOOL_NAMES = [
  "tracker_pick",
  "tracker_undo",
  "tracker_redo",
  "tracker_reload"
];

function makeResourceContent(uri, mimeType, text) {
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

function makePrompt(description, text) {
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

function summarizeProject(entry) {
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

function projectStatusPayload(workspace, entry) {
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

function buildProjectStatusUri(slug) {
  return `tracker://projects/${encodeURIComponent(slug)}/status`;
}

function parseProjectStatusUri(uri) {
  const match = uri.match(/^tracker:\/\/projects\/([^/]+)\/status$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function workspaceStatusPayload(workspace) {
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
      readTools: READ_TOOL_NAMES,
      writeTools: WRITE_TOOL_NAMES
    },
    projectCount: projects.length,
    projects
  };
}

function workspaceRuntimePayload(workspace) {
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
        daemon.running || daemon.stale ? "Use hub-backed HTTP or MCP write tools when available." : "Use patch files when the hub is not reachable.",
      patchDirectory: join(workspace, "patches"),
      exampleFilename: "<slug>.<timestamp>.json",
      examplePath: join(workspace, "patches", "<slug>.<timestamp>.json"),
      errorFileRule: "Rejected patch files produce a sibling .errors.json file with structured validation details."
    },
    daemonRule: {
      readToolsRequireDaemon: false,
      writeToolsRequireDaemon: true,
      writeTools: WRITE_TOOL_NAMES
    }
  };
}

export function listResources(workspace) {
  const projects = listProjectEntries(workspace).map(summarizeProject);

  return [
    {
      uri: HELP_URI,
      name: "Workspace Help",
      description: "Full workspace agent contract, including daemon and patch workflow rules.",
      mimeType: "text/markdown"
    },
    {
      uri: WORKSPACE_STATUS_URI,
      name: "Workspace Status",
      description: "Structured workspace, daemon, and project status overview.",
      mimeType: "application/json"
    },
    {
      uri: WORKSPACE_RUNTIME_URI,
      name: "Workspace Runtime",
      description: "Daemon state, MCP daemon rule, and patch-file workflow details.",
      mimeType: "application/json"
    },
    {
      uri: PROJECTS_URI,
      name: "Projects",
      description: "Structured summaries for all known projects in the workspace.",
      mimeType: "application/json"
    },
    ...projects.map((project) => ({
      uri: buildProjectStatusUri(project.slug),
      name: `${project.slug} Status`,
      description: `Structured status for project ${project.slug}.`,
      mimeType: "application/json"
    }))
  ];
}

export function readResource(workspace, uri) {
  switch (uri) {
    case HELP_URI: {
      const help = readWorkspaceHelp(workspace);
      if (!help.ok) {
        throw new Error(`Workspace help is unavailable at ${help.path}: ${help.message}`);
      }
      return makeResourceContent(uri, "text/markdown", help.text);
    }
    case WORKSPACE_STATUS_URI:
      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify(workspaceStatusPayload(workspace), null, 2)
      );
    case WORKSPACE_RUNTIME_URI:
      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify(workspaceRuntimePayload(workspace), null, 2)
      );
    case PROJECTS_URI:
      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify({
          workspace,
          projectCount: listProjectEntries(workspace).length,
          projects: listProjectEntries(workspace).map(summarizeProject)
        }, null, 2)
      );
    default: {
      const slug = parseProjectStatusUri(uri);
      if (!slug) {
        throw new Error(`Unknown resource: ${uri}`);
      }

      const entry = loadProjectEntry(workspace, slug);
      if (!entry.ok) {
        throw new Error(`Failed to load project "${slug}" from ${entry.path}: ${entry.message}`);
      }

      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify(projectStatusPayload(workspace, entry), null, 2)
      );
    }
  }
}

export function listPrompts() {
  return [
    {
      name: "tracker_start_here",
      description: "Load the workspace contract, daemon rule, and patch workflow before acting.",
      arguments: []
    },
    {
      name: "tracker_pick_next",
      description: "Find the next task for a project, then claim it safely.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        }
      ]
    },
    {
      name: "tracker_task_context",
      description: "Load the bounded context for one task without rereading the whole tracker.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        },
        {
          name: "taskId",
          description: "Task id",
          required: true
        }
      ]
    },
    {
      name: "tracker_execute_task",
      description: "Prepare an execution pass for one task with the deterministic pack.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        },
        {
          name: "taskId",
          description: "Task id",
          required: true
        }
      ]
    },
    {
      name: "tracker_verify_task",
      description: "Prepare a verification pass for one task with explicit evidence sources.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        },
        {
          name: "taskId",
          description: "Task id",
          required: true
        }
      ]
    },
    {
      name: "tracker_patch_write",
      description: "Explain the file-based patch workflow when the hub is unavailable.",
      arguments: [
        {
          name: "slug",
          description: "Optional project slug for the example patch filename",
          required: false
        }
      ]
    }
  ];
}

export function getPrompt(workspace, name, args = {}) {
  const slug = typeof args.slug === "string" && args.slug.trim() ? args.slug.trim() : "<slug>";
  const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : "<taskId>";
  const patchExample = join(workspace, "patches", `${slug}.<timestamp>.json`);

  switch (name) {
    case "tracker_start_here":
      return makePrompt(
        "Load the workspace contract and operating rules before touching project state.",
        [
          "Start with the workspace contract before acting.",
          `1. Read resource \`${HELP_URI}\` or call \`tracker_help\`.`,
          `2. Read resource \`${WORKSPACE_RUNTIME_URI}\` for daemon state, patch directory, and MCP write rules.`,
          `3. MCP read tools do not require the daemon. MCP write tools ${WRITE_TOOL_NAMES.map((tool) => `\`${tool}\``).join(", ")} do require the hub or daemon.`,
          `4. If the hub is unavailable, file-mode patches go in \`${join(workspace, "patches")}\` as \`${patchExample}\`. Rejections create a sibling \`.errors.json\` file.`,
          "5. Preferred agent flow: `tracker_projects_status` or `tracker_project_status`, then `tracker_next`, then `tracker_brief` or `tracker_why`, then `tracker_execute`, `tracker_pick`, and `tracker_verify`."
        ].join("\n")
      );
    case "tracker_pick_next":
      return makePrompt(
        `Find the next task for ${slug} and claim it only if a write path is available.`,
        [
          `Use \`tracker_project_status\` for \`${slug}\` if you need a quick progress snapshot.`,
          `Call \`tracker_next\` with \`${slug}\` to get the ranked shortlist.`,
          "Inspect the top recommendation and alternatives before choosing work.",
          `If the task should be claimed and the hub is reachable, call \`tracker_pick\` for \`${slug}\`.`,
          `If the hub is not reachable, do not pretend the claim succeeded. Use a patch file in \`${patchExample}\` instead.`
        ].join("\n")
      );
    case "tracker_task_context":
      return makePrompt(
        `Load bounded task context for ${slug}/${taskId}.`,
        [
          `Call \`tracker_brief\` with slug \`${slug}\` and task id \`${taskId}\`.`,
          `If rationale is unclear, call \`tracker_why\` for \`${slug}\` / \`${taskId}\`.`,
          `If you need recent changes or decision trail, call \`tracker_history\` or \`tracker_changed\` for \`${slug}\`.`,
          "Avoid rereading the whole tracker unless the bounded packs are insufficient."
        ].join("\n")
      );
    case "tracker_execute_task":
      return makePrompt(
        `Prepare to execute ${slug}/${taskId} with deterministic guardrails.`,
        [
          `Call \`tracker_execute\` with slug \`${slug}\` and task id \`${taskId}\`.`,
          `If you have not claimed the task yet and the hub is reachable, use \`tracker_pick\` first.`,
          "Use the execution pack's readiness, constraints, expected changes, and references to plan edits.",
          `After editing, use \`tracker_verify\` for \`${slug}\` / \`${taskId}\` and \`tracker_changed\` to confirm the resulting tracker state.`
        ].join("\n")
      );
    case "tracker_verify_task":
      return makePrompt(
        `Verify completion of ${slug}/${taskId} using tracker evidence.`,
        [
          `Call \`tracker_verify\` with slug \`${slug}\` and task id \`${taskId}\`.`,
          `Use \`tracker_history\` and \`tracker_changed\` for \`${slug}\` if you need revision-backed confirmation.`,
          "If verification fails, explain the missing evidence or unmet checks explicitly instead of marking the task complete."
        ].join("\n")
      );
    case "tracker_patch_write":
      return makePrompt(
        "Use the file-based patch workflow when the hub is unavailable.",
        [
          `Patch files belong in \`${join(workspace, "patches")}\`.`,
          `Use a filename like \`${patchExample}\`.`,
          "Patch mode is for file-based writes; MCP write tools remain hub-backed.",
          "If a patch is rejected, inspect the sibling `.errors.json` file for the structured validation error.",
          "Once the hub is reachable again, prefer MCP or HTTP writes so locking, revisioning, and broadcasts stay authoritative."
        ].join("\n")
      );
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
