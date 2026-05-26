import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";
import { startDaemonAndWait } from "./daemon-start-helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");
const FAKE_EMBEDDER = join(__dirname, "helpers", "fake-embedder.mjs");

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
    server.listen(0, "127.0.0.1", () => {
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
  return Buffer.from(JSON.stringify(message) + "\n", "utf8");
}

function parseMessages(buffer) {
  const messages = [];
  let rest = buffer;
  while (true) {
    const newlineIndex = rest.indexOf("\n");
    if (newlineIndex === -1) break;
    const line = rest.subarray(0, newlineIndex).toString("utf8").trim();
    rest = rest.subarray(newlineIndex + 1);
    if (!line) continue;
    messages.push(JSON.parse(line));
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

  async initialize(protocolVersion = "2024-11-05") {
    const init = await this.request("initialize", {
      protocolVersion,
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

function startMcp(workspace, extraArgs = [], options = {}) {
  const child = spawn(process.execPath, [BIN, "mcp", "--path", workspace, ...extraArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    ...options
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
    assert.equal(init.result.serverInfo.name, "llm-tracker");
    assert.ok(init.result.capabilities.tools);
    assert.ok(init.result.capabilities.resources);
    assert.ok(init.result.capabilities.prompts);

    const tools = await client.request("tools/list");
    const names = tools.result.tools.map((tool) => tool.name).sort();
    const expected = [
      "tracker_blockers",
      "tracker_brief",
      "tracker_changed",
      "tracker_decisions",
      "tracker_execute",
      "tracker_fuzzy_search",
      "tracker_help",
      "tracker_history",
      "tracker_job_checkpoint",
      "tracker_job_complete",
      "tracker_job_context_pack",
      "tracker_job_profiles",
      "tracker_job_rollover",
      "tracker_job_skill_plan",
      "tracker_job_start",
      "tracker_job_status",
      "tracker_job_unblock",
      "tracker_job_verify_pack",
      "tracker_job_verify_resolve",
      "tracker_job_verify_run",
      "tracker_next",
      "tracker_patch",
      "tracker_pick",
      "tracker_project_status",
      "tracker_projects",
      "tracker_projects_status",
      "tracker_redo",
      "tracker_reload",
      "tracker_search",
      "tracker_session_ask",
      "tracker_session_blocked",
      "tracker_session_broadcast",
      "tracker_session_complete",
      "tracker_session_context",
      "tracker_session_context_usage",
      "tracker_session_handoff",
      "tracker_session_heartbeat",
      "tracker_session_list",
      "tracker_session_note",
      "tracker_session_start",
      "tracker_session_status",
      "tracker_session_unblocked",
      "tracker_skill_run_complete",
      "tracker_skill_run_fail",
      "tracker_skill_run_skip",
      "tracker_skill_run_start",
      "tracker_skills_list",
      "tracker_undo",
      "tracker_verify",
      "tracker_why"
    ];
    assert.deepEqual(names, expected);

    const helpTool = tools.result.tools.find((tool) => tool.name === "tracker_help");
    assert.equal(helpTool.inputSchema.type, "object");

    const help = await client.request("tools/call", { name: "tracker_help", arguments: {} });
    assert.notEqual(help.result.isError, true);
    assert.match(help.result.content[0].text, /Use tracker_help first/);
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("llm-tracker mcp negotiates newer protocol versions", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-proto-");
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));

  const client = startMcp(workspace);
  try {
    const init = await client.initialize("2025-11-25");
    assert.equal(init.result.protocolVersion, "2025-11-25");
    assert.equal(init.result.serverInfo.name, "llm-tracker");
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
    assert.ok(runtimePayload.daemonRule.writeTools.includes("tracker_patch"));
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
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));

  const client = startMcp(workspace);
  try {
    await client.initialize();

    const listed = await client.request("prompts/list");
    const names = listed.result.prompts.map((prompt) => prompt.name).sort();
    assert.ok(names.includes("tracker_start_here"));
    assert.ok(names.includes("tracker_pick_next"));
    assert.ok(names.includes("tracker_task_context"));
    assert.ok(names.includes("tracker_search_project"));
    assert.ok(names.includes("tracker_execute_task"));
    assert.ok(names.includes("tracker_verify_task"));
    assert.ok(names.includes("tracker_patch_write"));

    const startHere = await client.request("prompts/get", { name: "tracker_start_here", arguments: {} });
    const startText = startHere.result.messages[0].content.text;
    assert.match(startText, /tracker:\/\/help/);
    assert.match(startText, /patches/);
    assert.match(startText, /tracker_patch/);
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

    assert.notEqual(next.result.isError, true);
    const payload = JSON.parse(next.result.content[0].text);
    assert.equal(payload.projectSlug, "test-project");
    assert.equal(payload.recommendedTaskId, "t1");
    assert.equal(payload.next[0].projectSlug, "test-project");
    assert.equal(payload.next[0].id, "t1");
    assert.equal(payload.next[1].id, "t2");

    const missingSlug = await client.request("tools/call", {
      name: "tracker_next",
      arguments: {}
    });
    assert.equal(missingSlug.result.isError, true);
    assert.match(missingSlug.result.content[0].text, /explicit project slug/);
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_search and tracker_fuzzy_search return semantic and fuzzy matches over MCP", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-search-");
  const tracker = validProject({
    tasks: [
      {
        id: "t-017",
        title: "Parallel execution branch/variant route-flow proof",
        status: "in_progress",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: [],
        context: { tags: ["parallel-execution"] }
      },
      {
        id: "t-018",
        title: "Investor demo cost surface",
        status: "not_started",
        placement: { swimlaneId: "ops", priorityId: "p1" },
        dependencies: [],
        context: { tags: ["investor-demo", "cost"] }
      }
    ]
  });
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(tracker, null, 2));

  const client = startMcp(workspace, [], {
    env: { ...process.env, LLM_TRACKER_EMBEDDER_MODULE: FAKE_EMBEDDER }
  });
  try {
    await client.initialize();

    const exact = await client.request("tools/call", {
      name: "tracker_search",
      arguments: { slug: "test-project", query: "route flow proof" }
    });
    const exactPayload = JSON.parse(exact.result.content[0].text);
    assert.equal(exactPayload.mode, "semantic");
    assert.equal(exactPayload.matches[0].id, "t-017");

    const fuzzy = await client.request("tools/call", {
      name: "tracker_fuzzy_search",
      arguments: { slug: "test-project", query: "paralel route" }
    });
    const fuzzyPayload = JSON.parse(fuzzy.result.content[0].text);
    assert.equal(fuzzyPayload.mode, "fuzzy");
    assert.equal(fuzzyPayload.matches[0].id, "t-017");
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_pick goes through the running hub from MCP", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-pick-");
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));
  const port = await findFreePort();

  try {
    await startDaemonAndWait(runCli, { workspace, port, projectSlug: "test-project" });

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

      assert.notEqual(picked.result.isError, true);
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

test("tracker_patch goes through the running hub from MCP", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-patch-");
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));
  const port = await findFreePort();

  try {
    await startDaemonAndWait(runCli, { workspace, port, projectSlug: "test-project" });

    const client = startMcp(workspace);
    try {
      await client.initialize();

      const patched = await client.request("tools/call", {
        name: "tracker_patch",
        arguments: {
          slug: "test-project",
          patch: {
            meta: {
              scratchpad: "patched via mcp"
            }
          }
        }
      });

      assert.notEqual(patched.result.isError, true);
      const payload = JSON.parse(patched.result.content[0].text);
      assert.equal(payload.ok, true);
      assert.equal(payload.noop, false);
      assert.match(payload.file, /trackers[\\/]test-project\.json$/);
      assert.equal(typeof payload.rev, "number");

      const project = await client.request("tools/call", {
        name: "tracker_project_status",
        arguments: { slug: "test-project" }
      });
      const projectPayload = JSON.parse(project.result.content[0].text);
      assert.equal(projectPayload.project.scratchpad, "patched via mcp");
    } finally {
      await client.close();
    }
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_session_status forwards sessionToken to the running hub", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-session-token-");
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));
  const port = await findFreePort();

  try {
    await startDaemonAndWait(runCli, { workspace, port, projectSlug: "test-project" });

    const client = startMcp(workspace);
    try {
      await client.initialize();

      const started = await client.request("tools/call", {
        name: "tracker_session_start",
        arguments: {
          name: "mcp token test",
          tier: "mcp_tracked",
          projectSlug: "test-project"
        }
      });
      assert.notEqual(started.result.isError, true);
      const startedPayload = JSON.parse(started.result.content[0].text);
      const sessionId = startedPayload.session.id;
      const sessionToken = startedPayload.token.token;
      assert.match(sessionId, /^ses_/);
      assert.equal(typeof sessionToken, "string");

      const targetStarted = await client.request("tools/call", {
        name: "tracker_session_start",
        arguments: {
          name: "mcp ask target",
          tier: "mcp_tracked",
          projectSlug: "test-project"
        }
      });
      assert.notEqual(targetStarted.result.isError, true);
      const targetPayload = JSON.parse(targetStarted.result.content[0].text);
      const targetSessionId = targetPayload.session.id;

      const rejected = await client.request("tools/call", {
        name: "tracker_session_status",
        arguments: {
          sessionId,
          sessionToken: "not-a-real-session-token",
          status: "quiet",
          note: "should be rejected"
        }
      });
      assert.ok(rejected.error);
      assert.match(rejected.error.message, /SESSION_TOKEN_REJECTED|not recognized|401/);

      const afterReject = await client.request("tools/call", {
        name: "tracker_session_context",
        arguments: { sessionId, sessionToken }
      });
      const afterRejectPayload = JSON.parse(afterReject.result.content[0].text);
      assert.equal(afterRejectPayload.session.status, "starting");

      const accepted = await client.request("tools/call", {
        name: "tracker_session_status",
        arguments: {
          sessionId,
          sessionToken,
          status: "quiet",
          note: "valid token"
        }
      });
      assert.notEqual(accepted.result.isError, true);
      const acceptedPayload = JSON.parse(accepted.result.content[0].text);
      assert.equal(acceptedPayload.session.status, "quiet");

      const rejectedAsk = await client.request("tools/call", {
        name: "tracker_session_ask",
        arguments: {
          sessionId,
          sessionToken: "not-a-real-session-token",
          targetSessionId,
          prompt: "Can you verify this?"
        }
      });
      assert.ok(rejectedAsk.error);
      assert.match(rejectedAsk.error.message, /SESSION_TOKEN_REJECTED|not recognized|401/);

      const acceptedAsk = await client.request("tools/call", {
        name: "tracker_session_ask",
        arguments: {
          sessionId,
          sessionToken,
          targetSessionId,
          prompt: "Can you verify this?"
        }
      });
      assert.notEqual(acceptedAsk.result.isError, true);
      const askPayload = JSON.parse(acceptedAsk.result.content[0].text);
      assert.equal(askPayload.ask.from, sessionId);
      assert.equal(askPayload.ask.to, targetSessionId);
      assert.equal(askPayload.ask.prompt, "Can you verify this?");
      assert.equal(askPayload.delivery.targetSessionNotification, true);
      assert.equal(askPayload.targetSession.asks.length, 1);
      assert.equal(askPayload.targetSession.asks[0].prompt, "Can you verify this?");

      const blocked = await client.request("tools/call", {
        name: "tracker_session_blocked",
        arguments: {
          sessionId,
          sessionToken,
          reason: "waiting on dependency"
        }
      });
      assert.notEqual(blocked.result.isError, true);
      const blockedPayload = JSON.parse(blocked.result.content[0].text);
      assert.equal(blockedPayload.session.status, "blocked");

      const rejectedUnblock = await client.request("tools/call", {
        name: "tracker_session_unblocked",
        arguments: {
          sessionId,
          sessionToken: "not-a-real-session-token",
          reason: "dependency cleared"
        }
      });
      assert.ok(rejectedUnblock.error);
      assert.match(rejectedUnblock.error.message, /SESSION_TOKEN_REJECTED|not recognized|401/);

      const afterRejectedUnblock = await client.request("tools/call", {
        name: "tracker_session_context",
        arguments: { sessionId, sessionToken }
      });
      const afterRejectedUnblockPayload = JSON.parse(afterRejectedUnblock.result.content[0].text);
      assert.equal(afterRejectedUnblockPayload.session.status, "blocked");

      const unblocked = await client.request("tools/call", {
        name: "tracker_session_unblocked",
        arguments: {
          sessionId,
          sessionToken,
          reason: "dependency cleared"
        }
      });
      assert.notEqual(unblocked.result.isError, true);
      const unblockedPayload = JSON.parse(unblocked.result.content[0].text);
      assert.equal(unblockedPayload.session.status, "active");

      const usageBelow = await client.request("tools/call", {
        name: "tracker_session_context_usage",
        arguments: {
          sessionId,
          sessionToken,
          percent: 84,
          used: 84000,
          limit: 100000
        }
      });
      assert.notEqual(usageBelow.result.isError, true);
      const usageBelowPayload = JSON.parse(usageBelow.result.content[0].text);
      assert.equal(usageBelowPayload.session.status, "active");
      assert.equal(usageBelowPayload.session.statusSource.kind, "mcp");
      assert.deepEqual(usageBelowPayload.session.contextUsage, {
        percent: 84,
        used: 84000,
        limit: 100000,
        source: "mcp"
      });
      assert.equal(usageBelowPayload.session.lastStructuredEventAt, usageBelowPayload.session.lastActivityAt);
      assert.deepEqual(usageBelowPayload.session.warnings, []);

      const usage = await client.request("tools/call", {
        name: "tracker_session_context_usage",
        arguments: {
          sessionId,
          sessionToken,
          percent: 85,
          used: 85000,
          limit: 100000
        }
      });
      assert.notEqual(usage.result.isError, true);
      const usagePayload = JSON.parse(usage.result.content[0].text);
      assert.equal(usagePayload.session.status, "context_high");
      assert.equal(usagePayload.session.statusSource.kind, "mcp");
      assert.deepEqual(usagePayload.session.contextUsage, {
        percent: 85,
        used: 85000,
        limit: 100000,
        source: "mcp"
      });
      assert.equal(usagePayload.session.lastStructuredEventAt, usagePayload.session.lastActivityAt);
      assert.deepEqual(usagePayload.session.warnings, [{ kind: "context_high", source: "mcp", percent: 85 }]);
    } finally {
      await client.close();
    }
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_job_* tools start, checkpoint, status, and complete through the running hub", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-job-tools-");
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));
  const port = await findFreePort();

  try {
    await startDaemonAndWait(runCli, { workspace, port, projectSlug: "test-project" });

    const client = startMcp(workspace);
    try {
      await client.initialize();

      const started = await client.request("tools/call", {
        name: "tracker_session_start",
        arguments: {
          name: "mcp job test",
          tier: "mcp_tracked",
          projectSlug: "test-project",
          taskId: "t1"
        }
      });
      assert.notEqual(started.result.isError, true);
      const startedPayload = JSON.parse(started.result.content[0].text);
      const sessionId = startedPayload.session.id;
      const sessionToken = startedPayload.token.token;

      const jobStart = await client.request("tools/call", {
        name: "tracker_job_start",
        arguments: {
          projectSlug: "test-project",
          taskId: "t1",
          sessionId,
          sessionToken,
          profileId: "code-implementer",
          kind: "code"
        }
      });
      assert.notEqual(jobStart.result.isError, true);
      const jobStartPayload = JSON.parse(jobStart.result.content[0].text);
      const jobId = jobStartPayload.jobId;
      assert.match(jobId, /^job_/);
      assert.equal(jobStartPayload.job.status, "running");
      assert.equal(jobStartPayload.job.sessionId, sessionId);

      const rejectedJobCheckpoint = await client.request("tools/call", {
        name: "tracker_job_checkpoint",
        arguments: {
          jobId,
          sessionToken: "not-a-real-session-token",
          status: "blocked",
          summary: "should be rejected"
        }
      });
      assert.ok(rejectedJobCheckpoint.error);
      assert.match(rejectedJobCheckpoint.error.message, /SESSION_TOKEN_REJECTED|not recognized|401/);

      const rejectedJobUnblockToken = await client.request("tools/call", {
        name: "tracker_job_unblock",
        arguments: {
          jobId,
          sessionToken: "not-a-real-session-token",
          reason: "should be rejected"
        }
      });
      assert.ok(rejectedJobUnblockToken.error);
      assert.match(rejectedJobUnblockToken.error.message, /SESSION_TOKEN_REJECTED|not recognized|401/);

      const rejectedJobUnblockState = await client.request("tools/call", {
        name: "tracker_job_unblock",
        arguments: {
          jobId,
          sessionToken,
          reason: "not blocked yet"
        }
      });
      assert.ok(rejectedJobUnblockState.error);
      assert.match(rejectedJobUnblockState.error.message, /INVALID_JOB_STATE|409/);

      const jobStatus = await client.request("tools/call", {
        name: "tracker_job_status",
        arguments: { jobId }
      });
      assert.notEqual(jobStatus.result.isError, true);
      const jobStatusPayload = JSON.parse(jobStatus.result.content[0].text);
      assert.equal(jobStatusPayload.id, jobId);
      assert.equal(jobStatusPayload.status, "running");

      const verifyPack = await client.request("tools/call", {
        name: "tracker_job_verify_pack",
        arguments: { jobId }
      });
      assert.equal(verifyPack.result.isError, true);
      assert.match(verifyPack.result.content[0].text, /VERIFY_PACK_NOT_FOUND/);

      const rejectedVerifyRunToken = await client.request("tools/call", {
        name: "tracker_job_verify_run",
        arguments: {
          jobId,
          itemId: "cmd.ok",
          sessionToken: "not-a-real-session-token"
        }
      });
      assert.ok(rejectedVerifyRunToken.error);
      assert.match(rejectedVerifyRunToken.error.message, /SESSION_TOKEN_REJECTED|not recognized|401/);

      const missingVerifyRunPack = await client.request("tools/call", {
        name: "tracker_job_verify_run",
        arguments: {
          jobId,
          itemId: "cmd.ok",
          sessionToken,
          idempotencyKey: "mcp-verify-run-1"
        }
      });
      assert.ok(missingVerifyRunPack.error);
      assert.match(missingVerifyRunPack.error.message, /VERIFY_PACK_NOT_FOUND|404/);

      const missingVerifyResolvePack = await client.request("tools/call", {
        name: "tracker_job_verify_resolve",
        arguments: {
          jobId,
          itemId: "approve.ship",
          sessionToken,
          approved: true,
          reason: "approved by MCP",
          user: "mcp-agent"
        }
      });
      assert.ok(missingVerifyResolvePack.error);
      assert.match(missingVerifyResolvePack.error.message, /VERIFY_PACK_NOT_FOUND|404/);

      const skillPlan = await client.request("tools/call", {
        name: "tracker_job_skill_plan",
        arguments: { jobId }
      });
      assert.notEqual(skillPlan.result.isError, true);
      const skillPlanPayload = JSON.parse(skillPlan.result.content[0].text);
      assert.equal(skillPlanPayload.jobId, jobId);
      assert.equal(skillPlanPayload.profileId, "code-implementer");
      assert.equal(skillPlanPayload.skillPlan[0].skillId, "lt.execute_scope");

      const skillsList = await client.request("tools/call", {
        name: "tracker_skills_list",
        arguments: {}
      });
      assert.notEqual(skillsList.result.isError, true);
      const skillsPayload = JSON.parse(skillsList.result.content[0].text);
      assert.ok(skillsPayload.skills.some((skill) => skill.id === "lt.verify"));

      const profilesList = await client.request("tools/call", {
        name: "tracker_job_profiles",
        arguments: {}
      });
      assert.notEqual(profilesList.result.isError, true);
      const profilesPayload = JSON.parse(profilesList.result.content[0].text);
      assert.ok(profilesPayload.profiles.some((profile) => profile.id === "code-implementer"));

      const skillRunStart = await client.request("tools/call", {
        name: "tracker_skill_run_start",
        arguments: {
          jobId,
          sessionToken,
          skillId: "lt.verify",
          summary: "starting structured verify skill"
        }
      });
      assert.notEqual(skillRunStart.result.isError, true);
      const skillRunStartPayload = JSON.parse(skillRunStart.result.content[0].text);
      const skillRunId = skillRunStartPayload.skillRunId;
      assert.match(skillRunId, /^skr_/);
      assert.equal(skillRunStartPayload.skillRun.status, "running");

      const rejectedSkillComplete = await client.request("tools/call", {
        name: "tracker_skill_run_complete",
        arguments: {
          jobId,
          skillRunId,
          sessionToken: "not-a-real-session-token",
          summary: "should be rejected"
        }
      });
      assert.ok(rejectedSkillComplete.error);
      assert.match(rejectedSkillComplete.error.message, /SESSION_TOKEN_REJECTED|not recognized|401/);

      const skillRunComplete = await client.request("tools/call", {
        name: "tracker_skill_run_complete",
        arguments: {
          jobId,
          skillRunId,
          sessionToken,
          summary: "structured verify skill complete"
        }
      });
      assert.notEqual(skillRunComplete.result.isError, true);
      const skillRunCompletePayload = JSON.parse(skillRunComplete.result.content[0].text);
      assert.equal(skillRunCompletePayload.status, "succeeded");
      assert.equal(skillRunCompletePayload.skillRun.status, "succeeded");
      assert.equal(skillRunCompletePayload.skillRun.summary, "structured verify skill complete");

      const contextPack = await client.request("tools/call", {
        name: "tracker_job_context_pack",
        arguments: { jobId, kind: "start" }
      });
      assert.equal(contextPack.result.isError, true);
      assert.match(contextPack.result.content[0].text, /NOT_IMPLEMENTED/);

      const checkpoint = await client.request("tools/call", {
        name: "tracker_job_checkpoint",
        arguments: {
          jobId,
          sessionToken,
          status: "blocked",
          summary: "waiting on review"
        }
      });
      assert.notEqual(checkpoint.result.isError, true);
      const checkpointPayload = JSON.parse(checkpoint.result.content[0].text);
      assert.equal(checkpointPayload.job.status, "blocked");
      assert.equal(checkpointPayload.job.lastCheckpointSummary, "waiting on review");

      const unblock = await client.request("tools/call", {
        name: "tracker_job_unblock",
        arguments: {
          jobId,
          sessionToken,
          reason: "dependency resolved"
        }
      });
      assert.notEqual(unblock.result.isError, true);
      const unblockPayload = JSON.parse(unblock.result.content[0].text);
      assert.equal(typeof unblockPayload.eventId, "string");
      assert.equal(typeof unblockPayload.rev, "number");
      assert.equal(unblockPayload.job.id, jobId);
      assert.ok(["running", "queued"].includes(unblockPayload.job.status));

      const rollover = await client.request("tools/call", {
        name: "tracker_job_rollover",
        arguments: {
          jobId,
          sessionToken,
          reason: "handoff needed"
        }
      });
      assert.notEqual(rollover.result.isError, true);
      const rolloverPayload = JSON.parse(rollover.result.content[0].text);
      assert.equal(rolloverPayload.job.id, jobId);
      assert.equal(rolloverPayload.job.rolloverReason, "handoff needed");

      const complete = await client.request("tools/call", {
        name: "tracker_job_complete",
        arguments: {
          jobId,
          sessionToken,
          summary: "complete through MCP"
        }
      });
      assert.notEqual(complete.result.isError, true);
      const completePayload = JSON.parse(complete.result.content[0].text);
      assert.deepEqual(completePayload, { ok: true, mode: "completed", jobId });
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
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));
  const port = await findFreePort();

  try {
    await startDaemonAndWait(runCli, { workspace, port, projectSlug: "test-project" });

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
