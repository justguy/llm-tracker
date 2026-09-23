import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTools } from "../mcp-tools.js";
import {
  SESSION_BOOTSTRAP_TOOL_NAMES,
  SESSION_TOKEN_REQUIRED_TOOL_NAMES,
} from "../mcp-context-data.js";

const SESSION_ID = "ses_01h2x3y4z5a6b7c8d9e0f1g2h3";
const TARGET_SESSION_ID = "ses_01h2x3y4z5a6b7c8d9e0f1g2h4";
const JOB_ID = "job_01h2x3y4z5a6b7c8d9e0f1g2h3";
const SKILL_RUN_ID = "skr_01h2x3y4z5a6b7c8d9e0f1g2h3";
const SESSION_TOKEN = "session-token";

const MUTATION_CASES = Object.freeze({
  tracker_session_heartbeat: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, status: "active", note: "heartbeat" },
  },
  tracker_session_status: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, status: "quiet", note: "quiet" },
  },
  tracker_session_note: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, note: "note" },
  },
  tracker_session_blocked: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, reason: "blocked" },
  },
  tracker_session_unblocked: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, reason: "ready" },
  },
  tracker_session_handoff: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, summary: "handoff" },
  },
  tracker_session_context_usage: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, percent: 80, used: 800, limit: 1000 },
  },
  tracker_session_complete: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, summary: "done" },
  },
  tracker_session_broadcast: {
    method: "PATCH",
    path: `/api/sessions/${SESSION_ID}`,
    args: { sessionId: SESSION_ID, message: "broadcast" },
  },
  tracker_session_attach_task: {
    method: "POST",
    path: `/api/sessions/${SESSION_ID}/attach-task`,
    args: { sessionId: SESSION_ID, taskId: "t-001", projectSlug: "test-project" },
  },
  tracker_session_ask: {
    method: "POST",
    path: `/api/sessions/${SESSION_ID}/ask`,
    args: { sessionId: SESSION_ID, targetSessionId: TARGET_SESSION_ID, prompt: "question" },
  },
  tracker_session_interrupt: {
    method: "POST",
    path: `/api/sessions/${SESSION_ID}/interrupt`,
    args: { sessionId: SESSION_ID, reason: "stop current turn" },
  },
  tracker_job_start: {
    method: "POST",
    path: "/api/projects/test-project/tasks/t-001/jobs",
    args: {
      projectSlug: "test-project",
      taskId: "t-001",
      sessionId: SESSION_ID,
      profileId: "code-implementer",
      kind: "code",
    },
  },
  tracker_job_checkpoint: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/checkpoint`,
    args: { jobId: JOB_ID, status: "running", summary: "checkpoint" },
  },
  tracker_job_complete: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/complete`,
    args: { jobId: JOB_ID, summary: "done" },
  },
  tracker_job_complete_override: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/complete-override`,
    args: { jobId: JOB_ID, reason: "operator override" },
  },
  tracker_job_rollover: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/rollover`,
    args: { jobId: JOB_ID, reason: "context" },
  },
  tracker_job_unblock: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/unblock`,
    args: { jobId: JOB_ID, reason: "ready" },
  },
  tracker_job_verify_run: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/verify-pack/items/cmd.ok/run`,
    args: { jobId: JOB_ID, itemId: "cmd.ok" },
  },
  tracker_job_verify_resolve: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/verify-pack/items/approve.ship/resolve`,
    args: { jobId: JOB_ID, itemId: "approve.ship", approved: true },
  },
  tracker_skill_run_start: {
    method: "POST",
    path: `/api/jobs/${JOB_ID}/skill-runs`,
    args: { jobId: JOB_ID, skillId: "lt.verify" },
  },
  tracker_skill_run_complete: {
    method: "PATCH",
    path: `/api/jobs/${JOB_ID}/skill-runs/${SKILL_RUN_ID}`,
    args: { jobId: JOB_ID, skillRunId: SKILL_RUN_ID, skillId: "lt.verify" },
  },
  tracker_skill_run_skip: {
    method: "PATCH",
    path: `/api/jobs/${JOB_ID}/skill-runs/${SKILL_RUN_ID}`,
    args: { jobId: JOB_ID, skillRunId: SKILL_RUN_ID, skillId: "lt.verify" },
  },
  tracker_skill_run_fail: {
    method: "PATCH",
    path: `/api/jobs/${JOB_ID}/skill-runs/${SKILL_RUN_ID}`,
    args: { jobId: JOB_ID, skillRunId: SKILL_RUN_ID, skillId: "lt.verify" },
  },
});

function setupWorkspace(prefix = "lt-mcp-phase6-") {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
    mkdirSync(join(workspace, sub), { recursive: true });
  }
  writeFileSync(join(workspace, "README.md"), "# MCP phase 6 acceptance\n");
  return workspace;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw ? JSON.parse(raw) : null));
    req.on("error", reject);
  });
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

function startHub({ rejectInvalidToken = false } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = req.method === "GET" ? null : await readBody(req);
    requests.push({
      method: req.method,
      path: req.url,
      token: req.headers["x-lt-session-token"] || null,
      body,
    });
    if (rejectInvalidToken && req.headers["x-lt-session-token"] === "invalid-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INVALID_SESSION_TOKEN", message: "bad token" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  return { server, requests };
}

function argsWithToken(name, token = SESSION_TOKEN) {
  return { ...MUTATION_CASES[name].args, sessionToken: token };
}

test("Phase 6 acceptance lists every token-required MCP mutation tool", () => {
  assert.deepEqual(Object.keys(MUTATION_CASES), SESSION_TOKEN_REQUIRED_TOOL_NAMES);
});

test("Phase 6 acceptance: every token-required MCP mutation rejects missing token before hub I/O", async () => {
  const workspace = setupWorkspace();
  const tools = createTools(workspace);
  try {
    for (const name of SESSION_TOKEN_REQUIRED_TOOL_NAMES) {
      const result = await tools.get(name).handler(MUTATION_CASES[name].args);
      assert.equal(result.isError, true, `${name} should reject missing sessionToken`);
      assert.match(result.content[0].text, /requires sessionToken/, `${name} should name sessionToken`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Phase 6 acceptance: every token-required MCP mutation maps invalid hub token to MCP error", async () => {
  const workspace = setupWorkspace();
  const { server, requests } = startHub({ rejectInvalidToken: true });
  try {
    const port = await listen(server);
    const tools = createTools(workspace, port);
    for (const name of SESSION_TOKEN_REQUIRED_TOOL_NAMES) {
      await assert.rejects(
        () => tools.get(name).handler(argsWithToken(name, "invalid-token")),
        (err) => {
          assert.match(err.message, /INVALID_SESSION_TOKEN|bad token/, `${name} should surface hub token failure`);
          return true;
        },
      );
    }
    assert.equal(requests.length, SESSION_TOKEN_REQUIRED_TOOL_NAMES.length);
    assert.ok(requests.every((request) => request.token === "invalid-token"));
  } finally {
    await closeServer(server);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Phase 6 acceptance: session bootstrap and token-required MCP mutations have happy paths", async () => {
  const workspace = setupWorkspace();
  const { server, requests } = startHub();
  try {
    const port = await listen(server);
    const tools = createTools(workspace, port);

    for (const name of SESSION_BOOTSTRAP_TOOL_NAMES) {
      const result = await tools.get(name).handler({ name: "phase6", tier: "manual" });
      assert.notEqual(result.isError, true, `${name} should return a normal result`);
    }

    for (const name of SESSION_TOKEN_REQUIRED_TOOL_NAMES) {
      const result = await tools.get(name).handler(argsWithToken(name));
      assert.notEqual(result.isError, true, `${name} should return a normal result`);
    }

    const expected = [
      { method: "POST", path: "/api/sessions", token: null },
      ...SESSION_TOKEN_REQUIRED_TOOL_NAMES.map((name) => ({
        method: MUTATION_CASES[name].method,
        path: MUTATION_CASES[name].path,
        token: SESSION_TOKEN,
      })),
    ];
    assert.deepEqual(
      requests.map(({ method, path, token }) => ({ method, path, token })),
      expected,
    );
  } finally {
    await closeServer(server);
    rmSync(workspace, { recursive: true, force: true });
  }
});
