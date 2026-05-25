// test/attention-rules-done_needs_closeout.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { doneNeedsCloseoutRule } from "../hub/attention/rules/done_needs_closeout.js";
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

test("done_needs_closeout: empty input returns []", () => {
  assert.deepEqual(doneNeedsCloseoutRule(baseInput()), []);
});

test("done_needs_closeout: completed job with pending handoff gate fires", () => {
  const job = {
    id: "job_dnc1",
    sessionId: "ses_1",
    projectSlug: "p",
    taskId: "T-1",
    status: "completed",
    completionGates: [
      { id: "g1", kind: "handoff_created", required: true, status: "pending" },
      { id: "g2", kind: "verify_pack", required: true, status: "satisfied" },
    ],
  };
  const items = doneNeedsCloseoutRule(baseInput({ jobs: [job] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].severity, "medium");
  assert.equal(items[0].jobId, "job_dnc1");
  assert.match(items[0].detail, /handoff_created/);
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "run_closeout"));
});

test("done_needs_closeout: completed job with all closeout gates satisfied does NOT fire", () => {
  const job = {
    id: "job_dnc2",
    status: "completed",
    completionGates: [
      { id: "g1", kind: "handoff_created", required: true, status: "satisfied" },
      { id: "g2", kind: "dod_checked", required: true, status: "overridden" },
    ],
  };
  assert.deepEqual(doneNeedsCloseoutRule(baseInput({ jobs: [job] })), []);
});

test("done_needs_closeout: running job (not completed) does NOT fire", () => {
  const job = {
    id: "job_dnc3",
    status: "running",
    completionGates: [
      { id: "g1", kind: "handoff_created", required: true, status: "pending" },
    ],
  };
  assert.deepEqual(doneNeedsCloseoutRule(baseInput({ jobs: [job] })), []);
});

test("done_needs_closeout: optional closeout gate does NOT fire", () => {
  const job = {
    id: "job_dnc4",
    status: "completed",
    completionGates: [
      { id: "g1", kind: "handoff_created", required: false, status: "pending" },
    ],
  };
  assert.deepEqual(doneNeedsCloseoutRule(baseInput({ jobs: [job] })), []);
});
