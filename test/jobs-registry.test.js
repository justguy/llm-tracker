// test/jobs-registry.test.js — SH-5-01 (TDD v0.5 §6.4, §6.6, §23.2 #35)
//
// Acceptance suite for JobRegistry. Wires a real RuntimeStore +
// RuntimeProjection so we exercise the full append → onAppend → projection
// pipeline (no mocks at the integration boundary).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JobRegistry,
  ALLOWED_JOB_STATUS,
  ALLOWED_JOB_KIND,
  TERMINAL_JOB_STATUS,
} from "../hub/jobs/registry.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId, JOB_ID_RE } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

function startEnv() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-jobs-registry-"));
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appendedEvents.push(event);
      projection.apply(event);
    },
  });
  const registry = new JobRegistry({
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  return {
    registry,
    runtimeStore,
    projection,
    workspaceRoot,
    appendedEvents,
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

const SES = "ses_01h2x3y4z5a6b7c8d9e0f1g2h3";
const SES_B = "ses_01h2x3y4z5a6b7c8d9e0f1g2h4";

function validJob(overrides = {}) {
  return {
    sessionId: SES,
    projectSlug: "demo",
    taskId: "t-1",
    profileId: "code-implementer",
    kind: "code",
    ...overrides,
  };
}

// --- constructor / surface --------------------------------------------------

test("JobRegistry: rejects malformed deps", () => {
  assert.throws(() => new JobRegistry(), /runtimeStore/);
  assert.throws(() => new JobRegistry({}), /runtimeStore/);
  assert.throws(
    () => new JobRegistry({ runtimeStore: { append: () => {} } }),
    /projection/,
  );
  assert.throws(
    () =>
      new JobRegistry({
        runtimeStore: { append: () => {} },
        projection: { jobs: new Map(), toSnapshots: () => ({ jobs: [] }) },
      }),
    /makeRuntimeId/,
  );
  assert.throws(
    () =>
      new JobRegistry({
        runtimeStore: { append: () => {} },
        projection: { jobs: new Map(), toSnapshots: () => ({ jobs: [] }) },
        makeRuntimeId,
      }),
    /validateRuntimeEvent/,
  );
  assert.throws(
    () =>
      new JobRegistry({
        runtimeStore: { append: () => {} },
        projection: { jobs: new Map(), toSnapshots: () => ({ jobs: [] }) },
        makeRuntimeId,
        validateRuntimeEvent,
      }),
    /workspace/,
  );
});

test("JobRegistry: exports frozen enums covering TDD §6.4 vocab", () => {
  assert.deepEqual(
    [...ALLOWED_JOB_STATUS],
    [
      "queued",
      "starting",
      "running",
      "blocked",
      "verifying",
      "completed",
      "cancelled",
      "rolled_over",
    ],
  );
  assert.deepEqual([...ALLOWED_JOB_KIND], ["code", "prd", "review", "planning", "closeout", "custom"]);
  assert.deepEqual([...TERMINAL_JOB_STATUS], ["completed", "cancelled", "rolled_over"]);
  assert.throws(() => {
    ALLOWED_JOB_STATUS.push("nope");
  });
});

// --- create -----------------------------------------------------------------

test("JobRegistry.create: emits job.started; list/get return the record", async () => {
  const env = startEnv();
  try {
    const before = env.registry.list();
    assert.equal(before.length, 0, "fresh registry starts empty");

    const created = await env.registry.create(validJob());
    assert.ok(JOB_ID_RE.test(created.jobId), "jobId is a job_ ulid");
    assert.equal(typeof created.eventId, "string");
    assert.equal(typeof created.rev, "number");
    assert.ok(created.job, "create returns the projected job");
    assert.equal(created.job.id, created.jobId);
    assert.equal(created.job.sessionId, SES);
    assert.equal(created.job.projectSlug, "demo");
    assert.equal(created.job.taskId, "t-1");
    assert.equal(created.job.profileId, "code-implementer");
    assert.equal(created.job.kind, "code");
    assert.equal(created.job.status, "running");

    assert.equal(env.registry.list().length, 1);
    assert.equal(env.registry.get(created.jobId).id, created.jobId);
    assert.equal(env.registry.get("job_doesnotexist"), null);
    assert.equal(env.registry.get(undefined), null);

    const started = env.appendedEvents.filter((e) => e.type === "job.started");
    assert.equal(started.length, 1);
    assert.equal(started[0].jobId, created.jobId);
    assert.equal(started[0].sessionId, SES);
    assert.equal(started[0].source, "system");
  } finally {
    env.close();
  }
});

test("JobRegistry.create: validates required fields and id shapes", async () => {
  const env = startEnv();
  try {
    await assert.rejects(env.registry.create(), /input must be an object/);
    await assert.rejects(env.registry.create([]), /input must be an object/);
    await assert.rejects(env.registry.create({}), /sessionId must be a ses_ id/);
    await assert.rejects(
      env.registry.create(validJob({ sessionId: "not-a-ses-id" })),
      /sessionId must be a ses_ id/,
    );
    await assert.rejects(
      env.registry.create(validJob({ projectSlug: "" })),
      /projectSlug required/,
    );
    await assert.rejects(
      env.registry.create(validJob({ taskId: "" })),
      /taskId required/,
    );
    await assert.rejects(
      env.registry.create(validJob({ profileId: "" })),
      /profileId required/,
    );
    await assert.rejects(
      env.registry.create(validJob({ kind: "bogus" })),
      /not in code\|prd/,
    );
    await assert.rejects(
      env.registry.create(validJob({ predecessorJobId: "not-a-job" })),
      /predecessorJobId must be a job_ id/,
    );
  } finally {
    env.close();
  }
});

test("JobRegistry.create: ride-through fields land in job.started payload", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(
      validJob({ source: "http", idempotencyKey: "key-1", kind: "prd", profileId: "prd-writer" }),
    );
    const evt = env.appendedEvents.find((e) => e.type === "job.started");
    assert.ok(evt);
    assert.equal(evt.source, "http");
    assert.equal(evt.idempotencyKey, "key-1");
    assert.equal(evt.kind, "prd");
    assert.equal(evt.profileId, "prd-writer");
    assert.equal(evt.jobId, created.jobId);
  } finally {
    env.close();
  }
});

// --- predecessor / successor links -----------------------------------------

test("JobRegistry.create: predecessorJobId routes to job.queued; successor is derived on read", async () => {
  const env = startEnv();
  try {
    const first = await env.registry.create(validJob());
    const second = await env.registry.create(
      validJob({ predecessorJobId: first.jobId, taskId: "t-2" }),
    );

    const queuedEvts = env.appendedEvents.filter((e) => e.type === "job.queued");
    assert.equal(queuedEvts.length, 1);
    assert.equal(queuedEvts[0].jobId, second.jobId);
    assert.equal(queuedEvts[0].predecessorJobId, first.jobId);

    const projSecond = env.registry.get(second.jobId);
    assert.equal(projSecond.status, "queued");
    assert.equal(projSecond.predecessorJobId, first.jobId);
    assert.equal(projSecond.successorJobId, undefined);

    const projFirst = env.registry.get(first.jobId);
    assert.equal(projFirst.successorJobId, second.jobId, "predecessor surfaces derived successor");

    const all = env.registry.list();
    assert.equal(all.find((j) => j.id === first.jobId).successorJobId, second.jobId);
    assert.equal(all.find((j) => j.id === second.jobId).predecessorJobId, first.jobId);
  } finally {
    env.close();
  }
});

test("JobRegistry.create: predecessor must exist in projection", async () => {
  const env = startEnv();
  try {
    const ghostId = "job_01h2x3y4z5a6b7c8d9e0f1ghst";
    await assert.rejects(
      env.registry.create(validJob({ predecessorJobId: ghostId })),
      /predecessor .* not found/,
    );
  } finally {
    env.close();
  }
});

// --- checkpoint -------------------------------------------------------------

test("JobRegistry.checkpoint: appends job.checkpoint and absorbs status/summary", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    const r1 = await env.registry.checkpoint(created.jobId, { status: "blocked", summary: "waiting on review" });
    assert.equal(typeof r1.eventId, "string");
    assert.equal(r1.job.status, "blocked");
    assert.equal(r1.job.lastCheckpointSummary, "waiting on review");

    const cps = env.appendedEvents.filter((e) => e.type === "job.checkpoint");
    assert.equal(cps.length, 1);
    assert.equal(cps[0].status, "blocked");
    assert.equal(cps[0].summary, "waiting on review");

    // status-less checkpoint also valid
    await env.registry.checkpoint(created.jobId, { summary: "heartbeat" });
    assert.equal(env.appendedEvents.filter((e) => e.type === "job.checkpoint").length, 2);
  } finally {
    env.close();
  }
});

test("JobRegistry.checkpoint: rejects unknown / terminal jobs and bad enums", async () => {
  const env = startEnv();
  try {
    await assert.rejects(env.registry.checkpoint("job_doesnotexist"), /jobId must be a job_ id/);
    await assert.rejects(
      env.registry.checkpoint("job_01h2x3y4z5a6b7c8d9e0f1ghst"),
      /unknown job/,
    );

    const created = await env.registry.create(validJob());
    await assert.rejects(
      env.registry.checkpoint(created.jobId, { status: "nonsense" }),
      /not in queued/,
    );
    await assert.rejects(
      env.registry.checkpoint(created.jobId, { status: "completed" }),
      /terminal — use complete\/cancel/,
    );
    await assert.rejects(
      env.registry.checkpoint(created.jobId, { summary: "" }),
      /summary must be a non-empty string/,
    );

    await env.registry.complete(created.jobId, { status: "completed" });
    await assert.rejects(
      env.registry.checkpoint(created.jobId, { status: "running" }),
      /is terminal/,
    );
  } finally {
    env.close();
  }
});

// --- complete / cancel ------------------------------------------------------

test("JobRegistry.complete: emits job.completed and locks the record", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    const completed = await env.registry.complete(created.jobId, {
      status: "completed",
      summary: "done",
    });
    assert.equal(completed.job.status, "completed");
    assert.equal(completed.job.summary, "done");

    const compEvts = env.appendedEvents.filter((e) => e.type === "job.completed");
    assert.equal(compEvts.length, 1);
    assert.equal(compEvts[0].status, "completed");
    assert.equal(compEvts[0].summary, "done");

    // Second completion attempt fails: job is terminal.
    await assert.rejects(
      env.registry.complete(created.jobId, { status: "completed" }),
      /is terminal/,
    );
  } finally {
    env.close();
  }
});

test("JobRegistry.complete: validates status enum and summary shape", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    await assert.rejects(env.registry.complete(created.jobId), /input must be an object/);
    await assert.rejects(
      env.registry.complete(created.jobId, { status: "queued" }),
      /not in completed\|cancelled\|rolled_over/,
    );
    await assert.rejects(
      env.registry.complete(created.jobId, { status: "completed", summary: "" }),
      /summary must be a non-empty string/,
    );
  } finally {
    env.close();
  }
});

test("JobRegistry.cancel: wraps complete with status='cancelled'", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    const cancelled = await env.registry.cancel(created.jobId, { summary: "user-cancelled" });
    assert.equal(cancelled.job.status, "cancelled");
    const evts = env.appendedEvents.filter((e) => e.type === "job.completed");
    assert.equal(evts.length, 1);
    assert.equal(evts[0].status, "cancelled");
    assert.equal(evts[0].summary, "user-cancelled");
  } finally {
    env.close();
  }
});

// --- requestRollover --------------------------------------------------------

test("JobRegistry.requestRollover: emits job.rollover_requested without terminating", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    const rolled = await env.registry.requestRollover(created.jobId, { reason: "context_pressure" });
    assert.equal(rolled.job.rolloverReason, "context_pressure");
    assert.notEqual(rolled.job.status, "rolled_over", "rollover_requested is not a terminal transition by itself");
    const evts = env.appendedEvents.filter((e) => e.type === "job.rollover_requested");
    assert.equal(evts.length, 1);
    assert.equal(evts[0].reason, "context_pressure");

    // Subsequent complete still allowed (machinery beyond sh-5-01 finalizes).
    await env.registry.complete(created.jobId, { status: "rolled_over" });
    assert.equal(env.registry.get(created.jobId).status, "rolled_over");
  } finally {
    env.close();
  }
});

test("JobRegistry.requestRollover: validates reason and refuses unknown/terminal jobs", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    await assert.rejects(
      env.registry.requestRollover(created.jobId, { reason: "" }),
      /reason must be a non-empty string/,
    );
    await env.registry.complete(created.jobId, { status: "completed" });
    await assert.rejects(env.registry.requestRollover(created.jobId), /is terminal/);
  } finally {
    env.close();
  }
});

// --- unblock ----------------------------------------------------------------

test("JobRegistry.unblock: emits job.unblocked only when the job is blocked", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    await assert.rejects(env.registry.unblock(created.jobId), /not 'blocked'/);

    await env.registry.checkpoint(created.jobId, { status: "blocked" });
    const unblocked = await env.registry.unblock(created.jobId);
    assert.equal(unblocked.job.status, "running");
    const evts = env.appendedEvents.filter((e) => e.type === "job.unblocked");
    assert.equal(evts.length, 1);
    assert.equal(evts[0].jobId, created.jobId);
  } finally {
    env.close();
  }
});

// --- listBySession ----------------------------------------------------------

test("JobRegistry.listBySession: filters projection jobs by sessionId", async () => {
  const env = startEnv();
  try {
    const a = await env.registry.create(validJob({ sessionId: SES, taskId: "t-a" }));
    const b = await env.registry.create(validJob({ sessionId: SES, taskId: "t-b", predecessorJobId: a.jobId }));
    await env.registry.create(validJob({ sessionId: SES_B, taskId: "t-c" }));

    const forA = env.registry.listBySession(SES);
    assert.equal(forA.length, 2);
    assert.deepEqual(
      forA.map((j) => j.taskId).sort(),
      ["t-a", "t-b"],
    );
    assert.equal(forA.find((j) => j.id === a.jobId).successorJobId, b.jobId);

    const forB = env.registry.listBySession(SES_B);
    assert.equal(forB.length, 1);
    assert.equal(forB[0].taskId, "t-c");

    assert.deepEqual(env.registry.listBySession(undefined), []);
  } finally {
    env.close();
  }
});

// --- now() injection --------------------------------------------------------

test("JobRegistry: injected now() is used for event ts", async () => {
  const env = startEnv();
  try {
    const fixed = "2026-05-24T17:00:00.000Z";
    const reg = new JobRegistry({
      runtimeStore: env.runtimeStore,
      projection: env.projection,
      makeRuntimeId,
      validateRuntimeEvent,
      workspace: env.workspaceRoot,
      now: () => fixed,
    });
    await reg.create(validJob());
    const evt = env.appendedEvents.find((e) => e.type === "job.started");
    assert.equal(evt.ts, fixed);
  } finally {
    env.close();
  }
});
