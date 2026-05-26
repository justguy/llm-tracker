// test/runtime-projection.test.js — sh-1-05 (TDD v0.5 §5.2, §5.3, §6.1–§6.5)

import { test } from "node:test";
import assert from "node:assert/strict";

import { RuntimeProjection, HANDLERS } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const WORKSPACE = "/Users/adil/.llm-tracker";

function baseEvent(type, overrides = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T12:00:00Z",
    type,
    source: "system",
    workspace: WORKSPACE,
    ...overrides,
  };
}

function sessionStarted({ sessionId, name = "S", tier = "codex_app_server", projectSlug, taskId, ts, source = "ui" } = {}) {
  return baseEvent("session.started", {
    source,
    ...(ts ? { ts } : {}),
    session: {
      id: sessionId || makeRuntimeId("ses"),
      name,
      tier,
      ...(projectSlug ? { projectSlug } : {}),
      ...(taskId ? { taskId } : {}),
    },
  });
}

function sessionStatus({ sessionId, status = "active", ts = "2026-05-23T12:01:00Z", source = "adapter", contextUsage } = {}) {
  return baseEvent("session.status", { source, ts, sessionId, status, ...(contextUsage ? { contextUsage } : {}) });
}

function sessionWarning({ sessionId, warning, ts = "2026-05-23T12:02:00Z" } = {}) {
  return baseEvent("session.warning", { ts, sessionId, warning });
}

function sessionWarningCleared({ sessionId, warningKind, ts = "2026-05-23T12:03:00Z" } = {}) {
  return baseEvent("session.warning_cleared", { ts, sessionId, warningKind });
}

function sessionStopped({ sessionId, reason, exitCode, ts = "2026-05-23T12:04:00Z" } = {}) {
  return baseEvent("session.stopped", { ts, sessionId, ...(reason ? { reason } : {}), ...(exitCode !== undefined ? { exitCode } : {}) });
}

function sessionStdioCaptureChanged({ sessionId, capture, ts = "2026-05-23T12:05:00Z" } = {}) {
  return baseEvent("session.stdio_capture_changed", { ts, sessionId, capture });
}

function jobStarted({ jobId, sessionId, projectSlug = "p", taskId = "t-1", kind = "code", profileId = "default", ts = "2026-05-23T12:10:00Z" } = {}) {
  return baseEvent("job.started", { ts, jobId, sessionId, projectSlug, taskId, kind, profileId });
}

function jobCheckpoint({ jobId, sessionId, summary, status, ts = "2026-05-23T12:11:00Z" } = {}) {
  return baseEvent("job.checkpoint", { ts, jobId, sessionId, ...(summary ? { summary } : {}), ...(status ? { status } : {}) });
}

function jobCompleted({ jobId, sessionId, status = "completed", summary, ts = "2026-05-23T12:12:00Z" } = {}) {
  return baseEvent("job.completed", { ts, jobId, sessionId, status, ...(summary ? { summary } : {}) });
}

function jobQueued({ jobId, sessionId, ts = "2026-05-23T12:09:00Z" } = {}) {
  return baseEvent("job.queued", { ts, jobId, sessionId });
}

function jobUnblocked({ jobId, ts = "2026-05-23T12:13:00Z" } = {}) {
  return baseEvent("job.unblocked", { ts, jobId });
}

function jobRolloverRequested({ jobId, sessionId, reason = "context_high", ts = "2026-05-23T12:14:00Z" } = {}) {
  return baseEvent("job.rollover_requested", { ts, jobId, sessionId, reason });
}

function skillRunStarted({ skillRunId, skillId = "verify", jobId, sessionId, ts = "2026-05-23T12:20:00Z" } = {}) {
  return baseEvent("skill.run.started", { ts, skillRunId, skillId, jobId, sessionId });
}

function skillRunFinished({ skillRunId, skillId = "verify", jobId, sessionId, status = "succeeded", summary, ts = "2026-05-23T12:21:00Z" } = {}) {
  return baseEvent("skill.run.finished", { ts, skillRunId, skillId, jobId, sessionId, status, ...(summary ? { summary } : {}) });
}

function verifyHumanApprovalRequested({
  jobId,
  sessionId,
  itemId = "approve.ship",
  required = true,
  blocksCompletion = true,
  prompt = "Ship?",
  title = "HUMAN APPROVAL REQUIRED",
  ts = "2026-05-23T12:22:00Z",
} = {}) {
  return baseEvent("verify.human_approval.requested", {
    ts,
    jobId,
    sessionId,
    itemId,
    itemKind: "human_approval",
    required,
    blocksCompletion,
    prompt,
    title,
  });
}

function verifyHumanApprovalResolved({
  jobId,
  sessionId,
  itemId = "approve.ship",
  status = "satisfied",
  reason = "approved",
  ts = "2026-05-23T12:23:00Z",
} = {}) {
  return baseEvent("verify.human_approval.resolved", {
    ts,
    jobId,
    sessionId,
    itemId,
    itemKind: "human_approval",
    status,
    reason,
  });
}

// ---------------------------------------------------------------------------

test("empty projection: toSnapshots returns three empty arrays", () => {
  const p = new RuntimeProjection();
  const snap = p.toSnapshots();
  assert.deepEqual(snap, { sessions: [], jobs: [], skillRuns: [] });
  assert.equal(p.rev, 0);
});

test("session.started creates a session in FIFO order", () => {
  const p = new RuntimeProjection();
  const s1 = makeRuntimeId("ses");
  const s2 = makeRuntimeId("ses");
  const s3 = makeRuntimeId("ses");
  p.apply(sessionStarted({ sessionId: s1, name: "first" }));
  p.apply(sessionStarted({ sessionId: s2, name: "second" }));
  p.apply(sessionStarted({ sessionId: s3, name: "third" }));
  const { sessions } = p.toSnapshots();
  assert.equal(sessions.length, 3);
  assert.deepEqual(
    sessions.map((s) => s.id),
    [s1, s2, s3],
  );
  assert.equal(sessions[0].name, "first");
  assert.equal(sessions[0].tier, "codex_app_server");
  assert.equal(sessions[0].status, "starting");
  assert.deepEqual(sessions[0].warnings, []);
  assert.equal(sessions[0].startedAt, "2026-05-23T12:00:00Z");
  assert.equal(sessions[0].statusSource.kind, "ui");
  assert.match(sessions[0].statusSource.eventId, /^evt_/);
});

test("session.status updates status + statusSource + lastActivityAt; ignores unknown sessionId", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(sessionStatus({ sessionId: ses, status: "active", source: "adapter", ts: "2026-05-23T12:01:30Z" }));
  const [s] = p.toSnapshots().sessions;
  assert.equal(s.status, "active");
  assert.equal(s.lastActivityAt, "2026-05-23T12:01:30Z");
  assert.equal(s.statusSource.kind, "adapter");

  // unknown sessionId is a no-op
  p.apply(sessionStatus({ sessionId: makeRuntimeId("ses"), status: "quiet" }));
  assert.equal(p.toSnapshots().sessions.length, 1);
});

test("session.warning appends and session.warning_cleared removes matching kind", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(sessionWarning({ sessionId: ses, warning: { kind: "quiet_terminal", minutes: 8 } }));
  p.apply(sessionWarning({ sessionId: ses, warning: { kind: "context_high", percent: 91 } }));
  let [s] = p.toSnapshots().sessions;
  assert.equal(s.warnings.length, 2);
  assert.deepEqual(s.warnings.map((w) => w.kind), ["quiet_terminal", "context_high"]);

  p.apply(sessionWarningCleared({ sessionId: ses, warningKind: "quiet_terminal" }));
  [s] = p.toSnapshots().sessions;
  assert.equal(s.warnings.length, 1);
  assert.equal(s.warnings[0].kind, "context_high");

  // clearing absent kind is harmless
  p.apply(sessionWarningCleared({ sessionId: ses, warningKind: "approval_needed" }));
  [s] = p.toSnapshots().sessions;
  assert.equal(s.warnings.length, 1);
});

test("session.status with contextUsage updates lastStructuredEventAt", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(
    sessionStatus({
      sessionId: ses,
      source: "mcp",
      ts: "2026-05-23T12:06:00Z",
      status: "context_high",
      contextUsage: { percent: 87, used: 87000, limit: 100000, source: "mcp" },
    }),
  );
  const [s] = p.toSnapshots().sessions;
  assert.equal(s.status, "context_high");
  assert.equal(s.lastStructuredEventAt, "2026-05-23T12:06:00Z");
  assert.deepEqual(s.contextUsage, { percent: 87, used: 87000, limit: 100000, source: "mcp" });
});

test("session.stopped sets status='stopped' + stoppedAt + reason/exitCode", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(sessionStopped({ sessionId: ses, reason: "user_quit", exitCode: 0, ts: "2026-05-23T13:00:00Z" }));
  const [s] = p.toSnapshots().sessions;
  assert.equal(s.status, "stopped");
  assert.equal(s.stoppedAt, "2026-05-23T13:00:00Z");
  assert.equal(s.stopReason, "user_quit");
  assert.equal(s.exitCode, 0);
});

test("session.stdio_capture_changed updates stdioCapture", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(
    sessionStdioCaptureChanged({
      sessionId: ses,
      capture: { enabled: true, path: "/tmp/capture.log", maxBytes: 1024 },
    }),
  );
  const [s] = p.toSnapshots().sessions;
  assert.equal(s.stdioCapture.enabled, true);
  assert.equal(s.stdioCapture.path, "/tmp/capture.log");
});

test("job lifecycle: started → checkpoint → completed reflected in jobs[]", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  const jobId = makeRuntimeId("job");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(jobStarted({ jobId, sessionId: ses, projectSlug: "proj", taskId: "t-9", kind: "code" }));
  p.apply(jobCheckpoint({ jobId, sessionId: ses, summary: "halfway", ts: "2026-05-23T12:11:30Z" }));
  p.apply(jobCompleted({ jobId, sessionId: ses, status: "completed", summary: "done", ts: "2026-05-23T12:12:30Z" }));
  const { jobs } = p.toSnapshots();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, jobId);
  assert.equal(jobs[0].sessionId, ses);
  assert.equal(jobs[0].projectSlug, "proj");
  assert.equal(jobs[0].taskId, "t-9");
  assert.equal(jobs[0].kind, "code");
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].startedAt, "2026-05-23T12:10:00Z");
  assert.equal(jobs[0].lastActivityAt, "2026-05-23T12:11:30Z");
  assert.equal(jobs[0].lastCheckpointSummary, "halfway");
  assert.equal(jobs[0].completedAt, "2026-05-23T12:12:30Z");
  assert.equal(jobs[0].summary, "done");
});

test("job.queued upserts a new job with status='queued'; job.unblocked flips to running", () => {
  const p = new RuntimeProjection();
  const jobId = makeRuntimeId("job");
  const sessionId = makeRuntimeId("ses");
  p.apply(jobQueued({ jobId, sessionId, ts: "2026-05-23T12:09:00Z" }));
  let [j] = p.toSnapshots().jobs;
  assert.equal(j.id, jobId);
  assert.equal(j.sessionId, sessionId);
  assert.equal(j.status, "queued");
  assert.equal(j.queuedAt, "2026-05-23T12:09:00Z");

  p.apply(jobUnblocked({ jobId, ts: "2026-05-23T12:13:00Z" }));
  [j] = p.toSnapshots().jobs;
  assert.equal(j.status, "running");
  assert.equal(j.lastActivityAt, "2026-05-23T12:13:00Z");
});

test("verify.human_approval requested/resolved records and clears attention source state", () => {
  const p = new RuntimeProjection();
  const sessionId = makeRuntimeId("ses");
  const jobId = makeRuntimeId("job");
  p.apply(sessionStarted({ sessionId, projectSlug: "demo", taskId: "t-1" }));
  p.apply(jobStarted({ jobId, sessionId, projectSlug: "demo", taskId: "t-1" }));
  const requested = verifyHumanApprovalRequested({ jobId, sessionId });
  p.apply(requested);

  let [job] = p.toSnapshots().jobs;
  assert.equal(job.humanApprovalRequests.length, 1);
  assert.deepEqual(job.humanApprovalRequests[0], {
    itemId: "approve.ship",
    itemKind: "human_approval",
    status: "pending",
    eventId: requested.id,
    requestedAt: requested.ts,
    required: true,
    blocksCompletion: true,
    title: "HUMAN APPROVAL REQUIRED",
    prompt: "Ship?",
  });
  assert.deepEqual(job.completionGates[0], {
    id: "approve.ship",
    kind: "verify_pack",
    required: true,
    status: "pending",
    humanApproval: true,
    prompt: "Ship?",
    requestedEventId: requested.id,
  });

  const resolved = verifyHumanApprovalResolved({ jobId, sessionId });
  p.apply(resolved);
  [job] = p.toSnapshots().jobs;
  assert.deepEqual(job.humanApprovalRequests, []);
  assert.equal(job.completionGates[0].status, "satisfied");
  assert.equal(job.completionGates[0].evidenceRef, resolved.id);
  assert.equal(job.completionGates[0].verifyItemKind, "human_approval");
  assert.equal(job.completionGates[0].reason, "approved");
});

test("session.task_unbound clears task and active job while preserving queued jobs", () => {
  const p = new RuntimeProjection();
  const sessionId = makeRuntimeId("ses");
  const activeJobId = makeRuntimeId("job");
  const queuedJobId = makeRuntimeId("job");
  p.apply(sessionStarted({ sessionId, projectSlug: "demo", taskId: "t-active" }));
  p.apply(jobStarted({ jobId: activeJobId, sessionId, projectSlug: "demo", taskId: "t-active" }));
  p.apply(jobQueued({ jobId: queuedJobId, sessionId }));

  p.apply(baseEvent("session.task_unbound", {
    ts: "2026-05-23T12:15:00Z",
    sessionId,
    previousTaskId: "t-active",
    previousActiveJobId: activeJobId,
    force: true,
  }));

  const [session] = p.toSnapshots().sessions;
  assert.equal(session.mode, "untasked");
  assert.equal(session.taskId, undefined);
  assert.equal(session.activeJobId, undefined);
  assert.deepEqual(session.queuedJobIds, [queuedJobId]);
  assert.equal(session.lastActivityAt, "2026-05-23T12:15:00Z");
});

test("job.rollover_requested stamps rolloverRequestedAt and reason", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  const jobId = makeRuntimeId("job");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(jobStarted({ jobId, sessionId: ses }));
  p.apply(jobRolloverRequested({ jobId, sessionId: ses, reason: "context_high", ts: "2026-05-23T12:30:00Z" }));
  const [j] = p.toSnapshots().jobs;
  assert.equal(j.rolloverRequestedAt, "2026-05-23T12:30:00Z");
  assert.equal(j.rolloverReason, "context_high");
});

test("skill run lifecycle: started → finished reflected in skillRuns[]", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  const jobId = makeRuntimeId("job");
  const runId = makeRuntimeId("skr");
  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(jobStarted({ jobId, sessionId: ses }));
  p.apply(skillRunStarted({ skillRunId: runId, skillId: "verify", jobId, sessionId: ses }));
  p.apply(
    skillRunFinished({
      skillRunId: runId,
      skillId: "verify",
      jobId,
      sessionId: ses,
      status: "succeeded",
      summary: "ok",
    }),
  );
  const { skillRuns } = p.toSnapshots();
  assert.equal(skillRuns.length, 1);
  assert.equal(skillRuns[0].id, runId);
  assert.equal(skillRuns[0].skillId, "verify");
  assert.equal(skillRuns[0].jobId, jobId);
  assert.equal(skillRuns[0].sessionId, ses);
  assert.equal(skillRuns[0].status, "succeeded");
  assert.equal(skillRuns[0].startedAt, "2026-05-23T12:20:00Z");
  assert.equal(skillRuns[0].finishedAt, "2026-05-23T12:21:00Z");
  assert.equal(skillRuns[0].summary, "ok");
});

test("unknown event type is a no-op but rev still ticks", () => {
  const p = new RuntimeProjection();
  const before = p.rev;
  p.apply(baseEvent("conflict.ack", { ts: "2026-05-23T14:00:00Z" }));
  p.apply(baseEvent("attention.snoozed", { ts: "2026-05-23T14:01:00Z" }));
  p.apply(baseEvent("totally.invented", { ts: "2026-05-23T14:02:00Z" }));
  assert.equal(p.rev, before + 3);
  assert.deepEqual(p.toSnapshots(), { sessions: [], jobs: [], skillRuns: [] });
});

test("non-object input is ignored (no throw, no rev tick)", () => {
  const p = new RuntimeProjection();
  p.apply(null);
  p.apply(undefined);
  p.apply("not-an-event");
  p.apply(42);
  p.apply([1, 2, 3]);
  assert.equal(p.rev, 0);
});

test("out-of-order event (status before started) is a no-op; later started+status works", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  p.apply(sessionStatus({ sessionId: ses, status: "active" }));
  assert.equal(p.toSnapshots().sessions.length, 0);

  p.apply(sessionStarted({ sessionId: ses }));
  p.apply(sessionStatus({ sessionId: ses, status: "active", ts: "2026-05-23T12:50:00Z" }));
  const [s] = p.toSnapshots().sessions;
  assert.equal(s.status, "active");
  assert.equal(s.lastActivityAt, "2026-05-23T12:50:00Z");
});

test("replay safety: applying same event sequence twice on a fresh projection yields identical snapshots", () => {
  const ses = makeRuntimeId("ses");
  const jobId = makeRuntimeId("job");
  const runId = makeRuntimeId("skr");
  const log = [
    sessionStarted({ sessionId: ses, name: "S", projectSlug: "proj", taskId: "t-1" }),
    sessionStatus({ sessionId: ses, status: "active" }),
    sessionWarning({ sessionId: ses, warning: { kind: "quiet_terminal", minutes: 5 } }),
    jobStarted({ jobId, sessionId: ses }),
    jobCheckpoint({ jobId, sessionId: ses, summary: "step 1" }),
    skillRunStarted({ skillRunId: runId, skillId: "verify", jobId, sessionId: ses }),
    skillRunFinished({ skillRunId: runId, skillId: "verify", jobId, sessionId: ses, status: "succeeded" }),
    jobCompleted({ jobId, sessionId: ses, status: "completed", summary: "done" }),
    sessionStopped({ sessionId: ses, reason: "user_quit", exitCode: 0 }),
  ];

  const p1 = new RuntimeProjection();
  for (const e of log) p1.apply(e);
  const snap1 = p1.toSnapshots();

  const p2 = new RuntimeProjection();
  for (const e of log) p2.apply(e);
  const snap2 = p2.toSnapshots();

  assert.deepEqual(snap1, snap2);
});

test("replay dedupe: applying the same evt id twice is a no-op (rev only ticks once)", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  const evt = sessionStarted({ sessionId: ses, name: "once" });
  p.apply(evt);
  assert.equal(p.rev, 1);
  assert.equal(p.toSnapshots().sessions.length, 1);

  // Apply the exact same evt object again — should be deduped by evt.id
  p.apply(evt);
  assert.equal(p.rev, 1, "rev should not advance on duplicate id");
  assert.equal(p.toSnapshots().sessions.length, 1);
});

test("replay dedupe across two passes of the entire log: snapshot equals single-pass snapshot", () => {
  const ses = makeRuntimeId("ses");
  const jobId = makeRuntimeId("job");
  const log = [
    sessionStarted({ sessionId: ses }),
    sessionWarning({ sessionId: ses, warning: { kind: "quiet_terminal", minutes: 8 } }),
    jobStarted({ jobId, sessionId: ses }),
    jobCheckpoint({ jobId, sessionId: ses, summary: "halfway" }),
    sessionWarningCleared({ sessionId: ses, warningKind: "quiet_terminal" }),
    jobCompleted({ jobId, sessionId: ses, summary: "ok" }),
  ];

  const single = new RuntimeProjection();
  for (const e of log) single.apply(e);
  const singleSnap = single.toSnapshots();
  const singleRev = single.rev;

  const replayed = new RuntimeProjection();
  for (const e of log) replayed.apply(e);
  for (const e of log) replayed.apply(e); // second pass — all should be deduped
  const replayedSnap = replayed.toSnapshots();

  assert.deepEqual(replayedSnap, singleSnap);
  assert.equal(replayed.rev, singleRev, "rev should match single-pass rev (dedupe)");
});

test("HANDLERS table is frozen and exposes every Phase-1 event type", () => {
  assert.ok(Object.isFrozen(HANDLERS));
  const expected = [
    "session.started",
    "session.status",
    "session.warning",
    "session.warning_cleared",
    "session.stopped",
    "session.stdio_capture_changed",
    "job.started",
    "job.checkpoint",
    "job.completed",
    "job.queued",
    "job.unblocked",
    "job.rollover_requested",
    "skill.run.started",
    "skill.run.finished",
  ];
  for (const t of expected) {
    assert.equal(typeof HANDLERS[t], "function", `missing handler for ${t}`);
  }
});

test("toSnapshots returns a fresh array each call (mutating result does not corrupt internal state)", () => {
  const p = new RuntimeProjection();
  const ses = makeRuntimeId("ses");
  p.apply(sessionStarted({ sessionId: ses }));
  const a = p.toSnapshots();
  const b = p.toSnapshots();
  assert.notStrictEqual(a.sessions, b.sessions, "sessions arrays should be distinct");
  a.sessions.length = 0;
  assert.equal(p.toSnapshots().sessions.length, 1, "mutating returned array must not affect projection");
});

test("100k apply() calls for session-create-only do not throw and grow records linearly", () => {
  const p = new RuntimeProjection();
  const N = 100000;
  for (let i = 0; i < N; i++) {
    p.apply(sessionStarted({ sessionId: makeRuntimeId("ses"), name: `s-${i}` }));
  }
  const snap = p.toSnapshots();
  assert.equal(snap.sessions.length, N);
  assert.equal(p.rev, N);
});

test("skill.run.finished before started: still creates the record (upsert) and stamps status", () => {
  const p = new RuntimeProjection();
  const runId = makeRuntimeId("skr");
  p.apply(skillRunFinished({ skillRunId: runId, status: "succeeded", summary: "late" }));
  const { skillRuns } = p.toSnapshots();
  assert.equal(skillRuns.length, 1);
  assert.equal(skillRuns[0].id, runId);
  assert.equal(skillRuns[0].status, "succeeded");
  assert.equal(skillRuns[0].summary, "late");
});

test("events with invalid (non-ULID) ids in payload are ignored (no record created)", () => {
  const p = new RuntimeProjection();
  p.apply(
    baseEvent("session.started", {
      session: { id: "ses_001", name: "bad", tier: "manual" },
    }),
  );
  p.apply(baseEvent("job.started", { jobId: "job_xx", sessionId: "ses_yy" }));
  p.apply(baseEvent("skill.run.started", { skillRunId: "skr_bad", skillId: "noop" }));
  const snap = p.toSnapshots();
  assert.deepEqual(snap, { sessions: [], jobs: [], skillRuns: [] });
});
