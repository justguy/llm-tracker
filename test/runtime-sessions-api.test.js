// test/runtime-sessions-api.test.js — sh-1-09 (TDD v0.5 §6.1, §6.6, §6.10)
//
// Acceptance test for the /api/sessions HTTP routes. Each test stands up a
// fresh Express app on a kernel-assigned port (127.0.0.1, listen(0)) wired
// to a real RuntimeStore + RuntimeProjection; the store's onAppend hook
// drives projection.apply so routes see freshly-appended events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { registerSessionsRoutes } from "../hub/api/sessions.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId, SESSION_ID_RE } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";
import { JobRegistry } from "../hub/jobs/registry.js";
import { SessionTokenStore } from "../hub/sessions/auth/tokens.js";
import { setAuditSink, resetSinks } from "../hub/logging/index.js";

const TEST_TIMEOUT = 8000;

function makeStoreStub(projects) {
  const entries = new Map(Object.entries(projects ?? {}));
  return {
    get(slug) {
      return entries.get(slug) || null;
    },
  };
}

async function startMiniApp({ tokenStore = null, projects = {}, jobRegistry = null, attach = null } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-sessions-api-"));
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appendedEvents.push(event);
      projection.apply(event);
    },
  });
  const effectiveJobRegistry = jobRegistry || new JobRegistry({
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  const app = express();
  app.use(express.json());
  registerSessionsRoutes(app, {
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
    store: makeStoreStub(projects),
    jobRegistry: effectiveJobRegistry,
    ...(attach ? { attach } : {}),
    ...(tokenStore ? { tokenStore } : {}),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    workspaceRoot,
    projection,
    runtimeStore,
    jobRegistry: effectiveJobRegistry,
    appendedEvents,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postJsonWithToken(base, path, body, token) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lt-session-token": token,
    },
    body: JSON.stringify(body),
  });
}

async function patchJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("POST creates a session; GET lists it; GET /:id returns it", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const postRes = await postJson(env.base, "/api/sessions", { name: "smoke", tier: "manual" });
    assert.equal(postRes.status, 201);
    const postBody = await postRes.json();
    assert.ok(postBody.session, "POST response includes session");
    assert.equal(postBody.session.name, "smoke");
    assert.equal(postBody.session.tier, "manual");
    assert.ok(SESSION_ID_RE.test(postBody.session.id), `id ${postBody.session.id} matches ses_ regex`);

    const listRes = await fetch(`${env.base}/api/sessions`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.sessions.length, 1);
    assert.equal(listBody.sessions[0].id, postBody.session.id);

    const getOneRes = await fetch(`${env.base}/api/sessions/${postBody.session.id}`);
    assert.equal(getOneRes.status, 200);
    const getOneBody = await getOneRes.json();
    assert.equal(getOneBody.session.id, postBody.session.id);
    assert.equal(getOneBody.session.name, "smoke");
  } finally {
    await env.close();
  }
});

test("POST 201 returns a valid ses_ id; rev advances to 1", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, "/api/sessions", { name: "rev-check", tier: "mcp_tracked" });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(SESSION_ID_RE.test(body.session.id));
    assert.equal(body.rev, 1, "store rev ticks to 1 after first append");
    assert.match(body.eventId, /^evt_[0-9a-hjkmnp-tv-z]{26}$/);
  } finally {
    await env.close();
  }
});

test("POST 400 when name is missing", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, "/api/sessions", { tier: "manual" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /name/);
  } finally {
    await env.close();
  }
});

test("POST 400 when tier is missing", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, "/api/sessions", { name: "no-tier" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /tier/);
  } finally {
    await env.close();
  }
});

test("POST 400 when tier is invalid", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, "/api/sessions", { name: "bad-tier", tier: "totally-bogus" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /tier/);
  } finally {
    await env.close();
  }
});

test("POST 400 when client supplies an id", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  const auditEvents = [];
  setAuditSink((event) => auditEvents.push(event));
  try {
    const res = await postJson(env.base, "/api/sessions", {
      id: "ses_01h00000000000000000000000",
      name: "client-id",
      tier: "manual",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /id/);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].action, "runtime.session.client_id_rejected");
    assert.equal(auditEvents[0].subject, "session:create");
  } finally {
    resetSinks();
    await env.close();
  }
});

test("POST 400 on unknown body field", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, "/api/sessions", { name: "x", tier: "manual", weirdKey: true });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_FIELDS");
    assert.deepEqual(body.error.details.unknown, ["weirdKey"]);
  } finally {
    await env.close();
  }
});

test("GET /api/sessions/<not-a-session-id> returns 400", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await fetch(`${env.base}/api/sessions/not-a-real-id`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_SESSION_ID");
  } finally {
    await env.close();
  }
});

test("GET /api/sessions/<valid-format-but-unknown> returns 404", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const phantom = makeRuntimeId("ses");
    const res = await fetch(`${env.base}/api/sessions/${phantom}`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_SESSION");
  } finally {
    await env.close();
  }
});

test("PATCH status: 200 + projection reflects new status", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const postRes = await postJson(env.base, "/api/sessions", { name: "patcher", tier: "manual" });
    assert.equal(postRes.status, 201);
    const { session } = await postRes.json();

    const patchRes = await patchJson(env.base, `/api/sessions/${session.id}`, { status: "quiet" });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.session.status, "quiet");
    assert.equal(patchBody.rev, 2);

    const getRes = await fetch(`${env.base}/api/sessions/${session.id}`);
    const getBody = await getRes.json();
    assert.equal(getBody.session.status, "quiet");
  } finally {
    await env.close();
  }
});

test("PATCH contextUsage below threshold updates structured timestamp without warning", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const postRes = await postJson(env.base, "/api/sessions", { name: "context-low", tier: "mcp_tracked" });
    assert.equal(postRes.status, 201);
    const { session } = await postRes.json();

    const patchRes = await patchJson(env.base, `/api/sessions/${session.id}`, {
      status: "active",
      contextUsage: { percent: 84, used: 84000, limit: 100000, source: "mcp" },
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.session.status, "active");
    assert.equal(patchBody.session.statusSource.kind, "mcp");
    assert.deepEqual(patchBody.session.contextUsage, {
      percent: 84,
      used: 84000,
      limit: 100000,
      source: "mcp",
    });
    assert.equal(patchBody.session.lastStructuredEventAt, patchBody.session.lastActivityAt);
    assert.deepEqual(patchBody.session.warnings, []);
    assert.equal(patchBody.warningEventId, undefined);
    assert.equal(patchBody.rev, 2);
  } finally {
    await env.close();
  }
});

test("PATCH contextUsage promotes context_high and emits mcp warning", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const postRes = await postJson(env.base, "/api/sessions", { name: "context", tier: "mcp_tracked" });
    assert.equal(postRes.status, 201);
    const { session } = await postRes.json();

    const patchRes = await patchJson(env.base, `/api/sessions/${session.id}`, {
      status: "active",
      contextUsage: { percent: 85, used: 85000, limit: 100000, source: "mcp" },
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.session.status, "context_high");
    assert.equal(patchBody.session.statusSource.kind, "mcp");
    assert.equal(typeof patchBody.warningEventId, "string");
    assert.deepEqual(patchBody.session.contextUsage, {
      percent: 85,
      used: 85000,
      limit: 100000,
      source: "mcp",
    });
    assert.equal(patchBody.session.lastStructuredEventAt, patchBody.session.lastActivityAt);
    assert.deepEqual(patchBody.session.warnings, [{ kind: "context_high", source: "mcp", percent: 85 }]);
    assert.equal(patchBody.rev, 3);
  } finally {
    await env.close();
  }
});

test("PATCH 400 on invalid status enum", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const postRes = await postJson(env.base, "/api/sessions", { name: "patcher2", tier: "manual" });
    const { session } = await postRes.json();
    const res = await patchJson(env.base, `/api/sessions/${session.id}`, { status: "definitely-not-a-state" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /status/);
  } finally {
    await env.close();
  }
});

test("PATCH 400 on unknown body field", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const postRes = await postJson(env.base, "/api/sessions", { name: "patcher3", tier: "manual" });
    const { session } = await postRes.json();
    const res = await patchJson(env.base, `/api/sessions/${session.id}`, { status: "active", bogus: 1 });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_FIELDS");
    assert.deepEqual(body.error.details.unknown, ["bogus"]);
  } finally {
    await env.close();
  }
});

test("Round-trip POST -> PATCH -> GET: projection reflects both events", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const postRes = await postJson(env.base, "/api/sessions", {
      name: "round-trip",
      tier: "codex_app_server",
      projectSlug: "demo",
      taskId: "t-1",
    });
    assert.equal(postRes.status, 201);
    const { session: created } = await postRes.json();
    assert.equal(created.status, "starting", "session.started seeds status=starting in projection");
    assert.equal(created.projectSlug, "demo");
    assert.equal(created.taskId, "t-1");

    const patchRes = await patchJson(env.base, `/api/sessions/${created.id}`, {
      status: "waiting_for_human",
      comment: "needs review",
    });
    assert.equal(patchRes.status, 200);

    const getRes = await fetch(`${env.base}/api/sessions/${created.id}`);
    const { session, rev } = await getRes.json();
    assert.equal(session.status, "waiting_for_human");
    assert.equal(session.projectSlug, "demo", "POST-supplied projectSlug preserved through PATCH");
    assert.equal(rev, 2);
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/ask emits one session.ask and notifies target session", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({ tokenStore: new SessionTokenStore() });
  try {
    const fromRes = await postJson(env.base, "/api/sessions", { name: "sender", tier: "mcp_tracked" });
    const fromBody = await fromRes.json();
    const targetRes = await postJson(env.base, "/api/sessions", { name: "target", tier: "mcp_tracked" });
    const targetBody = await targetRes.json();

    const askRes = await postJsonWithToken(
      env.base,
      `/api/sessions/${fromBody.session.id}/ask`,
      { targetSessionId: targetBody.session.id, prompt: "Please verify the handoff." },
      fromBody.token.token,
    );
    assert.equal(askRes.status, 200);
    const askBody = await askRes.json();
    assert.equal(askBody.ok, true);
    assert.equal(askBody.ask.from, fromBody.session.id);
    assert.equal(askBody.ask.to, targetBody.session.id);
    assert.equal(askBody.ask.prompt, "Please verify the handoff.");
    assert.equal(askBody.delivery.targetSessionNotification, true);

    const askEvents = env.appendedEvents.filter((event) => event.type === "session.ask");
    assert.equal(askEvents.length, 1);
    assert.equal(askEvents[0].from, fromBody.session.id);
    assert.equal(askEvents[0].to, targetBody.session.id);
    assert.equal(askEvents[0].prompt, "Please verify the handoff.");
    assert.deepEqual(askBody.targetSession.asks, [
      {
        eventId: askBody.eventId,
        from: fromBody.session.id,
        to: targetBody.session.id,
        prompt: "Please verify the handoff.",
        ts: askEvents[0].ts,
      },
    ]);
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/ask rejects missing or mismatched session tokens", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({ tokenStore: new SessionTokenStore() });
  try {
    const fromBody = await (await postJson(env.base, "/api/sessions", { name: "sender", tier: "mcp_tracked" })).json();
    const targetBody = await (await postJson(env.base, "/api/sessions", { name: "target", tier: "mcp_tracked" })).json();
    const otherBody = await (await postJson(env.base, "/api/sessions", { name: "other", tier: "mcp_tracked" })).json();

    const missing = await postJson(env.base, `/api/sessions/${fromBody.session.id}/ask`, {
      targetSessionId: targetBody.session.id,
      prompt: "hello",
    });
    assert.equal(missing.status, 401);

    const mismatch = await postJsonWithToken(
      env.base,
      `/api/sessions/${fromBody.session.id}/ask`,
      { targetSessionId: targetBody.session.id, prompt: "hello" },
      otherBody.token.token,
    );
    assert.equal(mismatch.status, 401);
    assert.equal(env.appendedEvents.filter((event) => event.type === "session.ask").length, 0);
  } finally {
    await env.close();
  }
});

test("POST accepts worktreePath for manual attach sessions", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, "/api/sessions", {
      name: "attach",
      tier: "manual",
      projectSlug: "demo",
      taskId: "t-attach",
      agent: "codex",
      cwd: "/repo",
      repoRoot: "/repo",
      worktreePath: "/repo-wt",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.session.cwd, "/repo");
    assert.equal(body.session.repoRoot, "/repo");
    assert.equal(body.session.worktreePath, "/repo-wt");
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task/preview returns six pure preflight checks", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    attach: { contextOverflowWarnPercent: 0.75 },
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            {
              id: "t-attach",
              title: "Attach me",
              status: "not_started",
              allowed_paths: ["src/**"],
              references: ["src/app.js:10"],
            },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
      worktreePath: "/repo-wt",
    });
    const targetBody = await targetRes.json();
    const otherRes = await postJson(env.base, "/api/sessions", {
      name: "other",
      tier: "manual",
      projectSlug: "demo",
      worktreePath: "/repo-wt",
    });
    assert.equal(otherRes.status, 201);

    const patchRes = await patchJson(env.base, `/api/sessions/${targetBody.session.id}`, {
      status: "active",
      contextUsage: { percent: 80, used: 800, limit: 1000, source: "mcp" },
    });
    assert.equal(patchRes.status, 200);
    const beforePreviewEvents = env.appendedEvents.length;

    const previewRes = await postJson(env.base, `/api/sessions/${targetBody.session.id}/attach-task/preview`, {
      projectSlug: "demo",
      taskId: "t-attach",
      profileId: "code-implementer",
      estBriefTokens: 1,
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();

    assert.equal(preview.checks.length, 6);
    assert.deepEqual(preview.checks.map((item) => item.id), [
      "task_not_already_bound",
      "session_accepts_new_task",
      "task_scope_allowed_paths",
      "profile_compatible",
      "no_worktree_conflict",
      "context_room_available",
    ]);
    assert.equal(preview.hasFail, false);
    assert.equal(preview.hasWarn, true);
    assert.equal(preview.checks.find((item) => item.id === "no_worktree_conflict").status, "warn");
    const contextCheck = preview.checks.find((item) => item.id === "context_room_available");
    assert.equal(contextCheck.status, "warn");
    assert.equal(contextCheck.kind, "attach_context_overflow");
    assert.equal(contextCheck.warnPercent, 0.75);
    assert.equal(env.appendedEvents.length, beforePreviewEvents, "preview must not append runtime events");
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task/preview accepts embedded allowed_paths globs", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            {
              id: "t-globs",
              title: "Glob task",
              status: "not_started",
              allowed_paths: ["src/**/*.js", "*.md"],
              references: ["src/features/app.js:10", "README.md:1"],
            },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const targetBody = await targetRes.json();

    const previewRes = await postJson(env.base, `/api/sessions/${targetBody.session.id}/attach-task/preview`, {
      projectSlug: "demo",
      taskId: "t-globs",
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    const scopeCheck = preview.checks.find((item) => item.id === "task_scope_allowed_paths");
    assert.equal(scopeCheck.status, "ok");
    assert.equal(preview.hasFail, false);
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task/preview reports active binding when tracker task is missing", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    jobRegistry: {
      list() {
        return [
          {
            id: "job_bound",
            sessionId: "ses_bound",
            projectSlug: "demo",
            taskId: "missing-task",
            status: "running",
          },
        ];
      },
    },
    projects: {
      demo: {
        rev: 7,
        data: { tasks: [] },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const targetBody = await targetRes.json();

    const previewRes = await postJson(env.base, `/api/sessions/${targetBody.session.id}/attach-task/preview`, {
      projectSlug: "demo",
      taskId: "missing-task",
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    const bindingCheck = preview.checks.find((item) => item.id === "task_not_already_bound");
    assert.equal(bindingCheck.status, "fail");
    assert.equal(bindingCheck.kind, "task_already_bound_other_session");
    assert.equal(bindingCheck.binding.jobId, "job_bound");
    assert.equal(bindingCheck.binding.sessionId, "ses_bound");
    assert.equal(preview.checks.find((item) => item.id === "task_scope_allowed_paths").status, "fail");
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task/preview fails when projected context exceeds capacity", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            {
              id: "t-context",
              title: "Context task",
              status: "not_started",
            },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const targetBody = await targetRes.json();

    const previewRes = await postJson(env.base, `/api/sessions/${targetBody.session.id}/attach-task/preview`, {
      projectSlug: "demo",
      taskId: "t-context",
      contextBudget: { currentUsed: 950, capacity: 1000, estBriefTokens: 75 },
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    const contextCheck = preview.checks.find((item) => item.id === "context_room_available");
    assert.equal(contextCheck.status, "fail");
    assert.equal(contextCheck.kind, "attach_context_overflow");
    assert.equal(contextCheck.currentUsed, 950);
    assert.equal(contextCheck.estBriefTokens, 75);
    assert.equal(contextCheck.capacity, 1000);
    assert.equal(preview.hasFail, true);
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task/preview returns modal shape for missing resources", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    projects: {
      demo: {
        rev: 7,
        data: { tasks: [] },
      },
    },
  });
  try {
    const previewRes = await postJson(env.base, "/api/sessions/ses_01h2x3y4z5a6b7c8d9e0f1g2h3/attach-task/preview", {
      projectSlug: "demo",
      taskId: "missing-task",
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.equal(preview.checks.length, 6);
    assert.equal(preview.hasFail, true);
    assert.equal(preview.hasWarn, false);
    assert.equal(preview.checks.find((item) => item.id === "session_accepts_new_task").status, "fail");
    assert.equal(preview.checks.find((item) => item.id === "task_scope_allowed_paths").status, "fail");

    const missingProjectRes = await postJson(env.base, "/api/sessions/ses_01h2x3y4z5a6b7c8d9e0f1g2h3/attach-task/preview", {
      projectSlug: "missing-project",
      taskId: "missing-task",
    });
    assert.equal(missingProjectRes.status, 200);
    const missingProject = await missingProjectRes.json();
    assert.equal(missingProject.checks.length, 6);
    assert.equal(missingProject.hasFail, true);
    assert.equal(missingProject.checks.find((item) => item.id === "session_accepts_new_task").status, "fail");
    assert.equal(missingProject.checks.find((item) => item.id === "task_scope_allowed_paths").status, "fail");
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task starts first job and mirrors activeJobId", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            { id: "t-start", title: "Start task", status: "not_started" },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const target = await targetRes.json();

    const attachRes = await postJson(env.base, `/api/sessions/${target.session.id}/attach-task`, {
      projectSlug: "demo",
      taskId: "t-start",
      profileId: "code-implementer",
    });
    assert.equal(attachRes.status, 201);
    const attach = await attachRes.json();
    assert.equal(attach.ok, true);
    assert.equal(attach.mode, "started");
    assert.equal(attach.job.status, "running");
    assert.equal(attach.session.activeJobId, attach.jobId);
    assert.equal(env.jobRegistry.get(attach.jobId).status, "running");
    assert.equal(env.appendedEvents.filter((event) => event.type === "job.started").length, 1);
    assert.equal(env.appendedEvents.filter((event) => event.type === "session.task_attached").length, 1);
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task queues behind an active job", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            { id: "t-first", title: "First task", status: "not_started" },
            { id: "t-second", title: "Second task", status: "not_started" },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const target = await targetRes.json();

    const firstRes = await postJson(env.base, `/api/sessions/${target.session.id}/attach-task`, {
      projectSlug: "demo",
      taskId: "t-first",
    });
    const first = await firstRes.json();
    const secondRes = await postJson(env.base, `/api/sessions/${target.session.id}/attach-task`, {
      projectSlug: "demo",
      taskId: "t-second",
    });
    assert.equal(secondRes.status, 201);
    const second = await secondRes.json();

    assert.equal(second.mode, "queued");
    assert.equal(second.predecessorJobId, first.jobId);
    assert.equal(second.job.status, "queued");
    assert.equal(second.job.predecessorJobId, first.jobId);
    assert.equal(env.jobRegistry.get(first.jobId).successorJobId, second.jobId);
    const session = env.projection.sessions.get(target.session.id);
    assert.equal(session.activeJobId, first.jobId);
    assert.deepEqual(session.queuedJobIds, [second.jobId]);
    assert.equal(env.appendedEvents.filter((event) => event.type === "job.queued").length, 1);
    assert.equal(env.appendedEvents.filter((event) => event.type === "session.task_attached").length, 2);
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task serializes concurrent confirms", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            { id: "t-a", title: "Task A", status: "not_started" },
            { id: "t-b", title: "Task B", status: "not_started" },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const target = await targetRes.json();

    const [aRes, bRes] = await Promise.all([
      postJson(env.base, `/api/sessions/${target.session.id}/attach-task`, {
        projectSlug: "demo",
        taskId: "t-a",
      }),
      postJson(env.base, `/api/sessions/${target.session.id}/attach-task`, {
        projectSlug: "demo",
        taskId: "t-b",
      }),
    ]);
    assert.equal(aRes.status, 201);
    assert.equal(bRes.status, 201);
    const jobs = env.jobRegistry.listBySession(target.session.id);
    assert.equal(jobs.filter((job) => job.status === "running").length, 1);
    assert.equal(jobs.filter((job) => job.status === "queued").length, 1);
  } finally {
    await env.close();
  }
});

test("session queue reorder, cancel, and grace auto-start use queuedJobIds", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    attach: { autoStartQueuedOnCompletionGraceSec: 0.01 },
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            { id: "t-one", title: "One", status: "not_started" },
            { id: "t-two", title: "Two", status: "not_started" },
            { id: "t-three", title: "Three", status: "not_started" },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const target = await targetRes.json();
    const attach = async (taskId) => {
      const res = await postJson(env.base, `/api/sessions/${target.session.id}/attach-task`, {
        projectSlug: "demo",
        taskId,
      });
      assert.equal(res.status, 201);
      return res.json();
    };

    const first = await attach("t-one");
    const second = await attach("t-two");
    const third = await attach("t-three");
    assert.deepEqual(env.projection.sessions.get(target.session.id).queuedJobIds, [second.jobId, third.jobId]);

    const badReorderRes = await postJson(env.base, `/api/sessions/${target.session.id}/queue/reorder`, {
      jobIds: [third.jobId],
    });
    assert.equal(badReorderRes.status, 409);
    const reorderRes = await postJson(env.base, `/api/sessions/${target.session.id}/queue/reorder`, {
      jobIds: [third.jobId, second.jobId],
    });
    assert.equal(reorderRes.status, 200);
    assert.deepEqual(env.projection.sessions.get(target.session.id).queuedJobIds, [third.jobId, second.jobId]);

    await env.jobRegistry.complete(first.jobId, { status: "completed", source: "http" });
    await delay(50);
    assert.equal(env.jobRegistry.get(third.jobId).status, "running");
    assert.equal(env.projection.sessions.get(target.session.id).activeJobId, third.jobId);
    assert.deepEqual(env.projection.sessions.get(target.session.id).queuedJobIds, [second.jobId]);

    const cancelRes = await postJson(env.base, `/api/sessions/${target.session.id}/queue/${second.jobId}/cancel`, {
      summary: "drop successor",
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(env.jobRegistry.get(second.jobId).status, "cancelled");
    assert.deepEqual(env.projection.sessions.get(target.session.id).queuedJobIds, []);
  } finally {
    await env.close();
  }
});

test("POST /api/sessions/:sessionId/attach-task rejects failed preflight", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({
    projects: {
      demo: {
        rev: 7,
        data: {
          tasks: [
            { id: "t-context", title: "Context task", status: "not_started" },
          ],
        },
      },
    },
  });
  try {
    const targetRes = await postJson(env.base, "/api/sessions", {
      name: "target",
      tier: "codex_app_server",
      projectSlug: "demo",
    });
    const target = await targetRes.json();
    const before = env.appendedEvents.length;

    const attachRes = await postJson(env.base, `/api/sessions/${target.session.id}/attach-task`, {
      projectSlug: "demo",
      taskId: "t-context",
      contextBudget: { currentUsed: 950, capacity: 1000, estBriefTokens: 75 },
    });
    assert.equal(attachRes.status, 409);
    const body = await attachRes.json();
    assert.equal(body.error.code, "ATTACH_PREFLIGHT_FAILED");
    assert.equal(body.error.details.preflight.hasFail, true);
    assert.equal(env.appendedEvents.length, before);
  } finally {
    await env.close();
  }
});
