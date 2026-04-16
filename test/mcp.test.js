import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace(prefix = "llm-tracker-mcp-") {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# MCP test workspace\n\nUse tracker_help first.\n");
  return ws;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    ...options
  });
}

function stopDaemon(workspace) {
  runCli(["daemon", "stop", "--path", workspace]);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "::", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

function encodeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, json]);
}

function parseMessages(buffer) {
  const messages = [];
  let rest = buffer;

  while (true) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = rest.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("missing Content-Length header");

    const length = parseInt(match[1], 10);
    const messageStart = headerEnd + 4;
    if (rest.length - messageStart < length) break;

    const body = rest.subarray(messageStart, messageStart + length).toString("utf8");
    messages.push(JSON.parse(body));
    rest = rest.subarray(messageStart + length);
  }

  return { messages, rest };
}

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk) => {
      const parsed = parseMessages(Buffer.concat([this.buffer, chunk]));
      this.buffer = parsed.rest;
      for (const message of parsed.messages) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    });

    child.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`MCP server exited: ${code ?? "null"} ${signal || ""}`.trim()));
      }
      this.pending.clear();
    });
  }

  request(method, params = undefined) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 5000);
      timeout.unref?.();

      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });

    this.child.stdin.write(encodeMessage(payload));
    return promise;
  }

  notify(method, params = undefined) {
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.child.stdin.write(encodeMessage(payload));
  }

  async initialize() {
    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" }
    });
    this.notify("notifications/initialized");
    return init;
  }

  async close() {
    this.child.stdin.end();
    this.child.kill();
    await new Promise((resolve) => this.child.once("exit", resolve));
  }
}

function startMcp(workspace, extraArgs = []) {
  const child = spawn(process.execPath, [BIN, "mcp", "--path", workspace, ...extraArgs], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.resume();
  return new McpClient(child);
}

test("llm-tracker mcp initializes and lists tracker tools", async () => {
  const workspace = setupWorkspace();
  const tracker = validProject();
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));

  const client = startMcp(workspace);
  try {
    const init = await client.initialize();
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.capabilities.tools.listChanged, false);
    assert.equal(init.result.capabilities.resources.listChanged, false);
    assert.equal(init.result.capabilities.resources.subscribe, false);
    assert.equal(init.result.capabilities.prompts.listChanged, false);
    assert.match(init.result.instructions, /tracker:\/\/help/);

    const tools = await client.request("tools/list");
    const names = tools.result.tools.map((tool) => tool.name).sort();
    assert.ok(names.includes("tracker_help"));
    assert.ok(names.includes("tracker_project_status"));
    assert.ok(names.includes("tracker_projects_status"));
    assert.ok(names.includes("tracker_next"));
    assert.ok(names.includes("tracker_history"));
    assert.ok(names.includes("tracker_pick"));
    assert.ok(names.includes("tracker_undo"));
    assert.ok(names.includes("tracker_redo"));
    assert.ok(names.includes("tracker_reload"));

    const help = await client.request("tools/call", { name: "tracker_help", arguments: {} });
    assert.equal(help.result.isError, false);
    assert.match(help.result.content[0].text, /Use tracker_help first/);
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("MCP resources expose workspace help, runtime, and project status", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-resources-");
  const tracker = validProject();
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));

  const client = startMcp(workspace);
  try {
    await client.initialize();

    const listed = await client.request("resources/list");
    const uris = listed.result.resources.map((resource) => resource.uri).sort();
    assert.ok(uris.includes("tracker://help"));
    assert.ok(uris.includes("tracker://workspace/status"));
    assert.ok(uris.includes("tracker://workspace/runtime"));
    assert.ok(uris.includes("tracker://projects"));
    assert.ok(uris.includes("tracker://projects/test-project/status"));

    const help = await client.request("resources/read", { uri: "tracker://help" });
    assert.match(help.result.contents[0].text, /Use tracker_help first/);

    const runtime = await client.request("resources/read", { uri: "tracker://workspace/runtime" });
    const runtimePayload = JSON.parse(runtime.result.contents[0].text);
    assert.equal(runtimePayload.daemonRule.readToolsRequireDaemon, false);
    assert.equal(runtimePayload.daemonRule.writeToolsRequireDaemon, true);
    assert.match(runtimePayload.patchWorkflow.patchDirectory, /patches$/);

    const project = await client.request("resources/read", { uri: "tracker://projects/test-project/status" });
    const projectPayload = JSON.parse(project.result.contents[0].text);
    assert.equal(projectPayload.project.slug, "test-project");
    assert.equal(projectPayload.project.counts.not_started, 1);
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("MCP prompts expose tracker workflows and operational guidance", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-prompts-");
  const tracker = validProject();
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));

  const client = startMcp(workspace);
  try {
    await client.initialize();

    const listed = await client.request("prompts/list");
    const names = listed.result.prompts.map((prompt) => prompt.name).sort();
    assert.ok(names.includes("tracker_start_here"));
    assert.ok(names.includes("tracker_pick_next"));
    assert.ok(names.includes("tracker_task_context"));
    assert.ok(names.includes("tracker_execute_task"));
    assert.ok(names.includes("tracker_verify_task"));
    assert.ok(names.includes("tracker_patch_write"));

    const startHere = await client.request("prompts/get", { name: "tracker_start_here", arguments: {} });
    const startText = startHere.result.messages[0].content.text;
    assert.match(startText, /tracker:\/\/help/);
    assert.match(startText, /patches/);
    assert.match(startText, /tracker_pick/);

    const execute = await client.request("prompts/get", {
      name: "tracker_execute_task",
      arguments: { slug: "test-project", taskId: "t1" }
    });
    const executeText = execute.result.messages[0].content.text;
    assert.match(executeText, /tracker_execute/);
    assert.match(executeText, /tracker_verify/);
    assert.match(executeText, /test-project/);
    assert.match(executeText, /t1/);
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_project_status and tracker_projects_status return status payloads over MCP", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-status-");
  const tracker = validProject();
  tracker.meta.scratchpad = "status banner";
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));

  const client = startMcp(workspace);
  try {
    await client.initialize();

    const overall = await client.request("tools/call", {
      name: "tracker_projects_status",
      arguments: {}
    });
    const overallPayload = JSON.parse(overall.result.content[0].text);
    assert.equal(overallPayload.projectCount, 1);
    assert.equal(overallPayload.projects[0].slug, "test-project");

    const project = await client.request("tools/call", {
      name: "tracker_project_status",
      arguments: { slug: "test-project" }
    });
    const projectPayload = JSON.parse(project.result.content[0].text);
    assert.equal(projectPayload.project.slug, "test-project");
    assert.equal(projectPayload.project.scratchpad, "status banner");
    assert.equal(projectPayload.project.counts.not_started, 1);
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_next returns deterministic ranking over stdio MCP", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-next-");
  const tracker = validProject();
  tracker.tasks[0].comment = "Highest-priority ready task";
  tracker.tasks[1].dependencies = ["t1"];
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));

  const client = startMcp(workspace);
  try {
    await client.initialize();

    const next = await client.request("tools/call", {
      name: "tracker_next",
      arguments: { slug: "test-project", limit: 3 }
    });

    assert.equal(next.result.isError, false);
    const payload = JSON.parse(next.result.content[0].text);
    assert.equal(payload.recommendedTaskId, "t1");
    assert.equal(payload.next[0].id, "t1");
    assert.equal(payload.next[1].id, "t2");
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_pick goes through the running hub from MCP", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-pick-");
  const tracker = validProject();
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));
  const port = await findFreePort();

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const client = startMcp(workspace);
    try {
      await client.initialize();

      const picked = await client.request("tools/call", {
        name: "tracker_pick",
        arguments: {
          slug: "test-project",
          assignee: "codex-mcp"
        }
      });

      assert.equal(picked.result.isError, false);
      const payload = JSON.parse(picked.result.content[0].text);
      assert.equal(payload.pickedTaskId, "t1");
      assert.equal(payload.task.assignee, "codex-mcp");
      assert.equal(payload.task.status, "in_progress");
    } finally {
      await client.close();
    }
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_history, tracker_undo, and tracker_redo work through MCP", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-history-");
  const tracker = validProject();
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));
  const port = await findFreePort();

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const client = startMcp(workspace);
    try {
      await client.initialize();

      const picked = await client.request("tools/call", {
        name: "tracker_pick",
        arguments: { slug: "test-project", assignee: "codex-mcp" }
      });
      const pickedPayload = JSON.parse(picked.result.content[0].text);
      assert.equal(pickedPayload.task.status, "in_progress");

      const history = await client.request("tools/call", {
        name: "tracker_history",
        arguments: { slug: "test-project", limit: 5 }
      });
      const historyPayload = JSON.parse(history.result.content[0].text);
      assert.ok(historyPayload.events.length >= 1);

      const undo = await client.request("tools/call", {
        name: "tracker_undo",
        arguments: { slug: "test-project" }
      });
      const undoPayload = JSON.parse(undo.result.content[0].text);
      assert.equal(undoPayload.action, "undo");

      const redo = await client.request("tools/call", {
        name: "tracker_redo",
        arguments: { slug: "test-project" }
      });
      const redoPayload = JSON.parse(redo.result.content[0].text);
      assert.equal(redoPayload.action, "redo");
    } finally {
      await client.close();
    }
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
