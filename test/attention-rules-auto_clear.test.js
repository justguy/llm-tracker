// test/attention-rules-auto_clear.test.js — SH-4-04 (TDD v0.5 §8A.3)
//
// Auto-clear wrapper tests. Verify that `wrapRuleWithAutoClear` re-emits
// previously-emitted items with `clearedAt` set when the inner rule
// stops emitting them, and that the rules barrel wires the wrapper onto
// every kind it registers (so engine.compute() broadcasts clears via
// changes.removed end-to-end).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  wrapRuleWithAutoClear,
  wrapRuleWithAutoClearForTest,
} from "../hub/attention/rules/auto_clear.js";
import { AttentionEngine } from "../hub/attention/engine.js";
import { registerAllRules } from "../hub/attention/rules/index.js";
import { quietRule } from "../hub/attention/rules/quiet.js";

const ISO_T0 = "2026-05-24T12:00:00.000Z";
const ISO_T1 = "2026-05-24T12:05:00.000Z";
const ISO_T2 = "2026-05-24T12:10:00.000Z";

function makeIdFactory(prefix) {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}_${n.toString(36).padStart(26, "0")}`;
  };
}

function makeInput({ now, sessions = [], jobs = [] }) {
  return {
    sessions,
    jobs,
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(now),
    config: {},
    makeId: makeIdFactory("att"),
  };
}

function quietSession(id, { withWarning = true } = {}) {
  return {
    id,
    projectSlug: "p",
    taskId: "task-1", // suppress unbound_session so tests scope to quiet rule + wrapper
    status: "active",
    warnings: withWarning ? [{ kind: "quiet_terminal", minutes: 10 }] : [],
  };
}

test("wrapRuleWithAutoClear: trigger present -> item emitted without clearedAt", () => {
  const wrapped = wrapRuleWithAutoClear(quietRule);
  const out = wrapped(makeInput({ now: ISO_T0, sessions: [quietSession("s1")] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].clearedAt, undefined);
  assert.equal(out[0].kind, "quiet");
  assert.equal(out[0].sessionId, "s1");
});

test("wrapRuleWithAutoClear: trigger missing on next tick -> emits clear marker with clearedAt set", () => {
  const wrapped = wrapRuleWithAutoClear(quietRule);
  const first = wrapped(makeInput({ now: ISO_T0, sessions: [quietSession("s1")] }));
  assert.equal(first.length, 1);
  const dedupeKey = first[0].dedupeKey;

  // No warnings on tick 2 -> inner rule returns []. Wrapper must emit the
  // prior item once with clearedAt set.
  const cleared = wrapped(makeInput({ now: ISO_T1, sessions: [{ id: "s1", projectSlug: "p", status: "active", warnings: [] }] }));
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].dedupeKey, dedupeKey);
  assert.equal(cleared[0].clearedAt, ISO_T1);
  assert.equal(cleared[0].updatedAt, ISO_T1);
  // Identity fields must round-trip from the prior item.
  assert.equal(cleared[0].sessionId, "s1");
  assert.equal(cleared[0].kind, "quiet");
});

test("wrapRuleWithAutoClear: trigger missing for multiple ticks -> clear marker emitted exactly once", () => {
  const wrapped = wrapRuleWithAutoClear(quietRule);
  wrapped(makeInput({ now: ISO_T0, sessions: [quietSession("s1")] }));

  const cleared = wrapped(makeInput({ now: ISO_T1, sessions: [] }));
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].clearedAt, ISO_T1);

  const after = wrapped(makeInput({ now: ISO_T2, sessions: [] }));
  assert.equal(after.length, 0, "wrapper must not re-emit a cleared item");
});

test("wrapRuleWithAutoClear: trigger returns after clear -> fresh raise without clearedAt", () => {
  const wrapped = wrapRuleWithAutoClear(quietRule);
  wrapped(makeInput({ now: ISO_T0, sessions: [quietSession("s1")] }));
  const cleared = wrapped(makeInput({ now: ISO_T1, sessions: [] }));
  assert.equal(cleared[0].clearedAt, ISO_T1);

  const raised = wrapped(makeInput({ now: ISO_T2, sessions: [quietSession("s1")] }));
  assert.equal(raised.length, 1);
  assert.equal(raised[0].clearedAt, undefined, "fresh raise must not carry stale clearedAt");
});

test("wrapRuleWithAutoClear: inner returns null/undefined/single-object — handled", () => {
  const nullRule = () => null;
  const undefinedRule = () => undefined;
  const singleRule = (input) => ({
    id: "att_x",
    kind: "quiet",
    severity: "low",
    title: "t",
    detail: "d",
    source: "derived",
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    dedupeKey: "k1",
    recommendedActions: [],
  });

  assert.deepEqual(wrapRuleWithAutoClear(nullRule)(makeInput({ now: ISO_T0 })), []);
  assert.deepEqual(wrapRuleWithAutoClear(undefinedRule)(makeInput({ now: ISO_T0 })), []);

  const wrapped = wrapRuleWithAutoClear(singleRule);
  const first = wrapped(makeInput({ now: ISO_T0 }));
  assert.equal(first.length, 1);
  assert.equal(first[0].dedupeKey, "k1");
});

test("wrapRuleWithAutoClear: inner rule throws -> wrapper re-throws and preserves prior so clear still fires on the next non-throw tick", () => {
  let mode = "ok";
  const rule = (input) => {
    if (mode === "throw") throw new Error("inner boom");
    if (mode === "absent") return [];
    return quietRule(input);
  };
  const wrapped = wrapRuleWithAutoClear(rule);
  // tick 1: rule emits
  const first = wrapped(makeInput({ now: ISO_T0, sessions: [quietSession("s1")] }));
  assert.equal(first.length, 1);

  // tick 2: rule throws -> wrapper re-throws
  mode = "throw";
  assert.throws(() => wrapped(makeInput({ now: ISO_T1, sessions: [] })), /inner boom/);

  // tick 3: rule no longer emits -> wrapper still emits clear marker for the
  // item it has not yet seen drop.
  mode = "absent";
  const cleared = wrapped(makeInput({ now: ISO_T2, sessions: [] }));
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].clearedAt, ISO_T2);
});

test("wrapRuleWithAutoClearForTest exposes the prior map for inspection", () => {
  const { wrapped, peekPrior } = wrapRuleWithAutoClearForTest(quietRule);
  assert.equal(peekPrior().size, 0);

  wrapped(makeInput({ now: ISO_T0, sessions: [quietSession("s1"), quietSession("s2")] }));
  assert.equal(peekPrior().size, 2);

  wrapped(makeInput({ now: ISO_T1, sessions: [] }));
  // After the clear emission tick, prior should be empty (nothing emitted by
  // the inner rule on this tick).
  assert.equal(peekPrior().size, 0);
});

test("wrapRuleWithAutoClear: rejects non-function input", () => {
  assert.throws(() => wrapRuleWithAutoClear(null), TypeError);
  assert.throws(() => wrapRuleWithAutoClear({}), TypeError);
  assert.throws(() => wrapRuleWithAutoClear(42), TypeError);
});

test("rules/index.js + AttentionEngine: when trigger goes away, changes.removed contains the cleared item with clearedAt set", () => {
  /** @type {any[]} */
  const calls = [];
  const engine = new AttentionEngine({
    now: () => new Date(ISO_T0),
    makeId: makeIdFactory("att"),
    onChange: (payload) => calls.push(payload),
  });
  registerAllRules(engine);

  // Tick 1: session has the quiet_terminal warning.
  engine.compute({
    sessions: [quietSession("s1")],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T0),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].changes.added.length, 1);
  assert.equal(calls[0].changes.removed.length, 0);
  const dedupeKey = calls[0].changes.added[0].dedupeKey;

  // Tick 2: warning gone -> inner rule emits nothing -> wrapper emits clear
  // marker. Engine broadcasts changes.removed with clearedAt set.
  engine.compute({
    sessions: [quietSession("s1", { withWarning: false })],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T1),
  });
  assert.equal(calls.length, 2);
  const removed = calls[1].changes.removed;
  assert.equal(removed.length, 1);
  assert.equal(removed[0].dedupeKey, dedupeKey);
  assert.equal(removed[0].clearedAt, ISO_T1);
});

test("rules/index.js + AttentionEngine: trigger returning after clear re-raises without stale clearedAt", () => {
  /** @type {any[]} */
  const calls = [];
  const engine = new AttentionEngine({
    now: () => new Date(ISO_T0),
    makeId: makeIdFactory("att"),
    onChange: (payload) => calls.push(payload),
  });
  registerAllRules(engine);

  engine.compute({
    sessions: [quietSession("s1")],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T0),
  });

  engine.compute({
    sessions: [quietSession("s1", { withWarning: false })],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T1),
  });
  assert.equal(calls[1].changes.removed.length, 1);
  assert.equal(calls[1].changes.removed[0].clearedAt, ISO_T1);

  const reraised = engine.compute({
    sessions: [quietSession("s1")],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T2),
  });

  assert.equal(reraised.length, 1);
  assert.equal(reraised[0].clearedAt, undefined, "re-raised item must not inherit stale clearedAt");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].changes.added.length, 1);
  assert.equal(calls[2].changes.added[0].clearedAt, undefined);
});

test("rules/index.js + AttentionEngine: trigger staying absent does not emit duplicate removed broadcasts", () => {
  /** @type {any[]} */
  const calls = [];
  const engine = new AttentionEngine({
    now: () => new Date(ISO_T0),
    makeId: makeIdFactory("att"),
    onChange: (payload) => calls.push(payload),
  });
  registerAllRules(engine);

  engine.compute({
    sessions: [quietSession("s1")],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T0),
  });
  engine.compute({
    sessions: [quietSession("s1", { withWarning: false })],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T1),
  });
  engine.compute({
    sessions: [quietSession("s1", { withWarning: false })],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T2),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].changes.removed.length, 1);
});

test("rules/index.js + AttentionEngine: ack/snooze paths are unaffected by auto-clear when the trigger is still active", () => {
  const engine = new AttentionEngine({
    now: () => new Date(ISO_T0),
    makeId: makeIdFactory("att"),
  });
  registerAllRules(engine);

  // Trigger is still present on tick 2 — no clear marker should be emitted.
  engine.compute({
    sessions: [quietSession("s1")],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T0),
  });
  const tick2 = engine.compute({
    sessions: [quietSession("s1")],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
    now: new Date(ISO_T1),
  });
  assert.equal(tick2.length, 1);
  assert.equal(tick2[0].clearedAt, undefined);
});
