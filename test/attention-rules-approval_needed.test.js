// test/attention-rules-approval_needed.test.js — SH-4-03
//
// Per-kind rule tests for `approval_needed` (TDD §8A.3, §6.8).

import { test } from "node:test";
import assert from "node:assert/strict";

import { approvalNeededRule } from "../hub/attention/rules/approval_needed.js";
import { assertValidAttentionItem } from "../hub/attention/types.js";
import { computeAttentionDedupeKey } from "../hub/attention/dedupe.js";

let _n = 0;
function makeId(prefix) {
  _n += 1;
  return `${prefix}_t${_n.toString().padStart(26, "0")}`;
}

function baseInput(overrides = {}) {
  return {
    sessions: [],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date("2026-05-24T12:00:00.000Z"),
    config: {},
    makeId,
    ...overrides,
  };
}

test("approval_needed: empty input returns []", () => {
  const items = approvalNeededRule(baseInput());
  assert.deepEqual(items, []);
});

test("approval_needed: session warning produces one valid item with source=structured", () => {
  const session = {
    id: "ses_01h00000000000000000000001",
    projectSlug: "proj",
    taskId: "T-1",
    activeJobId: "job_1",
    warnings: [{ kind: "approval_needed", source: "app_server", actionId: "appr_42" }],
  };
  const items = approvalNeededRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  const item = items[0];
  assertValidAttentionItem(item);
  assert.equal(item.kind, "approval_needed");
  assert.equal(item.source, "structured");
  assert.equal(item.severity, "critical");
  assert.equal(item.sessionId, "ses_01h00000000000000000000001");
  assert.equal(item.taskId, "T-1");
  assert.equal(item.jobId, "job_1");
  assert.equal(item.projectSlug, "proj");
  assert.equal(item.evidenceRef, "appr_42");
  assert.equal(
    item.dedupeKey,
    computeAttentionDedupeKey({
      kind: "approval_needed",
      projectSlug: "proj",
      sessionId: "ses_01h00000000000000000000001",
      evidenceRef: "appr_42",
    }),
  );
  assert.ok(item.recommendedActions.length > 0, "recommendedActions non-empty");
  assert.ok(item.recommendedActions.some((a) => a.kind === "approve"));
});

test("approval_needed: pending human verify gate on job produces structured item", () => {
  const job = {
    id: "job_2",
    sessionId: "ses_2",
    projectSlug: "proj",
    taskId: "T-2",
    completionGates: [
      {
        id: "g1",
        kind: "verify_pack",
        required: true,
        status: "pending",
        humanApproval: true,
      },
    ],
  };
  const items = approvalNeededRule(baseInput({ jobs: [job] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].jobId, "job_2");
  assert.equal(items[0].evidenceRef, "g1");
});

test("approval_needed: requested human approval projects required and optional labels", () => {
  const job = {
    id: "job_4",
    sessionId: "ses_4",
    projectSlug: "proj",
    taskId: "T-4",
    humanApprovalRequests: [
      {
        itemId: "approve.ship",
        status: "pending",
        eventId: "evt_01h00000000000000000000001",
        required: true,
        blocksCompletion: true,
        title: "HUMAN APPROVAL REQUIRED",
        prompt: "Ship?",
      },
      {
        itemId: "review.notes",
        status: "pending",
        eventId: "evt_01h00000000000000000000002",
        required: false,
        blocksCompletion: false,
        title: "HUMAN REVIEW READY",
        prompt: "Review notes",
      },
    ],
    completionGates: [
      {
        id: "approve.ship",
        kind: "verify_pack",
        required: true,
        status: "pending",
        humanApproval: true,
        requestedEventId: "evt_01h00000000000000000000001",
      },
    ],
  };
  const items = approvalNeededRule(baseInput({ jobs: [job] }));
  assert.equal(items.length, 2);
  assertValidAttentionItem(items[0]);
  assertValidAttentionItem(items[1]);
  assert.equal(items[0].title, "HUMAN APPROVAL REQUIRED");
  assert.equal(items[0].severity, "critical");
  assert.equal(items[0].evidenceRef, "evt_01h00000000000000000000001");
  assert.equal(items[1].title, "HUMAN REVIEW READY");
  assert.equal(items[1].severity, "medium");
  assert.equal(items[1].evidenceRef, "evt_01h00000000000000000000002");
});

test("approval_needed: non-human verify gate does NOT trigger", () => {
  const job = {
    id: "job_3",
    completionGates: [
      { id: "g1", kind: "verify_pack", required: true, status: "pending" },
    ],
  };
  const items = approvalNeededRule(baseInput({ jobs: [job] }));
  assert.deepEqual(items, []);
});

test("approval_needed: trigger gone (warning cleared) returns []", () => {
  const session = {
    id: "ses_3",
    warnings: [{ kind: "quiet_terminal", minutes: 10 }],
  };
  const items = approvalNeededRule(baseInput({ sessions: [session] }));
  assert.deepEqual(items, []);
});
