// test/attention-engine.test.js — SH-4-02 (TDD v0.5 §8A.3, §8A.4, §25)
//
// Engine + projection scaffolding tests. Covers the §8A.3 priority comparator
// over stub items (sh-4-03 will fill the real rules), the v0.7
// `unbound_session` rule end-to-end (raise / escalate / auto-archive / clear),
// dedupe-key determinism, and the rule-registry slot for sh-4-03.
//
// Do NOT run `npm test` — node --test directly, single-concurrency per the
// task brief.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AttentionEngine,
  PRIORITY_RANK,
  DEFAULT_UNTASKED_SESSIONS_CONFIG,
  compareByPriority,
  unboundSessionRule,
} from "../hub/attention/engine.js";
import { AttentionProjection } from "../hub/attention/projection.js";
import { computeAttentionDedupeKey } from "../hub/attention/dedupe.js";
import { ATTENTION_KINDS } from "../hub/attention/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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
 * Build a fixed-clock `now()` ms-after-startedAt.
 * Anchored to the fixture session.startedAt.
 */
const ANCHOR_MS = new Date("2026-05-24T12:00:00.000Z").getTime();
function clockAfterMinutes(mins) {
  return new Date(ANCHOR_MS + mins * 60_000);
}

// Test-only id factory; we don't care about ULID shape.
let _counter = 0;
function testMakeId(prefix) {
  _counter += 1;
  return `${prefix}_test_${_counter}`;
}

// ---------------------------------------------------------------------------
// PRIORITY_RANK + comparator (§8A.3)
// ---------------------------------------------------------------------------

test("PRIORITY_RANK covers every canonical AttentionKind", () => {
  for (const kind of ATTENTION_KINDS) {
    assert.equal(
      typeof PRIORITY_RANK[kind],
      "number",
      `missing rank for '${kind}'`,
    );
  }
});

test("PRIORITY_RANK matches TDD §8A.3 Critical → Low order", () => {
  // Critical
  assert.equal(PRIORITY_RANK.approval_needed, 1);
  assert.equal(PRIORITY_RANK.conflict, 2);
  assert.equal(PRIORITY_RANK.outside_allowed_paths, 2);
  // High
  assert.equal(PRIORITY_RANK.blocked, 3);
  assert.equal(PRIORITY_RANK.not_responding, 4);
  assert.equal(PRIORITY_RANK.context_high, 5);
  // Medium
  assert.equal(PRIORITY_RANK.done_claimed_verify_missing, 6);
  assert.equal(PRIORITY_RANK.done_needs_closeout, 7);
  assert.equal(PRIORITY_RANK.verify_missing, 8);
  // Low
  assert.equal(PRIORITY_RANK.quiet, 9);
  assert.equal(PRIORITY_RANK.unbound_session, 10);
});

function stubItem(kind, overrides = {}) {
  const t = "2026-05-24T12:00:00.000Z";
  return {
    id: `att_${kind}_${Math.random().toString(36).slice(2, 10)}`,
    kind,
    severity: "medium",
    title: kind,
    detail: kind,
    source: "derived",
    createdAt: t,
    updatedAt: t,
    dedupeKey: computeAttentionDedupeKey({ kind }),
    recommendedActions: [],
    ...overrides,
  };
}

test("compareByPriority orders four stub kinds Critical → Low", () => {
  const items = [
    stubItem("unbound_session", { dedupeKey: "unbound_session|||||z" }),
    stubItem("approval_needed", { dedupeKey: "approval_needed|||||a" }),
    stubItem("blocked", { dedupeKey: "blocked|||||b" }),
    stubItem("verify_missing", { dedupeKey: "verify_missing|||||c" }),
  ];
  const sorted = [...items].sort(compareByPriority);
  assert.deepEqual(
    sorted.map((i) => i.kind),
    ["approval_needed", "blocked", "verify_missing", "unbound_session"],
  );
});

test("compareByPriority tie-breaks by createdAt ASC then dedupeKey ASC", () => {
  const a = stubItem("blocked", {
    createdAt: "2026-05-24T12:00:00.000Z",
    dedupeKey: "blocked|p|t1|||",
  });
  const b = stubItem("blocked", {
    createdAt: "2026-05-24T12:00:01.000Z",
    dedupeKey: "blocked|p|t2|||",
  });
  const c = stubItem("blocked", {
    createdAt: "2026-05-24T12:00:01.000Z",
    dedupeKey: "blocked|p|t3|||",
  });
  const sorted = [c, b, a].sort(compareByPriority);
  assert.deepEqual(
    sorted.map((i) => i.dedupeKey),
    ["blocked|p|t1|||", "blocked|p|t2|||", "blocked|p|t3|||"],
  );
});

// ---------------------------------------------------------------------------
// AttentionProjection
// ---------------------------------------------------------------------------

test("AttentionProjection.apply replaces the active set and indexes by id/dedupeKey/sessionId", () => {
  const p = new AttentionProjection();
  const item = stubItem("blocked", {
    id: "att_one",
    sessionId: "ses_a",
    dedupeKey: "blocked|||||a",
  });
  p.apply([item]);
  assert.equal(p.size(), 1);
  assert.equal(p.getById("att_one"), item);
  assert.equal(p.getByDedupeKey("blocked|||||a"), item);
  assert.deepEqual(p.getBySession("ses_a"), [item]);

  // Replacement drops the old item.
  const next = stubItem("verify_missing", {
    id: "att_two",
    sessionId: "ses_b",
    dedupeKey: "verify_missing|||||b",
  });
  p.apply([next]);
  assert.equal(p.size(), 1);
  assert.equal(p.getById("att_one"), null);
  assert.equal(p.getByDedupeKey("blocked|||||a"), null);
  assert.deepEqual(p.getBySession("ses_a"), []);
  assert.equal(p.getById("att_two"), next);
});

test("AttentionProjection dedupes within a single apply tick", () => {
  const p = new AttentionProjection();
  const a = stubItem("blocked", { id: "att_a", dedupeKey: "blocked|||||a" });
  const b = stubItem("blocked", { id: "att_b", dedupeKey: "blocked|||||a" });
  p.apply([a, b]);
  assert.equal(p.size(), 1);
  assert.equal(p.getById("att_a"), a);
  assert.equal(p.getById("att_b"), null);
});

// ---------------------------------------------------------------------------
// unbound_session — pure rule
// ---------------------------------------------------------------------------

const RULE_CFG = { ...DEFAULT_UNTASKED_SESSIONS_CONFIG };

test("unbound_session rule does not fire before the threshold (4min < 5min default)", () => {
  const session = makeSession();
  const item = unboundSessionRule(session, clockAfterMinutes(4), RULE_CFG, testMakeId);
  assert.equal(item, null);
});

test("unbound_session rule fires at the 5min default threshold with severity 'low'", () => {
  const session = makeSession();
  const item = unboundSessionRule(session, clockAfterMinutes(5), RULE_CFG, testMakeId);
  assert.ok(item, "expected an item at threshold");
  assert.equal(item.kind, "unbound_session");
  assert.equal(item.severity, "low");
  assert.equal(item.sessionId, session.id);
});

test("unbound_session severity escalates to 'medium' at 1h and 'high' at 6h", () => {
  const session = makeSession();
  const at59 = unboundSessionRule(session, clockAfterMinutes(59), RULE_CFG, testMakeId);
  const at60 = unboundSessionRule(session, clockAfterMinutes(60), RULE_CFG, testMakeId);
  const at359 = unboundSessionRule(session, clockAfterMinutes(359), RULE_CFG, testMakeId);
  const at360 = unboundSessionRule(session, clockAfterMinutes(360), RULE_CFG, testMakeId);

  assert.equal(at59.severity, "low");
  assert.equal(at60.severity, "medium");
  assert.equal(at359.severity, "medium");
  assert.equal(at360.severity, "high");
});

test("unbound_session sets autoArchive: true at 72h default threshold (not before)", () => {
  const session = makeSession();
  const before = unboundSessionRule(
    session,
    clockAfterMinutes(72 * 60 - 1),
    RULE_CFG,
    testMakeId,
  );
  const at = unboundSessionRule(
    session,
    clockAfterMinutes(72 * 60),
    RULE_CFG,
    testMakeId,
  );
  assert.notEqual(before, null);
  assert.equal(before.autoArchive, undefined);
  assert.notEqual(at, null);
  assert.equal(at.autoArchive, true);
  // Severity should be high deep in the ladder.
  assert.equal(at.severity, "high");
});

test("unbound_session dedupeKey is deterministic and matches computeAttentionDedupeKey({kind, sessionId})", () => {
  const session = makeSession();
  const item = unboundSessionRule(session, clockAfterMinutes(5), RULE_CFG, testMakeId);
  assert.equal(
    item.dedupeKey,
    computeAttentionDedupeKey({ kind: "unbound_session", sessionId: session.id }),
  );
});

test("unbound_session skips sessions with a taskId set", () => {
  const session = makeSession({ taskId: "t-1" });
  const item = unboundSessionRule(session, clockAfterMinutes(60), RULE_CFG, testMakeId);
  assert.equal(item, null);
});

test("unbound_session skips sessions in archived/done/stopped states", () => {
  for (const status of ["archived", "done", "stopped"]) {
    const session = makeSession({ status });
    const item = unboundSessionRule(session, clockAfterMinutes(60), RULE_CFG, testMakeId);
    assert.equal(item, null, `status='${status}' should skip`);
  }
});

test("unbound_session recommendedActions include acknowledge, snooze, and bind_task", () => {
  const session = makeSession();
  const item = unboundSessionRule(session, clockAfterMinutes(5), RULE_CFG, testMakeId);
  const kinds = item.recommendedActions.map((a) => a.kind);
  assert.ok(kinds.includes("acknowledge"));
  assert.ok(kinds.includes("snooze"));
  assert.ok(kinds.includes("bind_task"));
});

// ---------------------------------------------------------------------------
// AttentionEngine — compute / project / now-injection / config / rules
// ---------------------------------------------------------------------------

test("AttentionEngine.compute accepts an injected now() and projects unbound_session", () => {
  const proj = new AttentionProjection();
  const engine = new AttentionEngine({
    projection: proj,
    now: () => clockAfterMinutes(5),
    makeId: testMakeId,
  });
  const items = engine.compute({ sessions: [makeSession()] });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "unbound_session");
  assert.equal(items[0].severity, "low");
  assert.deepEqual(
    proj.getAll().map((i) => i.dedupeKey),
    items.map((i) => i.dedupeKey),
  );
});

test("AttentionEngine clears the unbound item on the next compute when the session gains a taskId", () => {
  const proj = new AttentionProjection();
  let currentTaskId = undefined;
  const session = makeSession();
  const engine = new AttentionEngine({
    projection: proj,
    now: () => clockAfterMinutes(10),
    makeId: testMakeId,
  });

  // 1. Initially unbound: item present.
  let items = engine.compute({ sessions: [{ ...session, taskId: currentTaskId }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "unbound_session");

  // 2. Operator binds a task; next tick the rule returns null and the
  //    projection drops the item.
  currentTaskId = "t-123";
  items = engine.compute({ sessions: [{ ...session, taskId: currentTaskId }] });
  assert.equal(items.length, 0);
  assert.equal(proj.size(), 0);
});

test("AttentionEngine.compute sorts emitted items by §8A.3 priority", () => {
  // Use a stub rule for `blocked` to verify cross-kind ordering inside
  // compute() itself (not just via the comparator).
  const proj = new AttentionProjection();
  const engine = new AttentionEngine({
    projection: proj,
    now: () => clockAfterMinutes(5),
    makeId: testMakeId,
  });
  engine.registerRule("blocked", ({ now, makeId }) => ({
    id: makeId("att"),
    kind: "blocked",
    severity: "high",
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
  }));
  const items = engine.compute({ sessions: [makeSession()] });
  assert.deepEqual(items.map((i) => i.kind), ["blocked", "unbound_session"]);
});

test("AttentionEngine respects a custom untaskedSessions config", () => {
  const engine = new AttentionEngine({
    config: {
      untaskedSessions: {
        unboundAttentionAfterMinutes: 30,
        unboundAutoArchiveAfterHours: 4,
      },
    },
    now: () => clockAfterMinutes(29),
    makeId: testMakeId,
  });
  // Under the custom 30-min threshold, 29min => no item.
  assert.equal(engine.compute({ sessions: [makeSession()] }).length, 0);
  // At 4h with custom 4h auto-archive, expect autoArchive=true.
  engine.now = () => clockAfterMinutes(4 * 60);
  const items = engine.compute({ sessions: [makeSession()] });
  assert.equal(items.length, 1);
  assert.equal(items[0].autoArchive, true);
});

test("AttentionEngine reserves a rule slot for every canonical kind (sh-4-03 extension point)", () => {
  const engine = new AttentionEngine({ makeId: testMakeId });
  for (const kind of ATTENTION_KINDS) {
    // The slot exists (returns undefined only for kinds NOT in the map).
    assert.notEqual(
      engine.getRule(kind),
      undefined,
      `expected slot for '${kind}'`,
    );
  }
  // Only `unbound_session` ships with a function; the rest are null.
  for (const kind of ATTENTION_KINDS) {
    const fn = engine.getRule(kind);
    if (kind === "unbound_session") assert.equal(typeof fn, "function");
    else assert.equal(fn, null, `kind '${kind}' should be null until sh-4-03`);
  }
});

test("AttentionEngine.registerRule swaps a slot and rejects unknown kinds", () => {
  const engine = new AttentionEngine({ makeId: testMakeId });
  const stubFn = () => null;
  engine.registerRule("blocked", stubFn);
  assert.equal(engine.getRule("blocked"), stubFn);

  // Setting back to null disables the slot but keeps it reserved.
  engine.registerRule("blocked", null);
  assert.equal(engine.getRule("blocked"), null);

  assert.throws(
    () => engine.registerRule("ghost", () => null),
    /not in ATTENTION_KINDS/,
  );
  assert.throws(
    () => engine.registerRule("blocked", "not a fn"),
    /ruleFn must be a function or null/,
  );
});

test("AttentionEngine drops rule output that fails assertValidAttentionItem (defensive)", () => {
  const engine = new AttentionEngine({
    now: () => clockAfterMinutes(5),
    makeId: testMakeId,
    logger: { warn: () => {}, error: () => {} },
  });
  engine.registerRule("blocked", () => ({
    // Missing required fields -> validator throws -> engine drops.
    id: "att_x",
    kind: "blocked",
  }));
  const items = engine.compute({ sessions: [] });
  // No unbound (no sessions), and the malformed `blocked` item was dropped.
  assert.deepEqual(items, []);
});

test("AttentionEngine swallows rule exceptions and continues with other rules", () => {
  const logs = [];
  const engine = new AttentionEngine({
    now: () => clockAfterMinutes(5),
    makeId: testMakeId,
    logger: { warn: () => {}, error: (m) => logs.push(m) },
  });
  engine.registerRule("blocked", () => {
    throw new Error("boom");
  });
  const items = engine.compute({ sessions: [makeSession()] });
  // unbound still emitted; the throwing rule logged but didn't break compute.
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "unbound_session");
  assert.ok(logs.some((m) => /blocked/.test(m)));
});
