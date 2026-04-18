#!/usr/bin/env node
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
import { createTools } from "./mcp-tools.js";
import { makeTextResult, nonEmptyString } from "./mcp-utils.js";
import { resolveWorkspace } from "./workspace-client.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const MCP_DEBUG_LOG = process.env.LLM_TRACKER_MCP_DEBUG_LOG || "/tmp/llm-tracker-mcp-debug.log";

function debugLog(line) {
  if (!MCP_DEBUG_LOG) return;
  try {
    appendFileSync(MCP_DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // debug logging should never break MCP startup
  }
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
