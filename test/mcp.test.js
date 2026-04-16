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

    const tools = await client.request("tools/list");
    const names = tools.result.tools.map((tool) => tool.name).sort();
    assert.ok(names.includes("tracker_help"));
    assert.ok(names.includes("tracker_next"));
    assert.ok(names.includes("tracker_pick"));
    assert.ok(names.includes("tracker_reload"));

    const help = await client.request("tools/call", { name: "tracker_help", arguments: {} });
    assert.equal(help.result.isError, false);
    assert.match(help.result.content[0].text, /Use tracker_help first/);
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
