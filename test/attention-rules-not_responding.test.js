// test/attention-rules-not_responding.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { notRespondingRule } from "../hub/attention/rules/not_responding.js";
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

test("not_responding: empty input returns []", () => {
  assert.deepEqual(notRespondingRule(baseInput()), []);
});

test("not_responding: dumb-terminal tier yields source=reported", () => {
  const session = {
    id: "ses_nr1",
    capabilityTier: "dumb",
    warnings: [{ kind: "missing_heartbeat", minutes: 12 }],
  };
  const items = notRespondingRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "reported");
  assert.equal(items[0].severity, "high");
  assert.match(items[0].detail, /12m/);
});

test("not_responding: mcp tier yields source=structured", () => {
  const session = {
    id: "ses_nr2",
    capabilityTier: "mcp",
    warnings: [{ kind: "missing_heartbeat", minutes: 5 }],
  };
  const items = notRespondingRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "structured");
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "open_session"));
});

test("not_responding: explicit tier also yields source=structured", () => {
  const session = {
    id: "ses_nr3",
    capabilityTier: "explicit",
    warnings: [{ kind: "missing_heartbeat", minutes: 5 }],
  };
  const items = notRespondingRule(baseInput({ sessions: [session] }));
  assert.equal(items[0].source, "structured");
});

test("not_responding: trigger gone (warning cleared) returns []", () => {
  const session = { id: "ses_nr4", capabilityTier: "mcp", warnings: [] };
  assert.deepEqual(notRespondingRule(baseInput({ sessions: [session] })), []);
});
