// test/attention-rules-blocked.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { blockedRule } from "../hub/attention/rules/blocked.js";
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

test("blocked: empty input returns []", () => {
  assert.deepEqual(blockedRule(baseInput()), []);
});

test("blocked: job.status='blocked' produces one structured item", () => {
  const job = {
    id: "job_b1",
    sessionId: "ses_1",
    projectSlug: "p",
    taskId: "T-1",
    status: "blocked",
    blockedReason: "waiting on dep",
  };
  const items = blockedRule(baseInput({ jobs: [job] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].severity, "high");
  assert.equal(items[0].jobId, "job_b1");
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "unblock"));
});

test("blocked: session.status='blocked' with structured statusSource fires", () => {
  const session = {
    id: "ses_b2",
    status: "blocked",
    statusSource: { kind: "mcp", eventId: "evt_1" },
    projectSlug: "p",
    activeJobId: "job_active",
  };
  const items = blockedRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].sessionId, "ses_b2");
  assert.equal(items[0].jobId, "job_active");
});

test("blocked: session.status='blocked' from derived statusSource does NOT fire", () => {
  const session = {
    id: "ses_b3",
    status: "blocked",
    statusSource: { kind: "derived_activity", rule: "quiet_timeout" },
  };
  const items = blockedRule(baseInput({ sessions: [session] }));
  assert.deepEqual(items, []);
});

test("blocked: trigger gone (job.status=running) returns []", () => {
  const job = { id: "job_b4", status: "running" };
  assert.deepEqual(blockedRule(baseInput({ jobs: [job] })), []);
});
