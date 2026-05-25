// test/attention-engine-change-emit.test.js — SH-4-09 (TDD v0.5 §15, §8A.4)
//
// Covers the AttentionEngine `onChange` emission contract added in SH-4-09:
// fired iff compute() changes the user-visible active set (created / cleared
// / ack-ed / snoozed / severity-flipped), silent otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AttentionEngine } from "../hub/attention/engine.js";
import { computeAttentionDedupeKey } from "../hub/attention/dedupe.js";

const ANCHOR_MS = new Date("2026-05-24T12:00:00.000Z").getTime();
function clockAfterMinutes(mins) {
  return new Date(ANCHOR_MS + mins * 60_000);
}

let _counter = 0;
function testMakeId(prefix) {
  _counter += 1;
  return `${prefix}_test_${_counter}`;
}

function makeSession(overrides = {}) {
  return {
    id: "ses_01h00000000000000000000000",
    name: "untasked-1",
    tier: "dumb_terminal",
    status: "active",
    startedAt: "2026-05-24T12:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

/**
 * Build an item-factory rule for `blocked` that lets us inject ack / snooze
 * / severity changes between ticks. The rule reads from a `seq` array of
 * "what this tick should emit" payloads and produces a single item per tick.
 */
function makeProgrammableBlockedRule(seq) {
  let i = 0;
  return ({ now, makeId }) => {
    if (i >= seq.length) return null;
    const tick = seq[i];
    i += 1;
    if (tick === null) return null;
    const item = {
      id: makeId("att"),
      kind: "blocked",
      severity: tick.severity || "medium",
      title: "blocked stub",
      detail: "blocked stub",
      source: "derived",
      sessionId: "ses_blocked",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      dedupeKey: computeAttentionDedupeKey({
        kind: "blocked",
        sessionId: "ses_blocked",
      }),
      recommendedActions: [],
    };
    if (tick.acknowledgedAt) item.acknowledgedAt = tick.acknowledgedAt;
    if (tick.snoozedUntil) item.snoozedUntil = tick.snoozedUntil;
    if (tick.clearedAt) item.clearedAt = tick.clearedAt;
    return item;
  };
}

test(
  "onChange is NOT called when compute() returns the same set as before (idempotent tick)",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(10),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    engine.compute({ sessions: [makeSession()] }); // first tick: added
    assert.equal(calls.length, 1, "first tick should fire (created)");
    assert.equal(calls[0].changes.added.length, 1);

    // Second tick with the same input at the same time: no diff.
    engine.compute({ sessions: [makeSession()] });
    assert.equal(calls.length, 1, "silent tick must not fire onChange");
  },
);

test(
  "new item -> onChange.changes.added.length === 1, removed.length === 0",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(10),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    engine.compute({ sessions: [makeSession()] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].changes.added.length, 1);
    assert.equal(calls[0].changes.removed.length, 0);
    assert.equal(calls[0].scope, "global");
    assert.equal(calls[0].items.length, 1);
    assert.equal(calls[0].items[0].kind, "unbound_session");
  },
);

test(
  "severity flip on same dedupeKey -> onChange.changes.severityChanged.length === 1",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(10),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    // Tick 1: low (5..59 -> low)
    engine.compute({ sessions: [makeSession()] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].changes.added.length, 1);

    // Tick 2: severity escalates to medium (>= 60min)
    engine.now = () => clockAfterMinutes(65);
    engine.compute({ sessions: [makeSession()] });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].changes.severityChanged.length, 1);
    assert.equal(calls[1].changes.added.length, 0);
    assert.equal(calls[1].changes.removed.length, 0);
    assert.equal(calls[1].changes.severityChanged[0].severity, "medium");
  },
);

test(
  "ack transition (undefined -> set) -> onChange.changes.ackChanged.length === 1",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(5),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    const seq = [
      { severity: "medium" }, // tick 1: created, no ack
      { severity: "medium", acknowledgedAt: "2026-05-24T12:05:00.000Z" }, // tick 2: ack
    ];
    engine.registerRule("blocked", makeProgrammableBlockedRule(seq));

    engine.compute({ sessions: [] }); // tick 1
    assert.equal(calls.length, 1);
    assert.equal(calls[0].changes.added.length, 1);

    engine.compute({ sessions: [] }); // tick 2
    assert.equal(calls.length, 2);
    assert.equal(calls[1].changes.ackChanged.length, 1);
    assert.equal(calls[1].changes.added.length, 0);
    assert.equal(calls[1].changes.removed.length, 0);
    assert.equal(
      calls[1].changes.ackChanged[0].acknowledgedAt,
      "2026-05-24T12:05:00.000Z",
    );
  },
);

test(
  "snooze transition -> onChange.changes.snoozeChanged.length === 1",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(5),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    const seq = [
      { severity: "medium" },
      { severity: "medium", snoozedUntil: "2026-05-24T13:00:00.000Z" },
    ];
    engine.registerRule("blocked", makeProgrammableBlockedRule(seq));

    engine.compute({ sessions: [] });
    engine.compute({ sessions: [] });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].changes.snoozeChanged.length, 1);
  },
);

test(
  "attention overlay events require attentionItemId and dedupeKey to identify the same item",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(5),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    engine.registerRule("blocked", ({ now }) => [
      {
        id: "att_a",
        kind: "blocked",
        severity: "medium",
        title: "blocked a",
        detail: "blocked a",
        source: "derived",
        sessionId: "ses_a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        dedupeKey: "blocked|||||a",
        recommendedActions: [],
      },
      {
        id: "att_b",
        kind: "blocked",
        severity: "medium",
        title: "blocked b",
        detail: "blocked b",
        source: "derived",
        sessionId: "ses_b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        dedupeKey: "blocked|||||b",
        recommendedActions: [],
      },
    ]);

    engine.compute({ sessions: [] });
    assert.equal(calls.length, 1);
    assert.equal(
      engine.applyRuntimeEvent({
        type: "attention.ack",
        attentionItemId: "att_a",
        dedupeKey: "blocked|||||b",
        acknowledgedAt: "2026-05-24T12:05:00.000Z",
        ts: "2026-05-24T12:05:00.000Z",
      }),
      true,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      engine.getAll().map((item) => item.acknowledgedAt),
      [undefined, undefined],
    );
  },
);

test(
  "item disappears from new set -> removed.length === 1",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(10),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    // Tick 1: unbound item present.
    engine.compute({ sessions: [makeSession()] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].changes.added.length, 1);

    // Tick 2: session gains a taskId -> rule returns null -> item removed.
    engine.compute({ sessions: [makeSession({ taskId: "t-123" })] });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].changes.removed.length, 1);
    assert.equal(calls[1].changes.added.length, 0);
    assert.equal(calls[1].items.length, 0);
  },
);

test(
  "explicit clearedAt transition on a still-present item counts as removed",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(5),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    const seq = [
      { severity: "medium" },
      { severity: "medium", clearedAt: "2026-05-24T12:06:00.000Z" },
    ];
    engine.registerRule("blocked", makeProgrammableBlockedRule(seq));

    engine.compute({ sessions: [] });
    engine.compute({ sessions: [] });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].changes.removed.length, 1);
  },
);

test(
  "attention.cleared suppresses re-raise while the source condition remains active",
  () => {
    const calls = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(5),
      makeId: testMakeId,
      onChange: (p) => calls.push(p),
    });
    engine.registerRule("blocked", makeProgrammableBlockedRule([
      { severity: "medium" },
      { severity: "medium" },
      null,
      { severity: "medium" },
    ]));

    const [initial] = engine.compute({ sessions: [] });
    assert.equal(
      initial.dedupeKey,
      computeAttentionDedupeKey({ kind: "blocked", sessionId: "ses_blocked" }),
    );
    assert.equal(
      engine.applyRuntimeEvent({
        type: "attention.cleared",
        attentionItemId: initial.id,
        dedupeKey: initial.dedupeKey,
        clearedAt: "2026-05-24T12:06:00.000Z",
        ts: "2026-05-24T12:06:00.000Z",
      }),
      true,
    );
    assert.equal(engine.getAll()[0].clearedAt, "2026-05-24T12:06:00.000Z");
    assert.equal(calls.at(-1).changes.removed.length, 1);

    const stillActive = engine.compute({ sessions: [] });
    assert.deepEqual(stillActive, [], "human-cleared item remains hidden while source still emits it");

    const sourceResolved = engine.compute({ sessions: [] });
    assert.deepEqual(sourceResolved, [], "overlay is dropped once the source condition clears");

    const reraised = engine.compute({ sessions: [] });
    assert.equal(reraised.length, 1, "new source occurrence can surface after real clear");
    assert.equal(reraised[0].clearedAt, undefined);
  },
);

test(
  "default onChange is a no-op (engine without callback works as before)",
  () => {
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(10),
      makeId: testMakeId,
    });
    // No throw, no callback, return value unchanged.
    const items = engine.compute({ sessions: [makeSession()] });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "unbound_session");
  },
);

test(
  "onChange errors are swallowed (engine keeps working)",
  () => {
    const errs = [];
    const engine = new AttentionEngine({
      now: () => clockAfterMinutes(10),
      makeId: testMakeId,
      onChange: () => {
        throw new Error("subscriber boom");
      },
      logger: { warn: () => {}, error: (m) => errs.push(m) },
    });
    const items = engine.compute({ sessions: [makeSession()] });
    assert.equal(items.length, 1);
    assert.ok(errs.some((m) => /subscriber boom/.test(m)));
  },
);
