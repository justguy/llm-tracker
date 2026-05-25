// test/attention-rules-done_claimed_verify_missing.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { doneClaimedVerifyMissingRule } from "../hub/attention/rules/done_claimed_verify_missing.js";
import { assertValidAttentionItem } from "../hub/attention/types.js";

let _n = 0;
const makeId = (p) => `${p}_t${(++_n).toString().padStart(26, "0")}`;

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

test("done_claimed_verify_missing: empty input returns []", () => {
  assert.deepEqual(doneClaimedVerifyMissingRule(baseInput()), []);
});

test("done_claimed_verify_missing: tracker complete + verify gate unmet fires structured item", () => {
  const job = {
    id: "job_dcvm1",
    sessionId: "ses_1",
    projectSlug: "p",
    taskId: "T-1",
    completionGates: [
      { id: "g1", kind: "verify_pack", required: true, status: "pending" },
    ],
  };
  const trackerSnapshot = {
    tasks: [{ id: "T-1", projectSlug: "p", status: "complete" }],
  };
  const items = doneClaimedVerifyMissingRule(baseInput({ jobs: [job], trackerSnapshot }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].severity, "high");
  assert.equal(items[0].taskId, "T-1");
  assert.equal(items[0].jobId, "job_dcvm1");
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "run_verify"));
});

test("done_claimed_verify_missing: tracker complete with NO job fires (raw patch path)", () => {
  const trackerSnapshot = {
    tasks: [{ id: "T-2", status: "complete" }],
  };
  const items = doneClaimedVerifyMissingRule(baseInput({ trackerSnapshot }));
  assert.equal(items.length, 1);
  assert.equal(items[0].taskId, "T-2");
  assert.match(items[0].detail, /no_job/);
});

test("done_claimed_verify_missing: tracker complete + all verify gates satisfied does NOT fire", () => {
  const job = {
    id: "job_dcvm3",
    taskId: "T-3",
    completionGates: [
      { id: "g1", kind: "verify_pack", required: true, status: "satisfied" },
    ],
  };
  const trackerSnapshot = { tasks: [{ id: "T-3", status: "complete" }] };
  assert.deepEqual(
    doneClaimedVerifyMissingRule(baseInput({ jobs: [job], trackerSnapshot })),
    [],
  );
});

test("done_claimed_verify_missing: task NOT complete does NOT fire", () => {
  const trackerSnapshot = { tasks: [{ id: "T-4", status: "in_progress" }] };
  assert.deepEqual(doneClaimedVerifyMissingRule(baseInput({ trackerSnapshot })), []);
});
