// test/run-session-service.test.js — SH-3-05 (TDD v0.5 §6.7, §8A.1, §11.5; PRD §6.7)
//
// Unit-style tests for RunSessionService. Each test constructs deps directly
// (mirrors test/jobs-api.test.js's startApp() helper minus Express): a real
// RuntimeStore + RuntimeProjection + JobRegistry, an in-memory draftStore,
// and a tiny tracker-store stub holding seeded project entries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunSessionService } from "../hub/run-session/service.js";
import { JobRegistry } from "../hub/jobs/registry.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";
import { createDraftStore } from "../hub/run-session/drafts.js";

function makeStoreStub(projects = {}) {
  const map = new Map(Object.entries(projects));
  return {
    set(slug, entry) {
      map.set(slug, entry);
    },
    get(slug) {
      return map.get(slug) ?? null;
    },
  };
}

function task(overrides = {}) {
  return {
    id: overrides.id || "t-1",
    status: "not_started",
    placement: { swimlaneId: "lane-a", priorityId: "p1" },
    dependencies: [],
    repos: {
      primary: { root: "/tmp/repo", worktree: "/tmp/wt", allowed_paths: ["src/**"] },
    },
    verify: { items: [{ kind: "command", id: "lt.test", required: true, cmd: "node --test" }] },
    ...overrides,
  };
}

async function makeHarness({ projects = {}, contextPackService } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-run-session-"));
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
  const draftStore = createDraftStore();
  const store = makeStoreStub(projects);
  const service = new RunSessionService({
    store,
    draftStore,
    projection,
    jobRegistry,
    runtimeStore,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
    ...(contextPackService ? { contextPackService } : {}),
  });
  return {
    service,
    jobRegistry,
    projection,
    runtimeStore,
    draftStore,
    store,
    appendedEvents,
    workspaceRoot,
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

function makeDraft(h, input) {
  return h.draftStore.create(input);
}

// --- constructor ------------------------------------------------------------

test("constructor: rejects missing deps with clear messages", () => {
  const harness = {};
  assert.throws(() => new RunSessionService(), /store/);
  assert.throws(() => new RunSessionService({}), /store/);
  assert.throws(() => new RunSessionService({ store: { get: () => null } }), /draftStore/);
  assert.throws(
    () =>
      new RunSessionService({
        store: { get: () => null },
        draftStore: { get: () => null },
      }),
    /projection/,
  );
  assert.throws(
    () =>
      new RunSessionService({
        store: { get: () => null },
        draftStore: { get: () => null },
        projection: { sessions: new Map() },
      }),
    /jobRegistry/,
  );
});

// --- input validation -------------------------------------------------------

test("launch: rejects non-object input with invalid_input", async () => {
  const h = await makeHarness();
  try {
    const r = await h.service.launch(null);
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
  } finally {
    h.close();
  }
});

test("launch: rejects empty draftId with invalid_input", async () => {
  const h = await makeHarness();
  try {
    const r = await h.service.launch({ draftId: "" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /draftId/);
  } finally {
    h.close();
  }
});

test("launch: rejects non-integer expectedTrackerRev", async () => {
  const h = await makeHarness();
  try {
    const draft = makeDraft(h, { source: "cli", mode: "untasked" });
    const r = await h.service.launch({ draftId: draft.id, expectedTrackerRev: "twelve" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
  } finally {
    h.close();
  }
});

test("launch: unknown draft returns unknown_draft", async () => {
  const h = await makeHarness();
  try {
    const r = await h.service.launch({ draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "unknown_draft");
  } finally {
    h.close();
  }
});

// --- task_backed: tracker rev gating ----------------------------------------

test("task_backed: stale expectedTrackerRev returns stale_tracker_rev with currentRev", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 7 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id, expectedTrackerRev: 6 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "stale_tracker_rev");
    assert.equal(r.currentRev, 7);
  } finally {
    h.close();
  }
});

// --- task_backed: claim conflict + happy path -------------------------------

test("task_backed + fail_if_active with an active job returns task_claim_conflict", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    // Seed an active job so the second launch must conflict.
    const seedSessionId = "ses_01h2x3y4z5a6b7c8d9e0f1g2h3";
    const seedDraft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const first = await h.service.launch({ draftId: seedDraft.id });
    assert.equal(first.ok, true, "seed launch should succeed");

    const draft2 = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft2.id, claimMode: "fail_if_active" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "task_claim_conflict");
    assert.equal(r.activeJobId, first.jobId);
  } finally {
    h.close();
  }
});

test("task_backed + free task: returns mode=created with sessionId, jobId, verifyPack, contextPackRef=null", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "created");
    assert.match(r.sessionId, /^ses_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.match(r.jobId, /^job_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(r.taskClaimed, true);
    assert.ok(r.verifyPack && typeof r.verifyPack === "object");
    assert.equal(r.contextPackRef, null);

    // session.started + job.started landed in the event log; projection sees both.
    const sessionEvents = h.appendedEvents.filter((e) => e.type === "session.started");
    const jobEvents = h.appendedEvents.filter((e) => e.type === "job.started");
    assert.equal(sessionEvents.length, 1);
    assert.equal(jobEvents.length, 1);
    assert.equal(sessionEvents[0].source, "http");
    assert.equal(jobEvents[0].source, "http");
    assert.ok(h.projection.sessions.get(r.sessionId));
    assert.ok(h.projection.jobs.get(r.jobId));
  } finally {
    h.close();
  }
});

test("task_backed + join with an active job returns mode=joined, taskClaimed=false", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const seedDraft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const seed = await h.service.launch({ draftId: seedDraft.id });
    assert.equal(seed.ok, true);

    const joinDraft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: joinDraft.id, claimMode: "join" });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "joined");
    assert.equal(r.taskClaimed, false);
    // job was created with predecessor → emitted as job.queued.
    const queued = h.appendedEvents.filter((e) => e.type === "job.queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].predecessorJobId, seed.jobId);
  } finally {
    h.close();
  }
});

// --- task_backed: force semantics -------------------------------------------

test("task_backed + force without forceReason returns invalid_input mentioning reason", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id, claimMode: "force" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /reason/i);
  } finally {
    h.close();
  }
});

test("task_backed + force with reason returns mode=created and appends human.override event (source=http)", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    // Seed an active job so the force actually has something to override.
    const seedDraft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const seed = await h.service.launch({ draftId: seedDraft.id });
    assert.equal(seed.ok, true);

    const forceDraft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({
      draftId: forceDraft.id,
      claimMode: "force",
      forceReason: "operator needs lane",
      forceUser: "u_alice",
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "created");
    assert.equal(r.taskClaimed, true);

    const overrides = h.appendedEvents.filter((e) => e.type === "human.override");
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].source, "http", "service overrides source to http (not system)");
    assert.equal(overrides[0].context.kind, "task_claim_force");
    assert.equal(overrides[0].context.preemptedJobId, seed.jobId);
    assert.equal(overrides[0].reason, "operator needs lane");
    assert.equal(overrides[0].user, "u_alice");

    const cancelled = h.appendedEvents.filter((e) => e.type === "job.completed" && e.jobId === seed.jobId);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].status, "cancelled");
    assert.equal(h.projection.jobs.get(seed.jobId).status, "cancelled");

    const started = h.appendedEvents.filter((e) => e.type === "job.started" && e.jobId === r.jobId);
    assert.equal(started.length, 1, "forced replacement job starts immediately");
    assert.equal(h.projection.jobs.get(r.jobId).status, "running");
    assert.equal(h.projection.jobs.get(r.jobId).predecessorJobId, undefined);
  } finally {
    h.close();
  }
});

// --- task_backed: verifyPack composition ------------------------------------

test("task_backed: verifyPack.items mirrors task.verify.items and is frozen", async () => {
  const customTask = task({
    id: "t-verify",
    verify: {
      items: [
        { kind: "command", id: "lt.test", required: true, cmd: "node --test" },
        { kind: "dod_check", id: "lt.dod", required: true, ref: "DoD#1" },
      ],
    },
  });
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [customTask] }, rev: 3 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-verify",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.verifyPack.items.map((i) => i.id),
      ["lt.test", "lt.dod"],
    );
    assert.equal(r.verifyPack.stampedFromRev, 3);
    assert.equal(Object.isFrozen(r.verifyPack), true);
    assert.equal(Object.isFrozen(r.verifyPack.items), true);
  } finally {
    h.close();
  }
});

test("task_backed: task without verify launches and omits verifyPack", async () => {
  const noVerifyTask = task({ id: "t-no-verify" });
  delete noVerifyTask.verify;
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [noVerifyTask] }, rev: 4 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-no-verify",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "created");
    assert.equal(r.verifyPack, null);
    assert.equal(h.projection.jobs.get(r.jobId).verifyPack, undefined);
  } finally {
    h.close();
  }
});

// --- task_backed: unknown project / task ------------------------------------

test("task_backed: unknown projectSlug returns unknown_project", async () => {
  const h = await makeHarness();
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "ghost",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, false);
    assert.equal(r.error, "unknown_project");
  } finally {
    h.close();
  }
});

test("task_backed: known project but unknown taskId returns unknown_task", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-missing",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, false);
    assert.equal(r.error, "unknown_task");
  } finally {
    h.close();
  }
});

test("task_backed: missing projectSlug on draft returns invalid_input", async () => {
  const h = await makeHarness();
  try {
    // Force-construct a draft missing projectSlug — direct draftStore.create
    // accepts the shape (taskId is the only required v0.7 invariant for
    // task_backed) so the service must catch the gap.
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /projectSlug/);
  } finally {
    h.close();
  }
});

// --- untasked ----------------------------------------------------------------

test("untasked: creates a session, no job, mode=untasked with unbound_session warning", async () => {
  const h = await makeHarness();
  try {
    const draft = makeDraft(h, { source: "global_new_session", mode: "untasked" });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "untasked");
    assert.equal(r.jobId, null);
    assert.equal(r.taskClaimed, false);
    assert.deepEqual(r.warnings, ["unbound_session"]);

    // No job.started event; one session.started event.
    assert.equal(h.appendedEvents.filter((e) => e.type === "job.started").length, 0);
    const sessionEvents = h.appendedEvents.filter((e) => e.type === "session.started");
    assert.equal(sessionEvents.length, 1);
    // The session record carries no taskId.
    const session = h.projection.sessions.get(r.sessionId);
    assert.ok(session);
    assert.equal(session.taskId, undefined);
  } finally {
    h.close();
  }
});

// --- attach_existing --------------------------------------------------------

async function seedSession(h, draftInput) {
  const draft = makeDraft(h, draftInput);
  const result = await h.service.launch({ draftId: draft.id });
  assert.equal(result.ok, true, "seed session should land");
  return result.sessionId;
}

test("attach_existing: valid existing sessionId returns mode=attached without new session.started", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" }), task({ id: "t-2" })] }, rev: 0 } },
  });
  try {
    const seedSes = await seedSession(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const sessionStartedBefore = h.appendedEvents.filter((e) => e.type === "session.started").length;

    const attachDraft = makeDraft(h, {
      source: "attach",
      mode: "attach_existing",
      attachExistingSessionId: seedSes,
      projectSlug: "proj",
      // Draft schema forbids `taskId` for non-task_backed modes; the attach
      // path uses `attachTaskId` instead.
      attachTaskId: "t-2",
    });
    const r = await h.service.launch({ draftId: attachDraft.id });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "attached");
    assert.equal(r.sessionId, seedSes);
    assert.match(r.jobId, /^job_/);
    const sessionStartedAfter = h.appendedEvents.filter((e) => e.type === "session.started").length;
    assert.equal(
      sessionStartedAfter,
      sessionStartedBefore,
      "attach must not emit a new session.started",
    );
  } finally {
    h.close();
  }
});

test("attach_existing: missing existing sessionId returns unknown_session", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const attachDraft = makeDraft(h, {
      source: "attach",
      mode: "attach_existing",
      attachExistingSessionId: "ses_01h2x3y4z5a6b7c8d9e0f1ghst",
      projectSlug: "proj",
      attachTaskId: "t-1",
    });
    const r = await h.service.launch({ draftId: attachDraft.id });
    assert.equal(r.ok, false);
    assert.equal(r.error, "unknown_session");
  } finally {
    h.close();
  }
});

test("attach_existing: task collision (active job on same task) returns task_claim_conflict", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-collide" })] }, rev: 0 } },
  });
  try {
    // First session owns t-collide.
    const owner = await seedSession(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-collide",
      projectSlug: "proj",
    });
    // Independent second session we'll try to attach to.
    const stranger = await seedSession(h, {
      source: "global_new_session",
      mode: "untasked",
    });
    void owner;
    const attachDraft = makeDraft(h, {
      source: "attach",
      mode: "attach_existing",
      attachExistingSessionId: stranger,
      projectSlug: "proj",
      attachTaskId: "t-collide",
    });
    const r = await h.service.launch({ draftId: attachDraft.id, claimMode: "fail_if_active" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "task_claim_conflict");
  } finally {
    h.close();
  }
});

test("attach_existing: force with reason preempts active task job and starts replacement immediately", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-force" })] }, rev: 0 } },
  });
  try {
    const ownerDraft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-force",
      projectSlug: "proj",
    });
    const owner = await h.service.launch({ draftId: ownerDraft.id });
    assert.equal(owner.ok, true);

    const stranger = await seedSession(h, {
      source: "global_new_session",
      mode: "untasked",
    });
    const attachDraft = makeDraft(h, {
      source: "attach",
      mode: "attach_existing",
      attachExistingSessionId: stranger,
      projectSlug: "proj",
      attachTaskId: "t-force",
    });

    const r = await h.service.launch({
      draftId: attachDraft.id,
      claimMode: "force",
      forceReason: "operator needs attach",
      forceUser: "u_alice",
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "attached");
    assert.equal(r.sessionId, stranger);
    assert.equal(r.taskClaimed, true);

    const overrides = h.appendedEvents.filter((e) => e.type === "human.override");
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].context.kind, "task_claim_force");
    assert.equal(overrides[0].context.preemptedJobId, owner.jobId);
    assert.equal(overrides[0].reason, "operator needs attach");

    const cancelled = h.appendedEvents.filter((e) => e.type === "job.completed" && e.jobId === owner.jobId);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].status, "cancelled");
    assert.equal(h.projection.jobs.get(owner.jobId).status, "cancelled");

    const started = h.appendedEvents.filter((e) => e.type === "job.started" && e.jobId === r.jobId);
    assert.equal(started.length, 1, "forced attach replacement job starts immediately");
    assert.equal(h.projection.jobs.get(r.jobId).status, "running");
    assert.equal(h.projection.jobs.get(r.jobId).predecessorJobId, undefined);
  } finally {
    h.close();
  }
});

test("attach_existing: task without verify launches and omits verifyPack", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-no-verify", verify: undefined })] }, rev: 0 } },
  });
  try {
    const seedSes = await seedSession(h, { source: "global_new_session", mode: "untasked" });
    const attachDraft = makeDraft(h, {
      source: "attach",
      mode: "attach_existing",
      attachExistingSessionId: seedSes,
      projectSlug: "proj",
      attachTaskId: "t-no-verify",
    });
    const r = await h.service.launch({ draftId: attachDraft.id });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "attached");
    assert.equal(r.verifyPack, null);
    assert.equal(h.projection.jobs.get(r.jobId).verifyPack, undefined);
  } finally {
    h.close();
  }
});

test("attach_existing: untasked-attach (no taskId) returns mode=attached with jobId=null", async () => {
  const h = await makeHarness();
  try {
    const seedSes = await seedSession(h, { source: "global_new_session", mode: "untasked" });
    const attachDraft = makeDraft(h, {
      source: "attach",
      mode: "attach_existing",
      attachExistingSessionId: seedSes,
    });
    const r = await h.service.launch({ draftId: attachDraft.id });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "attached");
    assert.equal(r.jobId, null);
  } finally {
    h.close();
  }
});

// --- profile defaulting + idempotency safety --------------------------------

test("profileId missing → defaults to job kind 'code'", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    const job = h.jobRegistry.get(r.jobId);
    assert.equal(job.kind, "code");
  } finally {
    h.close();
  }
});

test("explicit profileId=prd-writer → job.kind=prd", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
      profileId: "prd-writer",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    const job = h.jobRegistry.get(r.jobId);
    assert.equal(job.kind, "prd");
  } finally {
    h.close();
  }
});

test("subsequent launches with a fresh draft do not corrupt projection", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" }), task({ id: "t-2" })] }, rev: 0 } },
  });
  try {
    const d1 = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r1 = await h.service.launch({ draftId: d1.id });
    assert.equal(r1.ok, true);

    const d2 = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-2",
      projectSlug: "proj",
    });
    const r2 = await h.service.launch({ draftId: d2.id });
    assert.equal(r2.ok, true);

    const sessions = h.projection.toSnapshots().sessions;
    const jobs = h.projection.toSnapshots().jobs;
    assert.equal(sessions.length, 2);
    assert.equal(jobs.length, 2);
    assert.notEqual(r1.sessionId, r2.sessionId);
    assert.notEqual(r1.jobId, r2.jobId);
  } finally {
    h.close();
  }
});

// --- result freezing --------------------------------------------------------

test("launch() result is frozen (Object.isFrozen)", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(Object.isFrozen(r), true);
    const err = await h.service.launch({ draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa" });
    assert.equal(Object.isFrozen(err), true);
  } finally {
    h.close();
  }
});

// --- task_backed: verifyPack persistence on JobRecord (SH-5-04 DoD line 3) --

test("task_backed: launchResult.verifyPack is persisted onto the JobRecord projection", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    const job = h.projection.jobs.get(r.jobId);
    assert.ok(job.verifyPack, "JobRecord carries verifyPack");
    assert.equal(job.verifyPack.items[0].id, "lt.test");
    assert.equal(job.verifyPack.items[0].id, r.verifyPack.items[0].id);
  } finally {
    h.close();
  }
});

test("task_backed: launch result verifyPack === JobRecord.verifyPack (same frozen reference)", async () => {
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    const job = h.projection.jobs.get(r.jobId);
    assert.equal(r.verifyPack, job.verifyPack, "single source of truth (reference identity)");
    assert.equal(Object.isFrozen(r.verifyPack), true);
    assert.equal(Object.isFrozen(job.verifyPack), true);
  } finally {
    h.close();
  }
});

test("task_backed: mutating project.tasks[i].verify after launch does not alter the stamped pack (DoD 4)", async () => {
  // Build a mutable project entry so we can push onto verify.items after launch.
  const mutableTask = task({
    id: "t-1",
    verify: { items: [{ kind: "command", id: "lt.original", required: true, cmd: "node --test" }] },
  });
  const project = { data: { tasks: [mutableTask] }, rev: 0 };
  const h = await makeHarness({ projects: { proj: project } });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    const beforeIds = h.projection.jobs.get(r.jobId).verifyPack.items.map((i) => i.id);
    assert.deepEqual(beforeIds, ["lt.original"]);

    // Mutate the project AFTER launch — push a new verify item onto the task.
    project.data.tasks[0].verify.items.push({
      kind: "command",
      id: "lt.added_later",
      required: false,
      cmd: "echo nope",
    });

    // Re-fetch the job's pack: still the original, single-item pack.
    const afterIds = h.projection.jobs.get(r.jobId).verifyPack.items.map((i) => i.id);
    assert.deepEqual(afterIds, ["lt.original"], "in-flight pack is immutable to upstream task.verify edits");
    assert.equal(h.projection.jobs.get(r.jobId).verifyPack.items.length, 1);
  } finally {
    h.close();
  }
});

test("untasked launch: no job created, projection has no verifyPack to surface", async () => {
  const h = await makeHarness();
  try {
    const draft = makeDraft(h, { source: "global_new_session", mode: "untasked" });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    assert.equal(r.jobId, null);
    assert.equal(r.verifyPack, undefined, "untasked launch result has no verifyPack");
    // And of course no projection job exists either.
    assert.equal(h.projection.toSnapshots().jobs.length, 0);
  } finally {
    h.close();
  }
});

// --- context-pack composer tolerance ----------------------------------------

test("contextPackService that throws NOT_IMPLEMENTED still yields a successful launch with contextPackRef=null", async () => {
  const failingComposer = {
    build: async () => {
      const err = new Error("NOT_IMPLEMENTED");
      throw err;
    },
  };
  const h = await makeHarness({
    projects: { proj: { data: { tasks: [task({ id: "t-1" })] }, rev: 0 } },
    contextPackService: failingComposer,
  });
  try {
    const draft = makeDraft(h, {
      source: "task_card",
      mode: "task_backed",
      taskId: "t-1",
      projectSlug: "proj",
    });
    const r = await h.service.launch({ draftId: draft.id });
    assert.equal(r.ok, true);
    assert.equal(r.contextPackRef, null);
  } finally {
    h.close();
  }
});
