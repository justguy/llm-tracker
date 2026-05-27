// test/conflicts-api.test.js — SH-7-08

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerConflictRoutes } from "../hub/api/conflicts.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

const TEST_TIMEOUT = 8000;

async function startApp({ runtimeEvents = [], projects = new Map([["demo", { data: { tasks: [] } }]]) } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-conflicts-api-"));
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appendedEvents.push(event);
      projection.apply(event);
    },
  });
  const store = {
    get: (slug) => projects.get(slug) || null,
    list: () => [...projects.values()],
  };
  const routes = new Map();
  const app = {
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  };
  registerConflictRoutes(app, {
    store,
    projection,
    getRuntimeEvents: () => runtimeEvents,
    runtimeStore,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  return {
    workspaceRoot,
    projection,
    appendedEvents,
    routes,
    close: async () => {
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

function repoChange(overrides = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-26T16:00:00.000Z",
    type: "repo.change",
    source: "watcher",
    workspace: "/workspace",
    projectSlug: "demo",
    repoRoot: "/repo",
    path: "src/app.js",
    event: "change",
    activeSessionIds: [makeRuntimeId("ses")],
    possibleSessionIds: [],
    attribution: "ambiguous",
    relatedTaskIds: ["task-1"],
    ...overrides,
  };
}

function sessionStarted(sessionId, workspaceRoot, overrides = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-26T16:00:00.000Z",
    type: "session.started",
    source: "ui",
    workspace: workspaceRoot,
    session: {
      id: sessionId,
      name: `session-${sessionId}`,
      tier: "manual",
      projectSlug: "demo",
      taskId: "task-1",
      repoRoot: "/repo",
      worktreePath: "/repo",
      ...overrides,
    },
  };
}

async function callRoute(env, method, path, { params = {}, body = {}, query = {} } = {}) {
  const handler = env.routes.get(`${method} ${path}`);
  assert.equal(typeof handler, "function", `missing route ${method} ${path}`);
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  await handler({ params, body, query }, res);
  return { status: res.statusCode, body: res.body };
}

test("GET /api/projects/:slug/session-conflicts returns project conflicts", { timeout: TEST_TIMEOUT }, async () => {
  const sesA = makeRuntimeId("ses");
  const sesB = makeRuntimeId("ses");
  const env = await startApp({
    runtimeEvents: [
      repoChange({ activeSessionIds: [sesA], possibleSessionIds: [sesA] }),
      repoChange({ activeSessionIds: [sesB], possibleSessionIds: [sesB] }),
      repoChange({ projectSlug: "other", path: "src/app.js", activeSessionIds: [makeRuntimeId("ses")] }),
    ],
  });
  try {
    const { status, body } = await callRoute(env, "GET", "/api/projects/:slug/session-conflicts", {
      params: { slug: "demo" },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.projectSlug, "demo");
    assert.equal(body.conflictCount, 1);
    assert.equal(body.conflicts[0].kind, "multiple_sessions_same_file");
    assert.deepEqual(body.conflicts[0].activeSessionIds, [sesA, sesB]);
  } finally {
    await env.close();
  }
});

test("GET /api/sessions/:sessionId/conflicts returns conflicts mentioning the session", { timeout: TEST_TIMEOUT }, async () => {
  const sesA = makeRuntimeId("ses");
  const sesB = makeRuntimeId("ses");
  const env = await startApp({
    runtimeEvents: [
      repoChange({ activeSessionIds: [sesA], possibleSessionIds: [sesA] }),
      repoChange({ activeSessionIds: [sesB], possibleSessionIds: [sesB] }),
    ],
  });
  try {
    env.projection.apply(sessionStarted(sesA, env.workspaceRoot));
    const { status, body } = await callRoute(env, "GET", "/api/sessions/:sessionId/conflicts", {
      params: { sessionId: sesA },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.sessionId, sesA);
    assert.equal(body.conflictCount, 1);
    assert.equal(body.conflicts[0].kind, "multiple_sessions_same_file");
  } finally {
    await env.close();
  }
});

test("POST /api/conflicts/:conflictId/ack appends conflict.ack runtime event", { timeout: TEST_TIMEOUT }, async () => {
  const sesA = makeRuntimeId("ses");
  const sesB = makeRuntimeId("ses");
  const env = await startApp({
    runtimeEvents: [
      repoChange({ activeSessionIds: [sesA], possibleSessionIds: [sesA] }),
      repoChange({ activeSessionIds: [sesB], possibleSessionIds: [sesB] }),
    ],
  });
  try {
    const conflicts = await callRoute(env, "GET", "/api/projects/:slug/session-conflicts", {
      params: { slug: "demo" },
    });
    const conflictId = conflicts.body.conflicts[0].conflictId;

    const { status, body } = await callRoute(env, "POST", "/api/conflicts/:conflictId/ack", {
      params: { conflictId },
      body: {
        reason: "reviewed by operator",
        actor: "codex-test",
        idempotencyKey: "ack-1",
      },
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.event.type, "conflict.ack");
    assert.equal(body.event.conflictId, conflictId);
    assert.equal(body.event.reason, "reviewed by operator");
    assert.equal(body.event.actor, "codex-test");
    assert.equal(body.event.source, "http");
    assert.equal(typeof body.event.acknowledgedAt, "string");
    assert.match(body.eventId, /^evt_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(env.appendedEvents.length, 1);
    assert.equal(env.appendedEvents[0].type, "conflict.ack");
  } finally {
    await env.close();
  }
});

test("conflict routes reject invalid requests", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const missingProject = await callRoute(env, "GET", "/api/projects/:slug/session-conflicts", {
      params: { slug: "missing" },
    });
    assert.equal(missingProject.status, 404);
    assert.equal(missingProject.body.error.code, "PROJECT_NOT_FOUND");

    const badSessionId = await callRoute(env, "GET", "/api/sessions/:sessionId/conflicts", {
      params: { sessionId: "not-a-session" },
    });
    assert.equal(badSessionId.status, 400);
    assert.equal(badSessionId.body.error.code, "INVALID_SESSION_ID");

    const unknownSession = await callRoute(env, "GET", "/api/sessions/:sessionId/conflicts", {
      params: { sessionId: makeRuntimeId("ses") },
    });
    assert.equal(unknownSession.status, 404);
    assert.equal(unknownSession.body.error.code, "UNKNOWN_SESSION");

    const badConflictId = await callRoute(env, "POST", "/api/conflicts/:conflictId/ack", {
      params: { conflictId: "not-a-conflict" },
      body: { reason: "reviewed" },
    });
    assert.equal(badConflictId.status, 400);
    assert.equal(badConflictId.body.error.code, "INVALID_CONFLICT_ID");

    const missingReason = await callRoute(env, "POST", "/api/conflicts/:conflictId/ack", {
      params: { conflictId: "cf_multiple_sessions_same_file_123456789abc" },
      body: {},
    });
    assert.equal(missingReason.status, 400);
    assert.equal(missingReason.body.error.code, "INVALID_BODY");
  } finally {
    await env.close();
  }
});
