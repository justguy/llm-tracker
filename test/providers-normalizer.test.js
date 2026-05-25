// test/providers-normalizer.test.js — SH-2-19 (addendum §8)
//
// ProviderEvent union shape + normalizer acceptance tests. We assert two
// kinds of invariants:
//   1. Per-kind output shape (RuntimeEvents validate against the schema;
//      timeline + attention intents carry the right correlation refs).
//   2. The §8 negative invariant: `file_change.applied` NEVER emits a
//      session.warning_cleared file_conflict event.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_EVENT_KINDS,
  assertValidProviderEvent,
} from "../hub/providers/provider-events.js";
import { normalize, DEFAULT_CONTEXT_HIGH_PERCENT } from "../hub/providers/normalizer.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const TS = "2026-05-24T12:00:00.000Z";
const SESSION = "ses_01ksd83zzzzzzzzzzzzzzzzzzz";
const WORKSPACE = "/tmp/test-workspace";

function deps(extra) {
  return {
    sessionId: SESSION,
    workspace: WORKSPACE,
    makeRuntimeId,
    now: () => TS,
    ...extra,
  };
}

function assertEveryRuntimeEventValidates(events) {
  for (const e of events) {
    validateRuntimeEvent(e);
  }
}

// -- ProviderEvent shape --------------------------------------------------

test("PROVIDER_EVENT_KINDS: frozen list matches the addendum §8 union", () => {
  assert.ok(Object.isFrozen(PROVIDER_EVENT_KINDS));
  assert.deepEqual(
    [...PROVIDER_EVENT_KINDS].sort(),
    [
      "approval.requested",
      "approval.resolved",
      "command.completed",
      "command.output",
      "command.started",
      "context.usage",
      "file_change.applied",
      "file_change.proposed",
      "message",
      "provider.error",
      "thread.forked",
      "thread.resumed",
      "thread.started",
      "turn.completed",
      "turn.started",
    ],
  );
});

test("assertValidProviderEvent: rejects shape violations with a tagged error", () => {
  const cases = [
    [null, /event must be an object/],
    [{}, /unknown kind/],
    [{ kind: "not-a-kind" }, /unknown kind/],
    [{ kind: "thread.started", ts: TS }, /providerId/],
    [{ kind: "thread.started", providerId: "p", threadRef: {} }, /ts/],
    [{ kind: "turn.completed", providerId: "p", ts: TS, threadId: "t", turnId: "u", status: "bogus" }, /status must be one of/],
    [{ kind: "message", providerId: "p", ts: TS, threadId: "t", role: "alien", text: "" }, /role must be one of/],
    [{ kind: "context.usage", providerId: "p", ts: TS, threadId: "t", used: 1, total: 1, percent: 150 }, /percent must be in/],
    [{ kind: "file_change.proposed", providerId: "p", ts: TS, threadId: "t", proposalId: "x", files: [] }, /files must be a non-empty string\[\]/],
    [{ kind: "approval.resolved", providerId: "p", ts: TS, threadId: "t", approvalId: "x", decision: "meh" }, /decision must be one of/],
  ];
  for (const [event, rx] of cases) {
    assert.throws(() => assertValidProviderEvent(event), rx);
  }
});

test("assertValidProviderEvent: accepts each known-good shape", () => {
  const samples = [
    { kind: "thread.started", providerId: "p", ts: TS, threadRef: {} },
    { kind: "thread.resumed", providerId: "p", ts: TS, threadRef: {} },
    { kind: "thread.forked", providerId: "p", ts: TS, threadRef: {}, parentThreadId: "t0" },
    { kind: "turn.started", providerId: "p", ts: TS, threadId: "t", turnId: "u" },
    { kind: "turn.completed", providerId: "p", ts: TS, threadId: "t", turnId: "u", status: "succeeded" },
    { kind: "message", providerId: "p", ts: TS, threadId: "t", role: "assistant", text: "hi" },
    { kind: "command.started", providerId: "p", ts: TS, threadId: "t", commandId: "c", command: "ls" },
    { kind: "command.output", providerId: "p", ts: TS, threadId: "t", commandId: "c", stream: "stdout", text: "x" },
    { kind: "command.completed", providerId: "p", ts: TS, threadId: "t", commandId: "c", exitCode: 0 },
    { kind: "file_change.proposed", providerId: "p", ts: TS, threadId: "t", proposalId: "x", files: ["a.txt"] },
    { kind: "file_change.applied", providerId: "p", ts: TS, threadId: "t", proposalId: "x", files: ["a.txt"] },
    { kind: "approval.requested", providerId: "p", ts: TS, threadId: "t", approvalId: "a", title: "T" },
    { kind: "approval.resolved", providerId: "p", ts: TS, threadId: "t", approvalId: "a", decision: "approved" },
    { kind: "context.usage", providerId: "p", ts: TS, threadId: "t", used: 1000, total: 2000, percent: 50 },
    { kind: "provider.error", providerId: "p", ts: TS, message: "boom" },
  ];
  for (const s of samples) assertValidProviderEvent(s);
});

// -- normalize() top-level contract ---------------------------------------

test("normalize: rejects missing sessionId / workspace / makeRuntimeId", () => {
  const evt = { kind: "thread.started", providerId: "p", ts: TS, threadRef: {} };
  assert.throws(() => normalize(evt, { workspace: WORKSPACE, makeRuntimeId }), /sessionId/);
  assert.throws(() => normalize(evt, { sessionId: SESSION, makeRuntimeId }), /workspace/);
  assert.throws(() => normalize(evt, { sessionId: SESSION, workspace: WORKSPACE }), /makeRuntimeId/);
});

// -- per-kind mappings -----------------------------------------------------

test("normalize: thread.started / .resumed / .forked → TimelineItem only", () => {
  for (const kind of ["thread.started", "thread.resumed", "thread.forked"]) {
    const r = normalize(
      { kind, providerId: "p", ts: TS, threadRef: { threadId: "t" }, parentThreadId: "t0" },
      deps(),
    );
    assert.equal(r.runtimeEvents.length, 0);
    assert.equal(r.attentionIntents.length, 0);
    assert.equal(r.timelineItems.length, 1);
    assert.equal(r.timelineItems[0].kind, "thread");
    assert.equal(r.timelineItems[0].data.phase, kind.split(".")[1]);
  }
});

test("normalize: approval.requested → status + warning + AttentionIntent + Timeline", () => {
  const r = normalize(
    {
      kind: "approval.requested",
      providerId: "codex-app-server",
      ts: TS,
      threadId: "t1",
      approvalId: "a1",
      title: "may I run `rm -rf`?",
      detail: "rationale...",
    },
    deps(),
  );

  assert.equal(r.runtimeEvents.length, 2);
  const status = r.runtimeEvents.find((e) => e.type === "session.status");
  const warning = r.runtimeEvents.find((e) => e.type === "session.warning");
  assert.equal(status.status, "waiting_for_approval");
  assert.equal(warning.warning.kind, "approval_needed");
  assert.equal(warning.warning.actionId, "a1");
  assert.equal(warning.workspace, WORKSPACE);
  assert.equal(warning.sessionId, SESSION);
  assertEveryRuntimeEventValidates(r.runtimeEvents);

  assert.equal(r.attentionIntents.length, 1);
  assert.equal(r.attentionIntents[0].kind, "approval_needed");
  assert.equal(r.attentionIntents[0].action, "raise");
  assert.equal(r.attentionIntents[0].refId, "a1");
  assert.equal(r.attentionIntents[0].severity, "high");

  assert.equal(r.timelineItems.length, 1);
  assert.equal(r.timelineItems[0].kind, "approval");
  assert.equal(r.timelineItems[0].data.phase, "requested");
});

test("normalize: approval.resolved → warning_cleared + clear intent + Timeline", () => {
  const r = normalize(
    {
      kind: "approval.resolved",
      providerId: "p",
      ts: TS,
      threadId: "t1",
      approvalId: "a1",
      decision: "approved",
    },
    deps(),
  );
  assert.equal(r.runtimeEvents.length, 1);
  assert.equal(r.runtimeEvents[0].type, "session.warning_cleared");
  assert.equal(r.runtimeEvents[0].warningKind, "approval_needed");
  assertEveryRuntimeEventValidates(r.runtimeEvents);

  assert.equal(r.attentionIntents.length, 1);
  assert.equal(r.attentionIntents[0].action, "clear");
  assert.equal(r.timelineItems[0].data.decision, "approved");
});

test("normalize: context.usage at-or-above threshold → context_high status+warning+intent; below → timeline only", () => {
  const above = normalize(
    {
      kind: "context.usage",
      providerId: "p",
      ts: TS,
      threadId: "t1",
      used: 90000,
      total: 100000,
      percent: 90,
    },
    deps({ contextHighPercent: 80 }),
  );
  assert.equal(above.runtimeEvents.length, 2);
  assert.equal(above.runtimeEvents[0].status, "context_high");
  assert.equal(above.runtimeEvents[1].warning.kind, "context_high");
  assert.equal(above.runtimeEvents[1].warning.percent, 90);
  assert.equal(above.attentionIntents[0].kind, "context_high");
  assertEveryRuntimeEventValidates(above.runtimeEvents);

  const below = normalize(
    {
      kind: "context.usage",
      providerId: "p",
      ts: TS,
      threadId: "t1",
      used: 10000,
      total: 100000,
      percent: 10,
    },
    deps({ contextHighPercent: 80 }),
  );
  assert.equal(below.runtimeEvents.length, 0);
  assert.equal(below.attentionIntents.length, 0);
  assert.equal(below.timelineItems.length, 1);
  assert.equal(below.timelineItems[0].kind, "context_usage");
});

test("normalize: file_change.proposed → Timeline only; no conflict cleared", () => {
  const r = normalize(
    {
      kind: "file_change.proposed",
      providerId: "p",
      ts: TS,
      threadId: "t",
      proposalId: "pr1",
      files: ["a.ts", "b.ts"],
      summary: "refactor",
    },
    deps(),
  );
  assert.equal(r.runtimeEvents.length, 0);
  assert.equal(r.timelineItems.length, 1);
  assert.equal(r.timelineItems[0].kind, "file_change");
  assert.equal(r.timelineItems[0].data.phase, "proposed");
  assert.deepEqual(r.timelineItems[0].data.files, ["a.ts", "b.ts"]);
});

test("file_change.applied NEVER clears conflict warnings (addendum §8 invariant)", () => {
  // Regression test for the negative invariant — provider-reported file
  // paths annotate via TimelineItem, but the normalizer must NOT emit a
  // session.warning_cleared file_conflict event. Conflict-clearing
  // requires watcher/git evidence per TDD §7.
  const r = normalize(
    {
      kind: "file_change.applied",
      providerId: "p",
      ts: TS,
      threadId: "t",
      proposalId: "pr1",
      files: ["a.ts"],
    },
    deps(),
  );

  // No RuntimeEvents at all.
  assert.equal(r.runtimeEvents.length, 0, "file_change.applied emits no RuntimeEvents");

  // Specifically: no warning_cleared of kind file_conflict.
  const conflictCleared = r.runtimeEvents.find(
    (e) => e.type === "session.warning_cleared" && e.warningKind === "file_conflict",
  );
  assert.equal(conflictCleared, undefined, "file_change.applied must not clear file_conflict");

  // TimelineItem present for annotation.
  assert.equal(r.timelineItems.length, 1);
  assert.equal(r.timelineItems[0].kind, "file_change");
  assert.equal(r.timelineItems[0].data.phase, "applied");
});

test("normalize: command.* → Timeline only (verify-gate gated to Phase 5)", () => {
  const started = normalize(
    { kind: "command.started", providerId: "p", ts: TS, threadId: "t", commandId: "c", command: "ls", cwd: "/tmp" },
    deps(),
  );
  assert.equal(started.runtimeEvents.length, 0);
  assert.equal(started.timelineItems[0].data.phase, "started");
  assert.equal(started.timelineItems[0].data.cwd, "/tmp");

  const output = normalize(
    { kind: "command.output", providerId: "p", ts: TS, threadId: "t", commandId: "c", stream: "stderr", text: "warn" },
    deps(),
  );
  assert.equal(output.timelineItems[0].data.stream, "stderr");

  const done = normalize(
    { kind: "command.completed", providerId: "p", ts: TS, threadId: "t", commandId: "c", exitCode: 0, durationMs: 12 },
    deps(),
  );
  assert.equal(done.timelineItems[0].data.exitCode, 0);
  assert.equal(done.timelineItems[0].data.durationMs, 12);
});

test("normalize: message → Timeline only; never status", () => {
  const r = normalize(
    { kind: "message", providerId: "p", ts: TS, threadId: "t", role: "assistant", text: "hi" },
    deps(),
  );
  assert.equal(r.runtimeEvents.length, 0);
  assert.equal(r.timelineItems[0].data.role, "assistant");
});

test("normalize: provider.error → Timeline (severity=high), no warning event", () => {
  const r = normalize(
    { kind: "provider.error", providerId: "p", ts: TS, code: "ECONNRESET", message: "transport dropped", retryable: true },
    deps(),
  );
  assert.equal(r.runtimeEvents.length, 0);
  assert.equal(r.timelineItems.length, 1);
  assert.equal(r.timelineItems[0].severity, "high");
  assert.equal(r.timelineItems[0].kind, "provider_error");
  assert.equal(r.timelineItems[0].data.code, "ECONNRESET");
});

test("normalize: default contextHighPercent is DEFAULT_CONTEXT_HIGH_PERCENT", () => {
  // 80 is the default; events at exactly the threshold should promote.
  const r = normalize(
    { kind: "context.usage", providerId: "p", ts: TS, threadId: "t", used: 80, total: 100, percent: DEFAULT_CONTEXT_HIGH_PERCENT },
    deps(), // no override
  );
  assert.equal(r.runtimeEvents.length, 2);
  assert.equal(r.runtimeEvents[0].status, "context_high");
});
