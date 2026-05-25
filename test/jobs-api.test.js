// test/jobs-api.test.js — SH-5-09 (TDD v0.5 §12.2, §11.5.1)
//
// Acceptance suite for the Job lifecycle HTTP routes. Each test stands up a
// fresh Express app on a kernel-assigned port wired to a real RuntimeStore +
// RuntimeProjection + JobRegistry (mirrors test/jobs-registry.test.js for
// env wiring; mirrors test/run-session-endpoints.test.js for HTTP harness).
//
// Out-of-scope-but-noted: hub/server.js wiring is deliberately untouched —
// SH-5-09 reserves the route module; orchestration of the route lands in a
// later follow-up commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { registerJobsRoutes } from "../hub/api/jobs.js";
import { JobRegistry } from "../hub/jobs/registry.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

const SES = "ses_01h2x3y4z5a6b7c8d9e0f1g2h3";
const GHOST_JOB = "job_01h2x3y4z5a6b7c8d9e0f1ghst";

async function startApp() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-jobs-api-"));
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appendedEvents.push(event);
      projection.apply(event);
    },
  });
  const jobRegistry = new JobRegistry({
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  const app = express();
  app.use(express.json());
  registerJobsRoutes(app, { jobRegistry });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    jobRegistry,
    projection,
    appendedEvents,
    close: async () => {
      await new Promise((r) => server.close(() => r()));
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

function validJobInput(overrides = {}) {
  return {
    sessionId: SES,
    projectSlug: "demo",
    taskId: "t-1",
    profileId: "code-implementer",
    kind: "code",
    ...overrides,
  };
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function postJson(base, path, body) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function patchJson(base, path, body) {
  const init = {
    method: "PATCH",
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// --- constructor wiring -----------------------------------------------------

test("registerJobsRoutes: rejects missing deps", () => {
  const app = express();
  assert.throws(() => registerJobsRoutes(null, {}), /express app required/);
  assert.throws(() => registerJobsRoutes(app, {}), /jobRegistry/);
  assert.throws(() => registerJobsRoutes(app, { jobRegistry: {} }), /jobRegistry/);
});

// --- GET /api/jobs ----------------------------------------------------------

test("GET /api/jobs returns [] when projection is empty, then echoes registry.list()", async () => {
  const app = await startApp();
  try {
    const empty = await getJson(app.base, "/api/jobs");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { jobs: [] });

    const created = await app.jobRegistry.create(validJobInput());
    const populated = await getJson(app.base, "/api/jobs");
    assert.equal(populated.status, 200);
    assert.equal(populated.body.jobs.length, 1);
    assert.equal(populated.body.jobs[0].id, created.jobId);
    assert.equal(populated.body.jobs[0].status, "running");
    assert.deepEqual(populated.body.jobs, app.jobRegistry.list());
  } finally {
    await app.close();
  }
});

// --- GET /api/jobs/:jobId ---------------------------------------------------

test("GET /api/jobs/:jobId returns the JobRecord on happy path", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await getJson(app.base, `/api/jobs/${created.jobId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, created.jobId);
    assert.equal(r.body.sessionId, SES);
    assert.equal(r.body.taskId, "t-1");
    assert.equal(r.body.status, "running");
  } finally {
    await app.close();
  }
});

test("GET /api/jobs/:jobId — malformed id is 400 INVALID_JOB_ID; well-formed unknown is 404 JOB_NOT_FOUND", async () => {
  const app = await startApp();
  try {
    const malformed = await getJson(app.base, "/api/jobs/not-a-job-id");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_JOB_ID");

    const ghost = await getJson(app.base, `/api/jobs/${GHOST_JOB}`);
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.error.code, "JOB_NOT_FOUND");
  } finally {
    await app.close();
  }
});

// --- POST /:id/checkpoint ---------------------------------------------------

test("POST /api/jobs/:id/checkpoint — happy path returns { rev, eventId, job }", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await postJson(app.base, `/api/jobs/${created.jobId}/checkpoint`, {
      status: "blocked",
      summary: "waiting on review",
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.eventId, "string");
    assert.equal(typeof r.body.rev, "number");
    assert.equal(r.body.job.id, created.jobId);
    assert.equal(r.body.job.status, "blocked");
    assert.equal(r.body.job.lastCheckpointSummary, "waiting on review");

    const cps = app.appendedEvents.filter((e) => e.type === "job.checkpoint");
    assert.equal(cps.length, 1);
    assert.equal(cps[0].source, "http");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/checkpoint — terminal job is 409 JOB_TERMINAL; unknown is 404; invalid status is 400", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());

    const bad = await postJson(app.base, `/api/jobs/${created.jobId}/checkpoint`, { status: "nope" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_JOB_STATUS");

    // Terminal status on /checkpoint is rejected as TERMINAL_STATUS_FORBIDDEN.
    const terminal = await postJson(app.base, `/api/jobs/${created.jobId}/checkpoint`, { status: "completed" });
    assert.equal(terminal.status, 400);
    assert.equal(terminal.body.error.code, "TERMINAL_STATUS_FORBIDDEN");

    const unknown = await postJson(app.base, `/api/jobs/${GHOST_JOB}/checkpoint`, { status: "running" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "JOB_NOT_FOUND");

    // Drive the job to a real terminal state, then verify /checkpoint -> 409.
    await app.jobRegistry.complete(created.jobId, { status: "completed" });
    const onTerminal = await postJson(app.base, `/api/jobs/${created.jobId}/checkpoint`, { status: "running" });
    assert.equal(onTerminal.status, 409);
    assert.equal(onTerminal.body.error.code, "JOB_TERMINAL");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/checkpoint — non-object body is 400 INVALID_BODY", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await postJson(app.base, `/api/jobs/${created.jobId}/checkpoint`, [1, 2, 3]);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});

// --- POST /:id/complete -----------------------------------------------------

test("POST /api/jobs/:id/complete — no gates: returns { ok: true, mode: 'completed', jobId }; double-complete is 409", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, mode: "completed", jobId: created.jobId });

    const evts = app.appendedEvents.filter((e) => e.type === "job.completed");
    assert.equal(evts.length, 1);
    assert.equal(evts[0].source, "http");

    const again = await postJson(app.base, `/api/jobs/${created.jobId}/complete`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "JOB_TERMINAL");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete — body omitted entirely is OK (body optional)", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.mode, "completed");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete — missing required gates: HTTP 200 with gates_pending union variant", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const evidenceRef = makeRuntimeId("evt");

    // Inject completionGates directly onto the projection record. SH-5-04 will
    // populate this slot via the verify pack; until then the route inspects
    // whatever the projection currently exposes.
    const record = app.projection.jobs.get(created.jobId);
    record.completionGates = [
      { id: "g-required-pending", kind: "verify_pack", required: true, status: "pending" },
      { id: "g-required-satisfied", kind: "dod_checked", required: true, status: "satisfied", evidenceRef },
      { id: "g-optional-pending", kind: "verify_pack", required: false, status: "pending" },
      {
        id: "g-overridden",
        kind: "verify_pack",
        required: true,
        status: "overridden",
        evidenceRef,
        overrideReason: "operator accepted",
      },
    ];

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete`, {});
    assert.equal(r.status, 200, "gates_pending is a normal flow — HTTP 200, not 4xx");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.mode, "gates_pending");
    assert.equal(r.body.requiresOverride, true);
    assert.equal(r.body.uiCompleteMode, "block_required_missing");
    assert.equal(r.body.overridePromptUrl, `/api/jobs/${created.jobId}/complete-override`);
    assert.equal(r.body.missing.length, 1);
    assert.deepEqual(r.body.missing_gates, r.body.missing);
    assert.equal(r.body.missing[0].id, "g-required-pending");
    assert.equal(r.body.missing[0].required, true);

    // No job.completed event was emitted (the route short-circuits).
    assert.equal(app.appendedEvents.filter((e) => e.type === "job.completed").length, 0);
    assert.equal(app.jobRegistry.get(created.jobId).status, "running");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete — satisfied gate without evidenceRef is still blocked", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const record = app.projection.jobs.get(created.jobId);
    record.completionGates = [
      { id: "g-ui-flipped", kind: "verify_pack", required: true, status: "satisfied" },
    ];

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.mode, "gates_pending");
    assert.equal(r.body.missing[0].id, "g-ui-flipped");
    assert.equal(app.appendedEvents.filter((e) => e.type === "job.completed").length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete — rejects unknown uiCompleteMode", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete`, {
      uiCompleteMode: "silent_complete",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete-override — reason required", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const record = app.projection.jobs.get(created.jobId);
    record.completionGates = [
      { id: "g-required", kind: "verify_pack", required: true, status: "pending" },
    ];

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete-override`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
    assert.equal(app.appendedEvents.filter((e) => e.type === "human.override").length, 0);
    assert.equal(app.jobRegistry.get(created.jobId).status, "running");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete-override — records HumanOverrideEvent, binds gates, completes", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const record = app.projection.jobs.get(created.jobId);
    record.completionGates = [
      { id: "g-required", kind: "verify_pack", required: true, status: "pending" },
      { id: "g-optional", kind: "verify_pack", required: false, status: "pending" },
    ];

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete-override`, {
      reason: "operator accepted missing verify evidence",
      user: "user:adi",
      summary: "completed by human override",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.mode, "completed_via_override");
    assert.equal(r.body.jobId, created.jobId);
    assert.match(r.body.overrideEventId, /^evt_/);

    const overrideEvent = app.appendedEvents.find((e) => e.type === "human.override");
    assert.ok(overrideEvent);
    assert.equal(overrideEvent.id, r.body.overrideEventId);
    assert.equal(overrideEvent.jobId, created.jobId);
    assert.deepEqual(overrideEvent.gateIds, ["g-required"]);
    assert.equal(overrideEvent.reason, "operator accepted missing verify evidence");
    assert.equal(overrideEvent.user, "user:adi");
    assert.equal(overrideEvent.context.kind, "complete_override");
    assert.equal(overrideEvent.context.sessionId, SES);
    assert.equal(overrideEvent.context.projectSlug, "demo");
    assert.equal(overrideEvent.context.taskId, "t-1");
    assert.deepEqual(overrideEvent.overriddenGates, [
      {
        id: "g-required",
        kind: "verify_pack",
        required: true,
        status: "overridden",
        overrideReason: "operator accepted missing verify evidence",
      },
    ]);

    const completedEvents = app.appendedEvents.filter((e) => e.type === "job.completed");
    assert.equal(completedEvents.length, 1);
    assert.equal(completedEvents[0].status, "completed");

    const job = app.jobRegistry.get(created.jobId);
    assert.equal(job.status, "completed");
    assert.equal(job.summary, "completed by human override");
    assert.deepEqual(job.completionGates[0], {
      id: "g-required",
      kind: "verify_pack",
      required: true,
      status: "overridden",
      evidenceRef: r.body.overrideEventId,
      overrideReason: "operator accepted missing verify evidence",
    });
    assert.deepEqual(job.completionGates[1], {
      id: "g-optional",
      kind: "verify_pack",
      required: false,
      status: "pending",
    });

    const replay = new RuntimeProjection();
    for (const event of app.appendedEvents) replay.apply(event);
    const replayedJob = replay.jobs.get(created.jobId);
    assert.equal(replayedJob.status, "completed");
    assert.deepEqual(replayedJob.completionGates, [
      {
        id: "g-required",
        kind: "verify_pack",
        required: true,
        status: "overridden",
        evidenceRef: r.body.overrideEventId,
        overrideReason: "operator accepted missing verify evidence",
      },
    ]);
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete-override — terminal job rejects before recording override", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const record = app.projection.jobs.get(created.jobId);
    record.completionGates = [
      { id: "g-required", kind: "verify_pack", required: true, status: "pending" },
    ];
    await app.jobRegistry.cancel(created.jobId, { summary: "cancelled first" });
    const eventCountBefore = app.appendedEvents.length;

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/complete-override`, {
      reason: "late operator override",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "JOB_TERMINAL");
    assert.equal(app.appendedEvents.length, eventCountBefore);
    assert.equal(app.appendedEvents.filter((e) => e.type === "human.override").length, 0);
    assert.deepEqual(app.jobRegistry.get(created.jobId).completionGates, [
      { id: "g-required", kind: "verify_pack", required: true, status: "pending" },
    ]);
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/complete — unknown job is 404 JOB_NOT_FOUND; malformed id is 400", async () => {
  const app = await startApp();
  try {
    const ghost = await postJson(app.base, `/api/jobs/${GHOST_JOB}/complete`, {});
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.error.code, "JOB_NOT_FOUND");

    const malformed = await postJson(app.base, `/api/jobs/not-a-job/complete`, {});
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_JOB_ID");
  } finally {
    await app.close();
  }
});

// --- POST /:id/cancel -------------------------------------------------------

test("POST /api/jobs/:id/cancel — happy path; subsequent /checkpoint returns 409 JOB_TERMINAL", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await postJson(app.base, `/api/jobs/${created.jobId}/cancel`, { summary: "user-cancelled" });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.eventId, "string");
    assert.equal(typeof r.body.rev, "number");
    assert.equal(r.body.job.status, "cancelled");
    assert.equal(r.body.job.summary, "user-cancelled");

    const cps = await postJson(app.base, `/api/jobs/${created.jobId}/checkpoint`, { status: "running" });
    assert.equal(cps.status, 409);
    assert.equal(cps.body.error.code, "JOB_TERMINAL");
  } finally {
    await app.close();
  }
});

// --- POST /:id/rollover -----------------------------------------------------

test("POST /api/jobs/:id/rollover — emits job.rollover_requested; job is NOT terminal; second call succeeds", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r1 = await postJson(app.base, `/api/jobs/${created.jobId}/rollover`, { reason: "context_pressure" });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.job.rolloverReason, "context_pressure");
    assert.notEqual(r1.body.job.status, "rolled_over");

    const evts1 = app.appendedEvents.filter((e) => e.type === "job.rollover_requested");
    assert.equal(evts1.length, 1);
    assert.equal(evts1[0].source, "http");

    const r2 = await postJson(app.base, `/api/jobs/${created.jobId}/rollover`, { reason: "second_pass" });
    assert.equal(r2.status, 200);
    assert.equal(
      app.appendedEvents.filter((e) => e.type === "job.rollover_requested").length,
      2,
    );
  } finally {
    await app.close();
  }
});

// --- POST /:id/unblock ------------------------------------------------------
// SH-5-16: /unblock route. Mirrors the registry-level cases but through HTTP.

test("POST /api/jobs/:id/unblock — happy path on a blocked job → 200 { rev, eventId, job:running }", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    await app.jobRegistry.checkpoint(created.jobId, { status: "blocked" });

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/unblock`, {});
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.eventId, "string");
    assert.equal(typeof r.body.rev, "number");
    assert.equal(r.body.job.id, created.jobId);
    assert.equal(r.body.job.status, "running");

    const evts = app.appendedEvents.filter((e) => e.type === "job.unblocked");
    assert.equal(evts.length, 1);
    assert.equal(evts[0].source, "http");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/unblock — `reason` body field rides through into the job.unblocked event", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    await app.jobRegistry.checkpoint(created.jobId, { status: "blocked", summary: "waiting on review" });

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/unblock`, {
      reason: "approved by maintainer",
      previousReason: "waiting on review",
    });
    assert.equal(r.status, 200);

    const evt = app.appendedEvents.find((e) => e.type === "job.unblocked");
    assert.ok(evt, "job.unblocked event was emitted");
    assert.equal(evt.reason, "approved by maintainer");
    assert.equal(evt.previousReason, "waiting on review");
    assert.equal(evt.source, "http");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/unblock — non-blocked job → 409 INVALID_JOB_STATE with current status in details", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    // Job is currently 'running', not 'blocked'.
    const r = await postJson(app.base, `/api/jobs/${created.jobId}/unblock`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "INVALID_JOB_STATE");
    assert.equal(r.body.error.details.status, "running");
    assert.equal(r.body.error.details.jobId, created.jobId);

    // No event was appended.
    assert.equal(app.appendedEvents.filter((e) => e.type === "job.unblocked").length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/unblock — body with `user` field → 400 UNKNOWN_FIELDS (no auth surface yet)", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    await app.jobRegistry.checkpoint(created.jobId, { status: "blocked" });

    const r = await postJson(app.base, `/api/jobs/${created.jobId}/unblock`, {
      reason: "ok",
      user: "u_alice",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "UNKNOWN_FIELDS");
    assert.deepEqual(r.body.error.details.unknown, ["user"]);

    // No event was appended (validation short-circuits before registry).
    assert.equal(app.appendedEvents.filter((e) => e.type === "job.unblocked").length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/unblock — malformed jobId → 400 INVALID_JOB_ID", async () => {
  const app = await startApp();
  try {
    const r = await postJson(app.base, `/api/jobs/not-a-job/unblock`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_JOB_ID");
  } finally {
    await app.close();
  }
});

test("POST /api/jobs/:id/unblock — predecessor still running → returned job.status === 'queued'", async () => {
  const app = await startApp();
  try {
    const pred = await app.jobRegistry.create(validJobInput({ taskId: "t-pred" }));
    const succ = await app.jobRegistry.create(
      validJobInput({ taskId: "t-succ", predecessorJobId: pred.jobId }),
    );
    // Drive successor to blocked (it starts queued because of predecessor).
    await app.jobRegistry.checkpoint(succ.jobId, { status: "blocked", summary: "ext dep" });

    const r = await postJson(app.base, `/api/jobs/${succ.jobId}/unblock`, { reason: "manual override" });
    assert.equal(r.status, 200);
    assert.equal(r.body.job.status, "queued", "predecessor still active → unblock re-queues");

    // The HTTP layer sees both events emitted (unblock + auto-requeue checkpoint).
    const tail = app.appendedEvents.slice(-2);
    assert.equal(tail[0].type, "job.unblocked");
    assert.equal(tail[1].type, "job.checkpoint");
    assert.equal(tail[1].status, "queued");
    assert.equal(tail[1].source, "http");
  } finally {
    await app.close();
  }
});

// --- GET /:id/context-pack --------------------------------------------------

test("GET /api/jobs/:id/context-pack?kind=start returns 501 NOT_IMPLEMENTED", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await getJson(app.base, `/api/jobs/${created.jobId}/context-pack?kind=start`);
    assert.equal(r.status, 501);
    assert.equal(r.body.error.code, "NOT_IMPLEMENTED");
    assert.match(r.body.error.message, /SH-8-02/);
  } finally {
    await app.close();
  }
});

test("GET /api/jobs/:id/context-pack rejects malformed jobId before stubbing 501", async () => {
  const app = await startApp();
  try {
    const r = await getJson(app.base, "/api/jobs/not-a-job/context-pack?kind=start");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_JOB_ID");
  } finally {
    await app.close();
  }
});

// --- POST /api/projects/:slug/tasks/:taskId/jobs (SH-5-18) ------------------

test("POST /api/projects/:slug/tasks/:taskId/jobs — happy path: 201, registry.list contains it, job.started emitted", async () => {
  const app = await startApp();
  try {
    const r = await postJson(app.base, "/api/projects/demo/tasks/t-1/jobs", {
      sessionId: SES,
      profileId: "code-implementer",
      kind: "code",
    });
    assert.equal(r.status, 201);
    assert.equal(typeof r.body.jobId, "string");
    assert.match(r.body.jobId, /^job_/);
    assert.equal(typeof r.body.rev, "number");
    assert.equal(typeof r.body.eventId, "string");
    assert.equal(r.body.job.id, r.body.jobId);
    assert.equal(r.body.job.status, "running");
    assert.equal(r.body.job.projectSlug, "demo");
    assert.equal(r.body.job.taskId, "t-1");

    const listed = app.jobRegistry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, r.body.jobId);

    const started = app.appendedEvents.filter((e) => e.type === "job.started");
    assert.equal(started.length, 1);
    assert.equal(started[0].source, "http");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:slug/tasks/:taskId/jobs — with predecessor emits job.queued", async () => {
  const app = await startApp();
  try {
    const pred = await app.jobRegistry.create(validJobInput({ taskId: "t-pred" }));
    const r = await postJson(app.base, "/api/projects/demo/tasks/t-succ/jobs", {
      sessionId: SES,
      profileId: "code-implementer",
      kind: "code",
      predecessorJobId: pred.jobId,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.job.status, "queued");

    const queued = app.appendedEvents.filter((e) => e.type === "job.queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].source, "http");
    assert.equal(queued[0].predecessorJobId, pred.jobId);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:slug/tasks/:taskId/jobs — body `projectSlug`/`taskId` → 400 UNKNOWN_FIELDS (URL wins)", async () => {
  const app = await startApp();
  try {
    const r = await postJson(app.base, "/api/projects/demo/tasks/t-1/jobs", {
      sessionId: SES,
      profileId: "code-implementer",
      kind: "code",
      projectSlug: "other",
      taskId: "t-other",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "UNKNOWN_FIELDS");
    // Both echoed back so callers see exactly which fields were rejected.
    assert.deepEqual(
      r.body.error.details.unknown.sort(),
      ["projectSlug", "taskId"].sort(),
    );
    assert.equal(app.jobRegistry.list().length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:slug/tasks/:taskId/jobs — missing sessionId → 400 INVALID_SESSION_ID", async () => {
  const app = await startApp();
  try {
    const r = await postJson(app.base, "/api/projects/demo/tasks/t-1/jobs", {
      profileId: "code-implementer",
      kind: "code",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_SESSION_ID");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:slug/tasks/:taskId/jobs — bad `kind` → 400 INVALID_JOB_KIND", async () => {
  const app = await startApp();
  try {
    const r = await postJson(app.base, "/api/projects/demo/tasks/t-1/jobs", {
      sessionId: SES,
      profileId: "code-implementer",
      kind: "nope",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_JOB_KIND");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:slug/tasks/:taskId/jobs — unknown predecessor → 404 UNKNOWN_PREDECESSOR", async () => {
  const app = await startApp();
  try {
    const r = await postJson(app.base, "/api/projects/demo/tasks/t-1/jobs", {
      sessionId: SES,
      profileId: "code-implementer",
      kind: "code",
      predecessorJobId: GHOST_JOB,
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "UNKNOWN_PREDECESSOR");
  } finally {
    await app.close();
  }
});

// --- PATCH /api/jobs/:jobId (SH-5-18) ---------------------------------------

test("PATCH /api/jobs/:jobId — non-terminal status change → 200; emits job.checkpoint", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await patchJson(app.base, `/api/jobs/${created.jobId}`, {
      status: "blocked",
      summary: "waiting on review",
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.eventId, "string");
    assert.equal(typeof r.body.rev, "number");
    assert.equal(r.body.job.id, created.jobId);
    assert.equal(r.body.job.status, "blocked");

    const cps = app.appendedEvents.filter((e) => e.type === "job.checkpoint");
    assert.equal(cps.length, 1);
    assert.equal(cps[0].source, "http");
    assert.equal(cps[0].status, "blocked");
  } finally {
    await app.close();
  }
});

test("PATCH /api/jobs/:jobId — terminal status → 400 TERMINAL_STATUS_FORBIDDEN", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await patchJson(app.base, `/api/jobs/${created.jobId}`, {
      status: "completed",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "TERMINAL_STATUS_FORBIDDEN");
    assert.equal(app.appendedEvents.filter((e) => e.type === "job.checkpoint").length, 0);
  } finally {
    await app.close();
  }
});

test("PATCH /api/jobs/:jobId — unknown body fields → 400 UNKNOWN_FIELDS", async () => {
  const app = await startApp();
  try {
    const created = await app.jobRegistry.create(validJobInput());
    const r = await patchJson(app.base, `/api/jobs/${created.jobId}`, {
      kind: "code",
      sessionId: SES,
      profileId: "code-implementer",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "UNKNOWN_FIELDS");
    assert.deepEqual(
      r.body.error.details.unknown.sort(),
      ["kind", "profileId", "sessionId"].sort(),
    );
  } finally {
    await app.close();
  }
});

test("PATCH /api/jobs/:jobId — unknown job → 404 JOB_NOT_FOUND", async () => {
  const app = await startApp();
  try {
    const r = await patchJson(app.base, `/api/jobs/${GHOST_JOB}`, { status: "running" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "JOB_NOT_FOUND");
  } finally {
    await app.close();
  }
});
