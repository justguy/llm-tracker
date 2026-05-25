// test/attention-rules-quiet.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { quietRule } from "../hub/attention/rules/quiet.js";
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

test("quiet: empty input returns []", () => {
  assert.deepEqual(quietRule(baseInput()), []);
});

test("quiet: quiet_terminal warning yields source=derived (per §8A.3)", () => {
  const session = {
    id: "ses_q1",
    projectSlug: "p",
    warnings: [{ kind: "quiet_terminal", minutes: 9 }],
  };
  const items = quietRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "derived");
  assert.equal(items[0].severity, "low");
  assert.match(items[0].detail, /9m/);
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "open_stdio"));
});

test("quiet: only fires when warning present (not from raw stdio absence)", () => {
  const session = { id: "ses_q2", warnings: [] };
  assert.deepEqual(quietRule(baseInput({ sessions: [session] })), []);
});

test("quiet: trigger gone returns []", () => {
  const session = {
    id: "ses_q3",
    warnings: [{ kind: "missing_heartbeat", minutes: 5 }],
  };
  assert.deepEqual(quietRule(baseInput({ sessions: [session] })), []);
});
