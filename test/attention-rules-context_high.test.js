// test/attention-rules-context_high.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { contextHighRule } from "../hub/attention/rules/context_high.js";
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

test("context_high: empty input returns []", () => {
  assert.deepEqual(contextHighRule(baseInput()), []);
});

test("context_high: structured app_server warning fires with source=structured", () => {
  const session = {
    id: "ses_ch1",
    warnings: [{ kind: "context_high", percent: 92, source: "app_server" }],
  };
  const items = contextHighRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].severity, "high");
  assert.match(items[0].detail, /92%/);
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "rollover"));
});

test("context_high: contextUsage above threshold fires", () => {
  const session = {
    id: "ses_ch2",
    contextUsage: { percent: 85, source: "mcp" },
  };
  const items = contextHighRule(
    baseInput({ sessions: [session], config: { contextHigh: { thresholdPercent: 80 } } }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "structured");
  assert.match(items[0].detail, /85%/);
});

test("context_high: contextUsage below threshold does NOT fire", () => {
  const session = {
    id: "ses_ch3",
    contextUsage: { percent: 50, source: "mcp" },
  };
  assert.deepEqual(contextHighRule(baseInput({ sessions: [session] })), []);
});

test("context_high: non-structured warning source does NOT fire", () => {
  const session = {
    id: "ses_ch4",
    warnings: [{ kind: "context_high", percent: 99, source: "derived" }],
  };
  assert.deepEqual(contextHighRule(baseInput({ sessions: [session] })), []);
});

test("context_high: trigger gone returns []", () => {
  const session = { id: "ses_ch5", warnings: [] };
  assert.deepEqual(contextHighRule(baseInput({ sessions: [session] })), []);
});
