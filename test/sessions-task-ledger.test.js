// test/sessions-task-ledger.test.js — SH-2-25 (TDD v0.5 §6.1)
//
// Contract tests for the derived SessionTaskLedgerService view-model and its
// HTTP route. The ledger is computed from SessionRecord + JobRecord +
// candidate suggestions; it must never persist `boundTasks` back onto a
// SessionRecord.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { registerSessionsRoutes } from "../hub/api/sessions.js";
import { SessionTaskLedgerService } from "../hub/sessions/task-ledger.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

const TEST_TIMEOUT = 8000;

const SESSION_ID = "ses_01h2x3y4z5a6b7c8d9e0f1g2h3";
const UNKNOWN_SESSION_ID = "ses_01h2x3y4z5a6b7c8d9e0f1g2h4";
const JOB_ACTIVE = "job_01h2x3y4z5a6b7c8d9e0f1g2h3";
const JOB_QUEUED = "job_01h2x3y4z5a6b7c8d9e0f1g2h4";
const JOB_DONE = "job_01h2x3y4z5a6b7c8d9e0f1g2h5";
const JOB_OTHER_SESSION = "job_01h2x3y4z5a6b7c8d9e0f1g2h6";

const TASKS = [
  task("active-task", "in_progress"),
  task("queued-task", "not_started"),
  task("completed-task", "complete"),
  task("suggested-task", "not_started"),
  task("mentioned-task", "not_started"),
];

function task(id, status) {
  return {
    id,
    title: id,
    status,
    placement: { priorityId: "p1", swimlaneId: "lane" },
    dependencies: [],
  };
}

function seedProjection() {
  const projection = new RuntimeProjection();
  projection.sessions.set(SESSION_ID, {
    id: SESSION_ID,
    name: "ledger",
    tier: "manual",
    projectSlug: "demo",
    taskId: "mentioned-task",
    activeJobId: JOB_ACTIVE,
    queuedJobIds: [JOB_QUEUED],
    status: "active",
    warnings: [],
  });
  projection.sessionOrder.push(SESSION_ID);
  projection.jobs.set(JOB_ACTIVE, {
    id: JOB_ACTIVE,
    sessionId: SESSION_ID,
    projectSlug: "demo",
    taskId: "active-task",
    status: "running",
  });
  projection.jobs.set(JOB_QUEUED, {
    id: JOB_QUEUED,
    sessionId: SESSION_ID,
    projectSlug: "demo",
    taskId: "queued-task",
    status: "queued",
    predecessorJobId: JOB_ACTIVE,
  });
  projection.jobs.set(JOB_DONE, {
    id: JOB_DONE,
    sessionId: SESSION_ID,
    projectSlug: "demo",
    taskId: "completed-task",
    status: "completed",
  });
  projection.jobOrder.push(JOB_ACTIVE, JOB_QUEUED, JOB_DONE);
  return projection;
}

function makeLedgerService(projection, overrides = {}) {
  return new SessionTaskLedgerService({
    projection,
    getTasksForProject: (projectSlug) => (projectSlug === "demo" ? TASKS : []),
    getRunCandidates: () => [
      { projectSlug: "demo", taskId: "active-task", score: 999 },
      { projectSlug: "demo", taskId: "queued-task", score: 900 },
      { projectSlug: "demo", taskId: "completed-task", score: 800 },
      { projectSlug: "demo", taskId: "suggested-task", score: 700 },
    ],
    ...overrides,
  });
}

async function startMiniApp() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-sessions-task-ledger-"));
  const projection = seedProjection();
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => projection.apply(event),
  });
  const taskLedgerService = makeLedgerService(projection);
  const app = express();
  app.use(express.json());
  registerSessionsRoutes(app, {
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
    taskLedgerService,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    projection,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

test("SessionTaskLedgerService: projects active_job, queued_next, completed_in_session, suggested_next, and mentioned", async () => {
  const projection = seedProjection();
  const service = makeLedgerService(projection);

  const items = await service.getLedger(SESSION_ID);

  assert.deepEqual(items, [
    {
      taskId: "active-task",
      jobId: JOB_ACTIVE,
      relation: "active_job",
      taskStatus: "in_progress",
      source: "job_registry",
    },
    {
      taskId: "queued-task",
      jobId: JOB_QUEUED,
      relation: "queued_next",
      taskStatus: "not_started",
      source: "tracker_queue",
    },
    {
      taskId: "completed-task",
      jobId: JOB_DONE,
      relation: "completed_in_session",
      taskStatus: "complete",
      source: "job_registry",
    },
    {
      taskId: "suggested-task",
      relation: "suggested_next",
      taskStatus: "not_started",
      source: "recommendation",
    },
    {
      taskId: "mentioned-task",
      relation: "mentioned",
      taskStatus: "not_started",
      source: "human",
    },
  ]);
});

test("SessionTaskLedgerService: dedupes by taskId using active > queued > completed > suggested > mentioned precedence", async () => {
  const projection = seedProjection();
  const session = projection.sessions.get(SESSION_ID);
  projection.sessions.set(SESSION_ID, { ...session, taskId: "active-task" });
  const service = makeLedgerService(projection, {
    getRunCandidates: () => [
      { projectSlug: "demo", taskId: "active-task", score: 500 },
      { projectSlug: "demo", taskId: "queued-task", score: 400 },
      { projectSlug: "demo", taskId: "completed-task", score: 300 },
    ],
  });

  const items = await service.getLedger(SESSION_ID);

  assert.deepEqual(
    items.map((item) => [item.taskId, item.relation, item.source]),
    [
      ["active-task", "active_job", "job_registry"],
      ["queued-task", "queued_next", "tracker_queue"],
      ["completed-task", "completed_in_session", "job_registry"],
    ],
  );
});

test("SessionTaskLedgerService: ignores stale or cross-session active/queued mirror ids", async () => {
  const projection = seedProjection();
  const session = projection.sessions.get(SESSION_ID);
  projection.sessions.set(SESSION_ID, {
    ...session,
    activeJobId: JOB_DONE,
    queuedJobIds: [JOB_DONE, JOB_OTHER_SESSION],
  });
  projection.jobs.set(JOB_OTHER_SESSION, {
    id: JOB_OTHER_SESSION,
    sessionId: UNKNOWN_SESSION_ID,
    projectSlug: "demo",
    taskId: "other-session-task",
    status: "queued",
  });
  projection.jobOrder.push(JOB_OTHER_SESSION);
  const service = makeLedgerService(projection);

  const items = await service.getLedger(SESSION_ID);

  assert.deepEqual(
    items.map((item) => [item.taskId, item.jobId, item.relation]),
    [
      ["active-task", JOB_ACTIVE, "active_job"],
      ["queued-task", JOB_QUEUED, "queued_next"],
      ["completed-task", JOB_DONE, "completed_in_session"],
      ["suggested-task", undefined, "suggested_next"],
      ["mentioned-task", undefined, "mentioned"],
    ],
  );
});

test("SessionTaskLedgerService: computing the ledger never persists boundTasks or mutates SessionRecord", async () => {
  const projection = seedProjection();
  const service = makeLedgerService(projection);
  const before = structuredClone(projection.sessions.get(SESSION_ID));

  await service.getLedger(SESSION_ID);

  assert.deepEqual(projection.sessions.get(SESSION_ID), before);
  assert.equal(projection.sessions.get(SESSION_ID).boundTasks, undefined);
  const snapshotSession = projection.toSnapshots().sessions.find((session) => session.id === SESSION_ID);
  assert.equal(snapshotSession.boundTasks, undefined);
});

test("GET /api/sessions/:sessionId/task-ledger returns the computed task ledger", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await fetch(`${env.base}/api/sessions/${SESSION_ID}/task-ledger`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessionId, SESSION_ID);
    assert.equal(body.rev, env.projection.rev);
    assert.deepEqual(body.taskLedger, await makeLedgerService(env.projection).getLedger(SESSION_ID));
  } finally {
    await env.close();
  }
});

test("GET /api/sessions/:sessionId/task-ledger returns 400 for a bad session id", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await fetch(`${env.base}/api/sessions/not-a-session/task-ledger`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_SESSION_ID");
  } finally {
    await env.close();
  }
});

test("GET /api/sessions/:sessionId/task-ledger returns 404 for an unknown session", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await fetch(`${env.base}/api/sessions/${UNKNOWN_SESSION_ID}/task-ledger`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_SESSION");
  } finally {
    await env.close();
  }
});
