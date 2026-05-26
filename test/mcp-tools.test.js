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
  SKILL_MUTATION_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  SESSION_TOOL_NAMES,
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

test("tracker_session_* tools are registered with sessionToken arguments", () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-session-");
  try {
    const tools = createTools(workspace);
    for (const name of SESSION_TOOL_NAMES) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.properties.sessionToken, `${name} should carry sessionToken`);
    }

    const runtime = workspaceRuntimePayload(workspace);
    assert.deepEqual(runtime.daemonRule.sessionTools, SESSION_TOOL_NAMES);
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
