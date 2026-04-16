import { createRequire } from "node:module";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

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

function encodeMessage(message, lineEnding = "\r\n") {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}${lineEnding}${lineEnding}`, "utf8");
  return Buffer.concat([header, json]);
}

function findHeaderBoundary(buffer) {
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  if (crlfBoundary !== -1) {
    return { index: crlfBoundary, separatorLength: 4, lineEnding: "\r\n" };
  }

  const lfBoundary = buffer.indexOf("\n\n");
  if (lfBoundary !== -1) {
    return { index: lfBoundary, separatorLength: 2, lineEnding: "\n" };
  }

  return null;
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

function negotiateProtocolVersion(requested) {
  if (requested === "2024-11-05") {
    return requested;
  }
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return DEFAULT_PROTOCOL_VERSION;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

function parseMessages(buffer) {
  const messages = [];
  let rest = buffer;

  while (true) {
    const boundary = findHeaderBoundary(rest);
    if (!boundary) break;

    const header = rest.subarray(0, boundary.index).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      throw new Error("missing Content-Length header");
    }

    const length = parseInt(match[1], 10);
    const messageStart = boundary.index + boundary.separatorLength;
    if (rest.length - messageStart < length) break;

    const body = rest.subarray(messageStart, messageStart + length).toString("utf8");
    messages.push({
      lineEnding: boundary.lineEnding,
      message: JSON.parse(body)
    });
    rest = rest.subarray(messageStart + length);
  }

  return { messages, rest };
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
  let initialized = false;
  let buffer = Buffer.alloc(0);
  let responseLineEnding = "\r\n";

  const send = (message) => {
    process.stdout.write(encodeMessage(message, responseLineEnding));
  };

  const sendResult = (id, result) => {
    debugLog(`send result id=${id} keys=${Object.keys(result || {}).join(",")}`);
    send({
      jsonrpc: "2.0",
      id,
      result
    });
  };

  const sendError = (id, code, message, data = undefined) => {
    debugLog(`send error id=${id} code=${code} message=${message}`);
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data })
      }
    });
  };

  const onRequest = async (message) => {
    debugLog(`request method=${message.method} id=${message.id ?? "notification"}`);
    if (message.method === "initialize") {
      const requested = nonEmptyString(message.params?.protocolVersion);
      const protocolVersion = negotiateProtocolVersion(requested);

      sendResult(message.id, {
        protocolVersion,
        capabilities: {
          prompts: {},
          resources: {},
          tools: {}
        },
        serverInfo: {
          name: pkg.name,
          version: pkg.version
        }
      });
      return;
    }

    if (message.method === "ping") {
      sendResult(message.id, {});
      return;
    }

    if (message.method === "tools/list") {
      sendResult(message.id, {
        tools: Array.from(tools.values()).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      });
      return;
    }

    if (message.method === "resources/list") {
      sendResult(message.id, {
        resources: listResources(workspace)
      });
      return;
    }

    if (message.method === "resources/templates/list") {
      sendResult(message.id, {
        resourceTemplates: []
      });
      return;
    }

    if (message.method === "resources/read") {
      const uri = nonEmptyString(message.params?.uri);
      if (!uri) {
        sendError(message.id, -32602, "resources/read requires a resource uri");
        return;
      }

      try {
        sendResult(message.id, readResource(workspace, uri));
      } catch (error) {
        sendError(message.id, -32602, error.message);
      }
      return;
    }

    if (message.method === "prompts/list") {
      sendResult(message.id, {
        prompts: listPrompts()
      });
      return;
    }

    if (message.method === "prompts/get") {
      const name = nonEmptyString(message.params?.name);
      if (!name) {
        sendError(message.id, -32602, "prompts/get requires a prompt name");
        return;
      }

      try {
        sendResult(message.id, getPrompt(workspace, name, message.params?.arguments || {}));
      } catch (error) {
        sendError(message.id, -32602, error.message);
      }
      return;
    }

    if (message.method === "tools/call") {
      const name = nonEmptyString(message.params?.name);
      const tool = tools.get(name);
      if (!tool) {
        sendError(message.id, -32602, `Unknown tool: ${name || "(missing)"}`);
        return;
      }

      try {
        const result = await tool.handler(message.params?.arguments || {});
        sendResult(message.id, result);
      } catch (error) {
        sendResult(
          message.id,
          makeTextResult(
            `Tool ${name} failed: ${error.message}`,
            { isError: true }
          )
        );
      }
      return;
    }

    if (!initialized) {
      sendError(message.id, -32002, "Server not initialized");
      return;
    }

    sendError(message.id, -32601, `Method not found: ${message.method}`);
  };

  process.on("beforeExit", (code) => {
    debugLog(`beforeExit code=${code}`);
  });
  process.on("exit", (code) => {
    debugLog(`exit code=${code}`);
  });
  process.stdin.on("close", () => {
    debugLog("stdin close");
  });
  process.stdin.on("end", () => {
    debugLog("stdin end");
    process.exit(0);
  });

  process.stdin.on("data", async (chunk) => {
    debugLog(`stdin data bytes=${chunk.length}`);
    buffer = Buffer.concat([buffer, chunk]);
    let parsed;

    try {
      parsed = parseMessages(buffer);
    } catch (error) {
      debugLog(`parse error: ${error.message}`);
      process.stderr.write(`[llm-tracker mcp] failed to parse request: ${error.message}\n`);
      buffer = Buffer.alloc(0);
      return;
    }

    buffer = parsed.rest;
    for (const packet of parsed.messages) {
      responseLineEnding = packet.lineEnding || responseLineEnding;
      const message = packet.message;
      if (!message || typeof message !== "object") continue;

      if (!("id" in message)) {
        if (message.method === "notifications/initialized") {
          debugLog("notification initialized");
          initialized = true;
        } else if (message.method === "notifications/cancelled") {
          debugLog("notification cancelled");
          continue;
        }
        continue;
      }

      await onRequest(message);
    }
  });
}
