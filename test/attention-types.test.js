// test/attention-types.test.js — SH-4-01 (TDD v0.5 §6.8)
//
// Acceptance suite for the AttentionItem model + dedupe key. Pure shape
// tests; no runtime store wiring needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_KINDS,
  ATTENTION_SOURCES,
  ATTENTION_SEVERITIES,
  ATTENTION_ACTION_KINDS,
  assertValidAttentionItem,
  assertValidAttentionAction,
} from "../hub/attention/types.js";
import { computeAttentionDedupeKey } from "../hub/attention/dedupe.js";

// --- enum sets: literal-array regressions ----------------------------------

test("ATTENTION_KINDS matches TDD §6.8 exactly", () => {
  assert.ok(Object.isFrozen(ATTENTION_KINDS));
  assert.deepEqual([...ATTENTION_KINDS], [
    "approval_needed",
    "blocked",
    "conflict",
    "outside_allowed_paths",
    "not_responding",
    "quiet",
    "context_high",
    "done_needs_closeout",
    "done_claimed_verify_missing",
    "verify_missing",
    "unbound_session",
  ]);
});

test("ATTENTION_SOURCES matches TDD §6.8 exactly", () => {
  assert.ok(Object.isFrozen(ATTENTION_SOURCES));
  assert.deepEqual([...ATTENTION_SOURCES], [
    "structured",
    "reported",
    "derived",
    "manual",
    "watcher_git",
    "unknown",
  ]);
});

test("ATTENTION_SEVERITIES matches TDD §6.8 exactly", () => {
  assert.ok(Object.isFrozen(ATTENTION_SEVERITIES));
  assert.deepEqual([...ATTENTION_SEVERITIES], ["critical", "high", "medium", "low"]);
});

test("ATTENTION_ACTION_KINDS matches TDD §6.8 exactly (base + v0.7)", () => {
  assert.ok(Object.isFrozen(ATTENTION_ACTION_KINDS));
  assert.deepEqual([...ATTENTION_ACTION_KINDS], [
    // base
    "open_session",
    "open_stdio",
    "open_chat",
    "approve",
    "deny",
    "request_checkpoint",
    "rollover",
    "run_closeout",
    "run_verify",
    "spawn_reviewer",
    "view_conflict",
    "create_worktree",
    "bind_task",
    "copy_context",
    // v0.7 design-integration additions
    "escalate_sandbox",
    "unblock",
    "ask",
    "interrupt",
    "complete_override",
    "attach_task",
    "add_task_then_run",
    "swap_model_live",
    "restart_with_new_model",
    "restart_stricter_sandbox",
    "restart_all_quiet",
    "acknowledge",
    "snooze",
  ]);
});

// --- minimal happy-path item ----------------------------------------------

function minimalItem(overrides) {
  return {
    id: "att_01h00000000000000000000000",
    kind: "approval_needed",
    severity: "high",
    title: "Approve write to /tmp/x",
    detail: "Session ses_… requests workspace-write",
    source: "structured",
    createdAt: "2026-05-24T12:34:56.000Z",
    updatedAt: "2026-05-24T12:34:56.000Z",
    dedupeKey: "approval_needed|||||",
    recommendedActions: [],
    ...overrides,
  };
}

test("assertValidAttentionItem accepts a minimal well-formed item", () => {
  assert.doesNotThrow(() => assertValidAttentionItem(minimalItem()));
});

test("assertValidAttentionItem accepts optional ISO timestamps + optional fields", () => {
  assert.doesNotThrow(() =>
    assertValidAttentionItem(
      minimalItem({
        projectSlug: "demo",
        taskId: "t-1",
        jobId: "job_01h00000000000000000000000",
        sessionId: "ses_01h00000000000000000000000",
        evidenceRef: "evt_01h00000000000000000000000",
        acknowledgedAt: "2026-05-24T12:35:00.000Z",
        snoozedUntil: "2026-05-24T13:00:00.000Z",
        clearedAt: "2026-05-24T14:00:00.000Z",
      }),
    ),
  );
});

// --- assertValidAttentionItem rejections ----------------------------------

test("assertValidAttentionItem rejects unknown kind", () => {
  assert.throws(
    () => assertValidAttentionItem(minimalItem({ kind: "ghost" })),
    /kind 'ghost' not in ATTENTION_KINDS/,
  );
});

test("assertValidAttentionItem rejects unknown severity", () => {
  assert.throws(
    () => assertValidAttentionItem(minimalItem({ severity: "extreme" })),
    /severity 'extreme' not in ATTENTION_SEVERITIES/,
  );
});

test("assertValidAttentionItem rejects unknown source", () => {
  assert.throws(
    () => assertValidAttentionItem(minimalItem({ source: "rumor" })),
    /source 'rumor' not in ATTENTION_SOURCES/,
  );
});

test("assertValidAttentionItem rejects missing dedupeKey", () => {
  const item = minimalItem();
  delete item.dedupeKey;
  assert.throws(() => assertValidAttentionItem(item), /dedupeKey required/);
});

test("assertValidAttentionItem rejects non-array recommendedActions", () => {
  assert.throws(
    () => assertValidAttentionItem(minimalItem({ recommendedActions: "nope" })),
    /recommendedActions must be an array/,
  );
});

test("assertValidAttentionItem rejects malformed createdAt", () => {
  assert.throws(
    () => assertValidAttentionItem(minimalItem({ createdAt: "yesterday" })),
    /createdAt must be an ISO-8601 timestamp/,
  );
});

test("assertValidAttentionItem rejects action with disabledReason but enabled: true", () => {
  const item = minimalItem({
    recommendedActions: [
      {
        id: "act_1",
        label: "Approve",
        kind: "approve",
        enabled: true,
        disabledReason: "shouldn't be here",
      },
    ],
  });
  assert.throws(
    () => assertValidAttentionItem(item),
    /disabledReason only allowed when enabled === false/,
  );
});

// --- assertValidAttentionAction rejections ---------------------------------

test("assertValidAttentionAction rejects unknown action kind", () => {
  assert.throws(
    () =>
      assertValidAttentionAction({
        id: "act_1",
        label: "Foo",
        kind: "foo",
        enabled: true,
      }),
    /kind 'foo' not in ATTENTION_ACTION_KINDS/,
  );
});

test("assertValidAttentionAction rejects missing id/label/kind + wrong enabled type", () => {
  assert.throws(
    () => assertValidAttentionAction({ label: "x", kind: "approve", enabled: true }),
    /id required/,
  );
  assert.throws(
    () => assertValidAttentionAction({ id: "a", kind: "approve", enabled: true }),
    /label required/,
  );
  assert.throws(
    () => assertValidAttentionAction({ id: "a", label: "x", enabled: true }),
    /kind required/,
  );
  assert.throws(
    () => assertValidAttentionAction({ id: "a", label: "x", kind: "approve", enabled: "yes" }),
    /enabled must be a boolean/,
  );
});

// --- computeAttentionDedupeKey --------------------------------------------

test("computeAttentionDedupeKey returns the pipe-joined composite", () => {
  const key = computeAttentionDedupeKey({
    kind: "approval_needed",
    projectSlug: "demo",
    taskId: "t-1",
    jobId: "job_x",
    sessionId: "ses_x",
    evidenceRef: "evt_x",
  });
  assert.equal(key, "approval_needed|demo|t-1|job_x|ses_x|evt_x");
});

test("computeAttentionDedupeKey is deterministic for equal inputs", () => {
  const a = computeAttentionDedupeKey({
    kind: "blocked",
    projectSlug: "demo",
    taskId: "t-1",
  });
  const b = computeAttentionDedupeKey({
    kind: "blocked",
    projectSlug: "demo",
    taskId: "t-1",
  });
  assert.equal(a, b);
});

test("computeAttentionDedupeKey collapses absent optionals to empty segments (not 'undefined')", () => {
  const key = computeAttentionDedupeKey({ kind: "quiet" });
  assert.equal(key, "quiet|||||");
  assert.ok(!key.includes("undefined"));

  const partial = computeAttentionDedupeKey({
    kind: "quiet",
    sessionId: "ses_x",
  });
  assert.equal(partial, "quiet||||ses_x|");
});

test("computeAttentionDedupeKey throws on missing or unknown kind", () => {
  assert.throws(() => computeAttentionDedupeKey({}), /kind required/);
  assert.throws(
    () => computeAttentionDedupeKey({ kind: "ghost" }),
    /not in ATTENTION_KINDS/,
  );
});
