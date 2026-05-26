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

// SH-5-16: extended unblock signature carries reason / previousReason / user.

test("JobRegistry.unblock: reason / previousReason / user ride through into the job.unblocked event", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    await env.registry.checkpoint(created.jobId, { status: "blocked", summary: "awaiting api review" });

    const r = await env.registry.unblock(created.jobId, {
      reason: "manual override by maintainer",
      previousReason: "awaiting api review",
      user: "u_alice",
    });
    assert.equal(r.job.status, "running");

    const evts = env.appendedEvents.filter((e) => e.type === "job.unblocked");
    assert.equal(evts.length, 1);
    assert.equal(evts[0].reason, "manual override by maintainer");
    assert.equal(evts[0].previousReason, "awaiting api review");
    assert.equal(evts[0].user, "u_alice");
    assert.equal(evts[0].sessionId, SES);
  } finally {
    env.close();
  }
});

test("JobRegistry.unblock: predecessor still active → emits secondary job.checkpoint(status=queued)", async () => {
  const env = startEnv();
  try {
    // Set up: predecessor running, successor queued behind it.
    const pred = await env.registry.create(validJob({ taskId: "t-pred" }));
    const succ = await env.registry.create(
      validJob({ taskId: "t-succ", predecessorJobId: pred.jobId }),
    );
    // Successor is queued; drive it to blocked via checkpoint.
    await env.registry.checkpoint(succ.jobId, { status: "blocked", summary: "ext dep" });
    assert.equal(env.registry.get(succ.jobId).status, "blocked");
    assert.equal(env.registry.get(pred.jobId).status, "running");

    const eventsBefore = env.appendedEvents.length;
    const r = await env.registry.unblock(succ.jobId, { reason: "re-queue behind pred" });
    // Two events appended in total: job.unblocked + follow-up job.checkpoint.
    assert.equal(env.appendedEvents.length - eventsBefore, 2);
    const tail = env.appendedEvents.slice(eventsBefore);
    assert.equal(tail[0].type, "job.unblocked");
    assert.equal(tail[1].type, "job.checkpoint");
    assert.equal(tail[1].status, "queued");
    assert.equal(tail[1].jobId, succ.jobId);
    assert.match(tail[1].summary, /auto-requeue/);

    // Final projection state reflects the queued status, not running.
    assert.equal(r.job.status, "queued");
    assert.equal(env.registry.get(succ.jobId).status, "queued");
  } finally {
    env.close();
  }
});

test("JobRegistry.unblock: predecessor terminal → only the job.unblocked event is appended", async () => {
  const env = startEnv();
  try {
    const pred = await env.registry.create(validJob({ taskId: "t-pred" }));
    const succ = await env.registry.create(
      validJob({ taskId: "t-succ", predecessorJobId: pred.jobId }),
    );
    await env.registry.checkpoint(succ.jobId, { status: "blocked" });
    await env.registry.complete(pred.jobId, { status: "completed" });

    const eventsBefore = env.appendedEvents.length;
    const r = await env.registry.unblock(succ.jobId);
    assert.equal(env.appendedEvents.length - eventsBefore, 1);
    assert.equal(env.appendedEvents[env.appendedEvents.length - 1].type, "job.unblocked");
    assert.equal(r.job.status, "running");
  } finally {
    env.close();
  }
});

test("JobRegistry.unblock: validates reason / previousReason / user shapes", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    await env.registry.checkpoint(created.jobId, { status: "blocked" });

    await assert.rejects(
      env.registry.unblock(created.jobId, { reason: "" }),
      /reason must be a non-empty string/,
    );
    await assert.rejects(
      env.registry.unblock(created.jobId, { reason: "x".repeat(2001) }),
      /reason must be a non-empty string ≤2000 chars/,
    );
    await assert.rejects(
      env.registry.unblock(created.jobId, { previousReason: 7 }),
      /previousReason must be a non-empty string/,
    );
    await assert.rejects(
      env.registry.unblock(created.jobId, { user: "" }),
      /user must be a non-empty string/,
    );
    // None of the bad-input attempts should have appended an event.
    assert.equal(env.appendedEvents.filter((e) => e.type === "job.unblocked").length, 0);
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

// --- verifyPack persistence (SH-5-04 DoD line 3) ---------------------------

function makeVerifyPack(overrides = {}) {
  return {
    jobId: null,
    stampedAt: "2026-05-24T17:00:00.000Z",
    stampedFromRev: 7,
    items: [
      { id: "v1", kind: "command", cmd: "echo ok", required: true },
    ],
    ...overrides,
  };
}

test("JobRegistry.create: verifyPack persists onto the JobRecord projection", async () => {
  const env = startEnv();
  try {
    const pack = makeVerifyPack();
    const created = await env.registry.create(validJob({ verifyPack: pack }));
    assert.ok(created.job.verifyPack, "create result carries verifyPack");
    assert.equal(created.job.verifyPack.stampedFromRev, 7);
    assert.deepEqual(
      created.job.verifyPack.items.map((i) => i.id),
      ["v1"],
    );

    const refetched = env.registry.get(created.jobId);
    assert.ok(refetched.verifyPack, "get() also returns verifyPack");
    assert.deepEqual(
      refetched.verifyPack.items.map((i) => i.id),
      ["v1"],
    );

    // The pack rides through the job.started event for audit.
    const started = env.appendedEvents.find((e) => e.type === "job.started");
    assert.ok(started.verifyPack, "job.started event carries verifyPack");
    assert.equal(started.verifyPack.items[0].id, "v1");
  } finally {
    env.close();
  }
});

test("JobRegistry.create: running human_approval verify items emit requested events once", async () => {
  const env = startEnv();
  try {
    const pack = makeVerifyPack({
      items: [
        { id: "approve.ship", kind: "human_approval", required: true, prompt: "Ship?" },
        { id: "review.notes", kind: "human_approval", required: false, prompt: "Review notes" },
      ],
    });
    const created = await env.registry.create(validJob({ verifyPack: pack }));

    const requested = env.appendedEvents.filter((e) => e.type === "verify.human_approval.requested");
    assert.equal(requested.length, 2);
    assert.equal(requested[0].jobId, created.jobId);
    assert.equal(requested[0].itemId, "approve.ship");
    assert.equal(requested[0].required, true);
    assert.equal(requested[0].blocksCompletion, true);
    assert.equal(requested[0].title, "HUMAN APPROVAL REQUIRED");
    assert.equal(requested[1].itemId, "review.notes");
    assert.equal(requested[1].required, false);
    assert.equal(requested[1].blocksCompletion, false);
    assert.equal(requested[1].title, "HUMAN REVIEW READY");

    const refetched = env.registry.get(created.jobId);
    assert.equal(refetched.humanApprovalRequests.length, 2);
    assert.equal(
      refetched.completionGates.find((gate) => gate.id === "approve.ship").humanApproval,
      true,
    );
    assert.equal(
      refetched.completionGates.find((gate) => gate.id === "approve.ship").required,
      true,
    );

    await env.registry.checkpoint(created.jobId, { status: "running", summary: "still running" });
    assert.equal(env.appendedEvents.filter((e) => e.type === "verify.human_approval.requested").length, 2);
  } finally {
    env.close();
  }
});

test("JobRegistry.create: without verifyPack the JobRecord has no verifyPack field", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create(validJob());
    assert.equal(created.job.verifyPack, undefined);
    const refetched = env.registry.get(created.jobId);
    assert.equal(refetched.verifyPack, undefined);
    const started = env.appendedEvents.find((e) => e.type === "job.started");
    assert.equal(started.verifyPack, undefined);
  } finally {
    env.close();
  }
});

test("JobRegistry.create: rejects verifyPack with non-array items", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create(validJob({ verifyPack: { items: "nope" } })),
      /verifyPack must be an object with a non-empty items array/,
    );
    await assert.rejects(
      env.registry.create(validJob({ verifyPack: { items: [] } })),
      /verifyPack must be an object with a non-empty items array/,
    );
  } finally {
    env.close();
  }
});

test("JobRegistry.create: rejects verifyPack as a string / number / array", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create(validJob({ verifyPack: "not-an-object" })),
      /verifyPack must be an object with a non-empty items array/,
    );
    await assert.rejects(
      env.registry.create(validJob({ verifyPack: 42 })),
      /verifyPack must be an object with a non-empty items array/,
    );
    await assert.rejects(
      env.registry.create(validJob({ verifyPack: [{ id: "v1", kind: "command" }] })),
      /verifyPack must be an object with a non-empty items array/,
    );
  } finally {
    env.close();
  }
});

test("JobRegistry.checkpoint preserves verifyPack on the JobRecord", async () => {
  const env = startEnv();
  try {
    const pack = makeVerifyPack();
    const created = await env.registry.create(validJob({ verifyPack: pack }));
    await env.registry.checkpoint(created.jobId, { status: "blocked", summary: "ext dep" });
    const after = env.registry.get(created.jobId);
    assert.equal(after.status, "blocked");
    assert.ok(after.verifyPack, "verifyPack survives checkpoint");
    assert.equal(after.verifyPack.items[0].id, "v1");
  } finally {
    env.close();
  }
});

test("JobRegistry.complete preserves verifyPack on the JobRecord", async () => {
  const env = startEnv();
  try {
    const pack = makeVerifyPack();
    const created = await env.registry.create(validJob({ verifyPack: pack }));
    await env.registry.complete(created.jobId, { status: "completed", summary: "done" });
    const after = env.registry.get(created.jobId);
    assert.equal(after.status, "completed");
    assert.ok(after.verifyPack, "verifyPack survives terminal complete");
    assert.equal(after.verifyPack.items[0].id, "v1");
  } finally {
    env.close();
  }
});

test("JobRegistry.create: verifyPack flows through job.queued (predecessor) path too", async () => {
  const env = startEnv();
  try {
    const first = await env.registry.create(validJob({ taskId: "t-pred" }));
    const pack = makeVerifyPack({ items: [{ id: "q1", kind: "human_approval", required: true, prompt: "Approve q" }] });
    const second = await env.registry.create(
      validJob({ taskId: "t-succ", predecessorJobId: first.jobId, verifyPack: pack }),
    );
    assert.ok(second.job.verifyPack, "queued job has verifyPack");
    assert.equal(second.job.verifyPack.items[0].id, "q1");
    assert.equal(second.job.status, "queued");
    assert.equal(env.appendedEvents.filter((e) => e.type === "verify.human_approval.requested").length, 0);

    const queuedEvt = env.appendedEvents.find((e) => e.type === "job.queued");
    assert.ok(queuedEvt.verifyPack, "job.queued event carries verifyPack");
    assert.equal(queuedEvt.verifyPack.items[0].id, "q1");

    await env.registry.complete(first.jobId, { status: "completed", summary: "pred done" });
    await env.registry.checkpoint(second.jobId, { status: "running", summary: "succ started" });
    const requested = env.appendedEvents.filter((e) => e.type === "verify.human_approval.requested");
    assert.equal(requested.length, 1);
    assert.equal(requested[0].jobId, second.jobId);
    assert.equal(requested[0].itemId, "q1");
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
