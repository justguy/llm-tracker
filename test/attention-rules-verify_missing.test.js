// test/attention-rules-verify_missing.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyMissingRule } from "../hub/attention/rules/verify_missing.js";
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

test("verify_missing: empty input returns []", () => {
  assert.deepEqual(verifyMissingRule(baseInput()), []);
});

test("verify_missing: running job without verify_pack gate fires structured item", () => {
  const job = {
    id: "job_vm1",
    sessionId: "ses_1",
    projectSlug: "p",
    taskId: "T-1",
    status: "running",
    completionGates: [
      { id: "g1", kind: "dod_checked", required: true, status: "pending" },
    ],
  };
  const items = verifyMissingRule(baseInput({ jobs: [job] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].severity, "medium");
  assert.equal(items[0].jobId, "job_vm1");
});

test("verify_missing: running job WITH required verify_pack gate does NOT fire", () => {
  const job = {
    id: "job_vm2",
    status: "running",
    completionGates: [
      { id: "g1", kind: "verify_pack", required: true, status: "pending" },
    ],
  };
  assert.deepEqual(verifyMissingRule(baseInput({ jobs: [job] })), []);
});

test("verify_missing: queued job does NOT fire (verify not yet expected)", () => {
  const job = { id: "job_vm3", status: "queued", completionGates: [] };
  assert.deepEqual(verifyMissingRule(baseInput({ jobs: [job] })), []);
});

test("verify_missing: verify_pack_empty warning surfaces standalone item", () => {
  const items = verifyMissingRule(
    baseInput({
      warnings: [
        { kind: "verify_pack_empty", jobId: "job_vm4", taskId: "T-4", projectSlug: "p" },
      ],
    }),
  );
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].jobId, "job_vm4");
  assert.equal(items[0].taskId, "T-4");
});

test("verify_missing: trigger gone returns []", () => {
  assert.deepEqual(verifyMissingRule(baseInput()), []);
});
