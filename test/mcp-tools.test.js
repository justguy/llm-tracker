import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTools } from "../bin/mcp-tools.js";
import {
  JOB_MUTATION_TOOL_NAMES,
  JOB_TOOL_NAMES,
  SESSION_BOOTSTRAP_TOOL_NAMES,
  SESSION_TOKEN_REQUIRED_TOOL_NAMES,
  SESSION_TOKEN_MUTATION_TOOL_NAMES,
  SKILL_MUTATION_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  SESSION_TOOL_NAMES,
  WORKSPACE_WRITE_TOOL_NAMES,
  workspaceRuntimePayload
} from "../bin/mcp-context-data.js";
import { getPrompt } from "../bin/mcp-prompts.js";
import { validProject } from "./fixtures.js";

function setupWorkspace(prefix = "llm-tracker-mcp-tools-") {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
    mkdirSync(join(workspace, sub), { recursive: true });
  }
  writeFileSync(join(workspace, "README.md"), "# MCP tool test workspace\n");
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );
  return workspace;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : null));
    req.on("error", reject);
  });
}

test("tracker_patch is exposed across MCP tools, runtime metadata, and prompts", () => {
  const workspace = setupWorkspace();
  try {
    const tools = createTools(workspace);
    assert.ok(tools.has("tracker_patch"));

    const runtime = workspaceRuntimePayload(workspace);
    assert.ok(runtime.daemonRule.writeTools.includes("tracker_patch"));

    const startHere = getPrompt(workspace, "tracker_start_here");
    assert.match(startHere.messages[0].content.text, /tracker_patch/);

    const patchWrite = getPrompt(workspace, "tracker_patch_write", { slug: "test-project" });
    assert.match(patchWrite.messages[0].content.text, /tracker_patch/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_next tool and prompt make project scope explicit", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-next-scope-");
  try {
    const tool = createTools(workspace).get("tracker_next");
    assert.match(tool.description, /explicitly specified project/);
    assert.match(tool.inputSchema.properties.slug.description, /Required project slug/);

    const missingSlug = await tool.handler({});
    assert.equal(missingSlug.isError, true);
    assert.match(missingSlug.content[0].text, /explicit project slug/);

    const startHere = getPrompt(workspace, "tracker_start_here");
    assert.match(startHere.messages[0].content.text, /Choose the project slug explicitly/);

    const pickNext = getPrompt(workspace, "tracker_pick_next", { slug: "test-project" });
    assert.match(pickNext.messages[0].content.text, /do not use a recommendation from any other project/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_patch validates required MCP arguments before attempting hub I/O", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-validate-");
  try {
    const tool = createTools(workspace).get("tracker_patch");

    const missingSlug = await tool.handler({ patch: { meta: { scratchpad: "hi" } } });
    assert.equal(missingSlug.isError, true);
    assert.match(missingSlug.content[0].text, /requires a project slug/i);

    const missingPatch = await tool.handler({ slug: "test-project" });
    assert.equal(missingPatch.isError, true);
    assert.match(missingPatch.content[0].text, /requires a JSON object patch/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_session_* tools distinguish bootstrap from token-validated mutations", () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-session-");
  try {
    const tools = createTools(workspace);
    for (const name of SESSION_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.equal(tool.inputSchema.type, "object");
    }
    for (const name of SESSION_BOOTSTRAP_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.equal(tool.inputSchema.properties.sessionToken, undefined, `${name} issues the initial token`);
    }
    for (const name of SESSION_TOKEN_MUTATION_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool.inputSchema.properties.sessionToken, `${name} should carry sessionToken`);
      assert.ok(tool.inputSchema.required.includes("sessionToken"), `${name} should require sessionToken`);
    }

    const runtime = workspaceRuntimePayload(workspace);
    assert.deepEqual(runtime.daemonRule.sessionTools, SESSION_TOOL_NAMES);
    assert.deepEqual(runtime.daemonRule.sessionBootstrapTools, SESSION_BOOTSTRAP_TOOL_NAMES);
    assert.deepEqual(runtime.daemonRule.sessionTokenMutationTools, SESSION_TOKEN_MUTATION_TOOL_NAMES);
    assert.deepEqual(runtime.daemonRule.sessionTokenRequiredTools, [
      ...SESSION_TOKEN_MUTATION_TOOL_NAMES,
      ...JOB_MUTATION_TOOL_NAMES,
      ...SKILL_MUTATION_TOOL_NAMES
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Session Hub mutating MCP tools reject missing sessionToken before hub I/O", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-token-required-");
  try {
    const tools = createTools(workspace);
    const sessionId = "ses_01h2x3y4z5a6b7c8d9e0f1g2h3";
    const jobId = "job_01h2x3y4z5a6b7c8d9e0f1g2h3";
    const skillRunId = "skr_01h2x3y4z5a6b7c8d9e0f1g2h3";
    const argsByName = {
      tracker_session_heartbeat: { sessionId },
      tracker_session_status: { sessionId, status: "active" },
      tracker_session_note: { sessionId, note: "note" },
      tracker_session_blocked: { sessionId, reason: "blocked" },
      tracker_session_unblocked: { sessionId, reason: "unblocked" },
      tracker_session_handoff: { sessionId, summary: "handoff" },
      tracker_session_context_usage: { sessionId, percent: 80 },
      tracker_session_complete: { sessionId, summary: "done" },
      tracker_session_broadcast: { sessionId, message: "broadcast" },
      tracker_session_ask: { sessionId, targetSessionId: sessionId, prompt: "question" },
      tracker_job_start: {
        projectSlug: "test-project",
        taskId: "t-001",
        sessionId,
        profileId: "code-implementer",
        kind: "code"
      },
      tracker_job_checkpoint: { jobId, status: "running" },
      tracker_job_complete: { jobId, summary: "done" },
      tracker_job_rollover: { jobId, reason: "context" },
      tracker_job_unblock: { jobId, reason: "ready" },
      tracker_job_verify_run: { jobId, itemId: "cmd.ok" },
      tracker_job_verify_resolve: { jobId, itemId: "approve.ship", approved: true },
      tracker_skill_run_start: { jobId, skillId: "lt.verify" },
      tracker_skill_run_complete: { jobId, skillRunId },
      tracker_skill_run_skip: { jobId, skillRunId },
      tracker_skill_run_fail: { jobId, skillRunId }
    };

    assert.deepEqual(SESSION_TOKEN_REQUIRED_TOOL_NAMES, [
      ...SESSION_TOKEN_MUTATION_TOOL_NAMES,
      ...JOB_MUTATION_TOOL_NAMES,
      ...SKILL_MUTATION_TOOL_NAMES
    ]);
    assert.deepEqual(WORKSPACE_WRITE_TOOL_NAMES, [
      "tracker_patch",
      "tracker_pick",
      "tracker_undo",
      "tracker_redo",
      "tracker_reload"
    ]);

    for (const name of SESSION_TOKEN_REQUIRED_TOOL_NAMES) {
      const result = await tools.get(name).handler(argsByName[name]);
      assert.equal(result.isError, true, `${name} should reject before I/O`);
      assert.match(result.content[0].text, /requires sessionToken/, `${name} should name sessionToken`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_job_* tools are registered and mutating tools carry sessionToken", () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-job-");
  try {
    const tools = createTools(workspace);
    for (const name of JOB_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.equal(tool.inputSchema.type, "object");
    }
    for (const name of JOB_MUTATION_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool.inputSchema.properties.sessionToken, `${name} should carry sessionToken`);
      assert.ok(tool.inputSchema.required.includes("sessionToken"), `${name} should require sessionToken`);
    }

    const runtime = workspaceRuntimePayload(workspace);
    assert.equal(runtime.daemonRule.jobToolsRequireDaemon, true);
    assert.deepEqual(runtime.daemonRule.jobTools, JOB_TOOL_NAMES);
    for (const name of JOB_MUTATION_TOOL_NAMES) {
      assert.ok(runtime.daemonRule.writeTools.includes(name), `${name} should require the daemon`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_skill_* tools are registered and mutating tools carry sessionToken", () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-skill-");
  try {
    const tools = createTools(workspace);
    for (const name of SKILL_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.equal(tool.inputSchema.type, "object");
    }
    for (const name of SKILL_MUTATION_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool.inputSchema.properties.sessionToken, `${name} should carry sessionToken`);
      assert.ok(tool.inputSchema.required.includes("sessionToken"), `${name} should require sessionToken`);
    }

    const runtime = workspaceRuntimePayload(workspace);
    assert.equal(runtime.daemonRule.skillToolsRequireDaemon, true);
    assert.deepEqual(runtime.daemonRule.skillTools, SKILL_TOOL_NAMES);
    for (const name of SKILL_MUTATION_TOOL_NAMES) {
      assert.ok(runtime.daemonRule.writeTools.includes(name), `${name} should require the daemon`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_job_complete preserves the gates_pending union as a normal MCP result", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-job-gates-");
  const jobId = "job_01h2x3y4z5a6b7c8d9e0f1g2h3";
  let requestBody = null;
  let sessionToken = null;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== `/api/jobs/${jobId}/complete`) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    sessionToken = req.headers["x-lt-session-token"];
    requestBody = await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      mode: "gates_pending",
      missing: [{ id: "verify-pack", required: true, status: "pending" }],
      missing_gates: [{ id: "verify-pack", required: true, status: "pending" }],
      requiresOverride: true,
      overridePromptUrl: `/api/jobs/${jobId}/complete-override`
    }));
  });

  try {
    const port = await listen(server);
    const tool = createTools(workspace, port).get("tracker_job_complete");
    const result = await tool.handler({
      jobId,
      sessionToken: "session-token",
      summary: "done",
      idempotencyKey: "job-complete-1"
    });
    assert.notEqual(result.isError, true);
    assert.equal(sessionToken, "session-token");
    assert.deepEqual(requestBody, { summary: "done", idempotencyKey: "job-complete-1" });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.mode, "gates_pending");
    assert.equal(payload.requiresOverride, true);
    assert.equal(payload.overridePromptUrl, `/api/jobs/${jobId}/complete-override`);
  } finally {
    await closeServer(server);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_job_unblock forwards reason and sessionToken to the HTTP unblock handler", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-job-unblock-");
  const jobId = "job_01h2x3y4z5a6b7c8d9e0f1g2h3";
  let requestBody = null;
  let sessionToken = null;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== `/api/jobs/${jobId}/unblock`) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    sessionToken = req.headers["x-lt-session-token"];
    requestBody = await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      rev: 12,
      eventId: "evt_job_unblocked",
      job: { id: jobId, status: "running" }
    }));
  });

  try {
    const port = await listen(server);
    const tool = createTools(workspace, port).get("tracker_job_unblock");
    const result = await tool.handler({
      jobId,
      sessionToken: "session-token",
      reason: "ready",
      idempotencyKey: "job-unblock-1"
    });
    assert.notEqual(result.isError, true);
    assert.equal(sessionToken, "session-token");
    assert.deepEqual(requestBody, { reason: "ready", idempotencyKey: "job-unblock-1" });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.eventId, "evt_job_unblocked");
    assert.equal(payload.job.id, jobId);
    assert.equal(payload.job.status, "running");
  } finally {
    await closeServer(server);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_job_verify_* tools forward verify pack, run, and resolve requests", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-job-verify-");
  const jobId = "job_01h2x3y4z5a6b7c8d9e0f1g2h3";
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = req.method === "POST" ? await readBody(req) : null;
    requests.push({
      method: req.method,
      url: req.url,
      sessionToken: req.headers["x-lt-session-token"] || null,
      body
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET" && req.url === `/api/jobs/${jobId}/verify-pack`) {
      res.end(JSON.stringify({
        jobId,
        verifyPack: {
          jobId,
          items: [{ id: "cmd.ok", kind: "command", required: true, cmd: "node ok.js", expectExit: 0 }]
        },
        items: [{ id: "cmd.ok", kind: "command", required: true, gate: { status: "pending" } }]
      }));
      return;
    }
    if (req.method === "POST" && req.url === `/api/jobs/${jobId}/verify-pack/items/cmd.ok/run`) {
      res.end(JSON.stringify({
        ok: true,
        mode: "command_completed",
        jobId,
        itemId: "cmd.ok",
        status: "succeeded"
      }));
      return;
    }
    if (req.method === "POST" && req.url === `/api/jobs/${jobId}/verify-pack/items/approve.ship/resolve`) {
      res.end(JSON.stringify({
        ok: true,
        mode: "verify_item_resolved",
        jobId,
        itemId: "approve.ship",
        status: "satisfied"
      }));
      return;
    }
    res.end(JSON.stringify({ error: { code: "UNEXPECTED" } }));
  });

  try {
    const port = await listen(server);
    const tools = createTools(workspace, port);

    const pack = await tools.get("tracker_job_verify_pack").handler({ jobId });
    assert.notEqual(pack.isError, true);
    assert.equal(JSON.parse(pack.content[0].text).jobId, jobId);

    const run = await tools.get("tracker_job_verify_run").handler({
      jobId,
      itemId: "cmd.ok",
      sessionToken: "session-token",
      idempotencyKey: "verify-run-1"
    });
    assert.notEqual(run.isError, true);

    const resolve = await tools.get("tracker_job_verify_resolve").handler({
      jobId,
      itemId: "approve.ship",
      sessionToken: "session-token",
      approved: true,
      reason: "looks good",
      summary: "approved by MCP",
      user: "agent",
      idempotencyKey: "verify-resolve-1"
    });
    assert.notEqual(resolve.isError, true);

    assert.deepEqual(requests, [
      {
        method: "GET",
        url: `/api/jobs/${jobId}/verify-pack`,
        sessionToken: null,
        body: null
      },
      {
        method: "POST",
        url: `/api/jobs/${jobId}/verify-pack/items/cmd.ok/run`,
        sessionToken: "session-token",
        body: { source: "mcp", idempotencyKey: "verify-run-1" }
      },
      {
        method: "POST",
        url: `/api/jobs/${jobId}/verify-pack/items/approve.ship/resolve`,
        sessionToken: "session-token",
        body: {
          source: "mcp",
          approved: true,
          reason: "looks good",
          summary: "approved by MCP",
          user: "agent",
          idempotencyKey: "verify-resolve-1"
        }
      }
    ]);
  } finally {
    await closeServer(server);
    rmSync(workspace, { recursive: true, force: true });
  }
});
