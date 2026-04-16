import { createRequire } from "node:module";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { getPrompt, listPrompts, listResources, readResource } from "./mcp-context.js";
import { httpRequest, resolveWorkspace } from "./workspace-client.js";
import { getBlockersPayload } from "../hub/blockers.js";
import { getBriefPayload } from "../hub/briefs.js";
import { getChangedPayload } from "../hub/changed.js";
import { getDecisionsPayload } from "../hub/decisions.js";
import { getExecutePayload } from "../hub/execute.js";
import { getNextPayload } from "../hub/next.js";
import { listProjectEntries, loadProjectEntry, readWorkspaceHelp } from "../hub/project-loader.js";
import { readHistory } from "../hub/snapshots.js";
import { getVerifyPayload } from "../hub/verify.js";
import { getWhyPayload } from "../hub/why.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

let searchModulePromise = null;
const MCP_DEBUG_LOG = process.env.LLM_TRACKER_MCP_DEBUG_LOG || "/tmp/llm-tracker-mcp-debug.log";

function clampInt(value, { fallback, min, max }) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function makeTextResult(text, { isError = false } = {}) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    isError
  };
}

function makeJsonResult(value, { isError = false } = {}) {
  return makeTextResult(JSON.stringify(value, null, 2), { isError });
}

function loadReadableEntry(workspace, slug) {
  const entry = loadProjectEntry(workspace, slug);
  if (!entry.ok) {
    return {
      ok: false,
      result: makeTextResult(
        `Failed to load project "${slug}" from ${entry.path}: ${entry.message}`,
        { isError: true }
      )
    };
  }
  return { ok: true, entry };
}

async function readToolPayload(getter, workspace, slug, extra = {}) {
  const loaded = loadReadableEntry(workspace, slug);
  if (!loaded.ok) return loaded.result;

  const payload = await getter({
    workspace,
    slug,
    entry: loaded.entry,
    ...extra
  });

  if (payload?.ok === false) {
    return makeTextResult(
      payload.message || `${slug}: request failed`,
      { isError: true }
    );
  }
  if (!payload) {
    return makeTextResult(`Project "${slug}" is not available.`, { isError: true });
  }

  return makeJsonResult(payload.payload || payload);
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

function debugLog(line) {
  if (!MCP_DEBUG_LOG) return;
  try {
    appendFileSync(MCP_DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Debug logging must never interfere with MCP stdio behavior.
  }
}

async function loadSearchModule() {
  if (!searchModulePromise) {
    searchModulePromise = import("../hub/search.js");
  }
  return searchModulePromise;
}

async function getSearchToolPayload(...args) {
  const module = await loadSearchModule();
  return module.getSearchPayload(...args);
}

async function getFuzzySearchToolPayload(...args) {
  const module = await loadSearchModule();
  return module.getFuzzyPayload(...args);
}

function createTools(workspace, portFlag) {
  const tools = [
    {
      name: "tracker_help",
      description: "Read the workspace agent contract served by /help.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const help = readWorkspaceHelp(workspace);
        if (!help.ok) {
          return makeTextResult(
            `Workspace help is unavailable at ${help.path}: ${help.message}`,
            { isError: true }
          );
        }
        return makeTextResult(help.text);
      }
    },
    {
      name: "tracker_projects",
      description: "List projects available in the configured llm-tracker workspace.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const projects = listProjectEntries(workspace).map(summarizeProject);
        return makeJsonResult({
          workspace,
          projectCount: projects.length,
          projects
        });
      }
    },
    {
      name: "tracker_projects_status",
      description: "Return overall status for all projects in the configured workspace.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const projects = listProjectEntries(workspace).map(summarizeProject);
        return makeJsonResult({
          workspace,
          projectCount: projects.length,
          projects
        });
      }
    },
    {
      name: "tracker_project_status",
      description: "Return status for one project: totals, progress, blocked map, swimlane breakdown, and scratchpad.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const loaded = loadReadableEntry(workspace, slug);
        if (!loaded.ok) return loaded.result;
        return makeJsonResult(projectStatusPayload(workspace, loaded.entry));
      }
    },
    {
      name: "tracker_next",
      description: "Return the ranked next-task shortlist for one project.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          limit: { type: "integer", minimum: 1, maximum: 5 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(
          getNextPayload,
          workspace,
          nonEmptyString(args.slug),
          { limit: clampInt(args.limit, { fallback: 5, min: 1, max: 5 }) }
        )
    },
    {
      name: "tracker_search",
      description: "Search tasks semantically with local embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["slug", "query"]
      },
      handler: async (args = {}) =>
        readToolPayload(getSearchToolPayload, workspace, nonEmptyString(args.slug), {
          query: nonEmptyString(args.query),
          limit: clampInt(args.limit, { fallback: 10, min: 1, max: 50 })
        })
    },
    {
      name: "tracker_fuzzy_search",
      description: "Search tasks with deterministic fuzzy lexical matching.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["slug", "query"]
      },
      handler: async (args = {}) =>
        readToolPayload(getFuzzySearchToolPayload, workspace, nonEmptyString(args.slug), {
          query: nonEmptyString(args.query),
          limit: clampInt(args.limit, { fallback: 10, min: 1, max: 50 })
        })
    },
    {
      name: "tracker_brief",
      description: "Return the bounded task brief pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getBriefPayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_why",
      description: "Return the deterministic why pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getWhyPayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_decisions",
      description: "Return recent project decisions derived from task comments.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          limit: { type: "integer", minimum: 1, maximum: 20 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getDecisionsPayload, workspace, nonEmptyString(args.slug), {
          limit: clampInt(args.limit, { fallback: 20, min: 1, max: 20 })
        })
    },
    {
      name: "tracker_execute",
      description: "Return the deterministic execution pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getExecutePayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_verify",
      description: "Return the deterministic verification pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getVerifyPayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_blockers",
      description: "Return blocked tasks and the tasks currently blocking others.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getBlockersPayload, workspace, nonEmptyString(args.slug))
    },
    {
      name: "tracker_changed",
      description: "Return changed tasks since a given revision.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          fromRev: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getChangedPayload, workspace, nonEmptyString(args.slug), {
          fromRev: clampInt(args.fromRev, { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
          limit: clampInt(args.limit, { fallback: 20, min: 1, max: 50 })
        })
    },
    {
      name: "tracker_history",
      description: "Return recent project history entries from the append-only revision log.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          fromRev: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const loaded = loadReadableEntry(workspace, slug);
        if (!loaded.ok) return loaded.result;

        const fromRev = clampInt(args.fromRev, {
          fallback: 0,
          min: 0,
          max: Number.MAX_SAFE_INTEGER
        });
        const limit = clampInt(args.limit, { fallback: 50, min: 1, max: 200 });
        const all = readHistory(workspace, slug).filter((event) => event.rev > fromRev);
        const events = all.slice(-limit);

        return makeJsonResult({
          project: slug,
          currentRev: loaded.entry.rev,
          fromRev,
          events,
          truncation: {
            applied: events.length < all.length,
            returned: events.length,
            totalAvailable: all.length,
            maxCount: limit
          }
        });
      }
    },
    {
      name: "tracker_pick",
      description: "Atomically claim a task through the running hub. Requires the hub to be reachable.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Optional explicit task id" },
          assignee: { type: "string", description: "Optional assignee id" },
          force: { type: "boolean", description: "Override blocked or assignee conflicts" },
          comment: { type: "string", description: "Optional task note to write with the claim" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const body = {};
        if (nonEmptyString(args.taskId)) body.taskId = nonEmptyString(args.taskId);
        if (nonEmptyString(args.assignee)) body.assignee = nonEmptyString(args.assignee);
        if (args.force === true) body.force = true;
        if (args.comment !== undefined) body.comment = args.comment;

        const response = await httpRequest(workspace, portFlag, "POST", `/api/projects/${slug}/pick`, body);
        if (response.status === 0) {
          return makeTextResult(
            `Hub not reachable at ${response.url}. Start the hub or daemon before calling tracker_pick.`,
            { isError: true }
          );
        }
        if (response.status >= 400) {
          return makeTextResult(
            `tracker_pick failed (${response.status}): ${response.body.error || response.body.raw}`,
            { isError: true }
          );
        }
        return makeJsonResult(response.body);
      }
    },
    {
      name: "tracker_undo",
      description: "Undo the most recent effective project change through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const response = await httpRequest(workspace, portFlag, "POST", `/api/projects/${slug}/undo`);
        if (response.status === 0) {
          return makeTextResult(
            `Hub not reachable at ${response.url}. Start the hub or daemon before calling tracker_undo.`,
            { isError: true }
          );
        }
        if (response.status >= 400) {
          return makeTextResult(
            `tracker_undo failed (${response.status}): ${response.body.error || response.body.raw}`,
            { isError: true }
          );
        }
        return makeJsonResult(response.body);
      }
    },
    {
      name: "tracker_redo",
      description: "Redo the last undone project change through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const response = await httpRequest(workspace, portFlag, "POST", `/api/projects/${slug}/redo`);
        if (response.status === 0) {
          return makeTextResult(
            `Hub not reachable at ${response.url}. Start the hub or daemon before calling tracker_redo.`,
            { isError: true }
          );
        }
        if (response.status >= 400) {
          return makeTextResult(
            `tracker_redo failed (${response.status}): ${response.body.error || response.body.raw}`,
            { isError: true }
          );
        }
        return makeJsonResult(response.body);
      }
    },
    {
      name: "tracker_reload",
      description: "Force one project or the full workspace to reload from disk through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Optional project slug. If omitted, reload all trackers." }
        }
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const path = slug ? `/api/projects/${slug}/reload` : "/api/reload";
        const response = await httpRequest(workspace, portFlag, "POST", path);
        if (response.status === 0) {
          return makeTextResult(
            `Hub not reachable at ${response.url}. Start the hub or daemon before calling tracker_reload.`,
            { isError: true }
          );
        }
        if (response.status >= 400) {
          return makeTextResult(
            `tracker_reload failed (${response.status}): ${response.body.error || response.body.raw}`,
            { isError: true }
          );
        }
        return makeJsonResult(response.body);
      }
    }
  ];

  return new Map(tools.map((tool) => [tool.name, tool]));
}

export async function startMcpServer({ workspace: workspaceFlag, portFlag } = {}) {
  const workspace = resolveWorkspace(workspaceFlag);
  if (!existsSync(workspace)) {
    throw new Error(`No workspace at ${workspace}. Run 'llm-tracker init' first.`);
  }
  if (!existsSync(join(workspace, "README.md"))) {
    throw new Error(`Workspace at ${workspace} is missing README.md.`);
  }
  debugLog(`server start pid=${process.pid} cwd=${process.cwd()} workspace=${workspace}`);

  const tools = createTools(workspace, portFlag);

  const server = new Server(
    { name: pkg.name, version: pkg.version },
    {
      capabilities: {
        prompts: {},
        resources: {},
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(tools.values()).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = nonEmptyString(request.params?.name);
    const tool = tools.get(name);
    if (!tool) {
      return makeTextResult(`Unknown tool: ${name || "(missing)"}`, { isError: true });
    }
    try {
      return await tool.handler(request.params?.arguments || {});
    } catch (error) {
      debugLog(`tool error ${name}: ${error.message}`);
      return makeTextResult(`Tool ${name} failed: ${error.message}`, { isError: true });
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(workspace)
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: []
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = nonEmptyString(request.params?.uri);
    if (!uri) {
      throw new Error("resources/read requires a resource uri");
    }
    return readResource(workspace, uri);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: listPrompts()
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = nonEmptyString(request.params?.name);
    if (!name) {
      throw new Error("prompts/get requires a prompt name");
    }
    return getPrompt(workspace, name, request.params?.arguments || {});
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    debugLog("transport close");
  };
  transport.onerror = (error) => {
    debugLog(`transport error: ${error.message}`);
  };

  await server.connect(transport);
  debugLog("connected to stdio transport");
}
