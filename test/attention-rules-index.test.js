// test/attention-rules-index.test.js — SH-4-03
//
// Barrel + registerAllRules wiring test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AttentionEngine } from "../hub/attention/engine.js";
import { registerAllRules } from "../hub/attention/rules/index.js";
import { ATTENTION_KINDS } from "../hub/attention/types.js";

test("registerAllRules: installs a function for every kind except unbound_session (which engine already ships)", () => {
  const engine = new AttentionEngine();
  // Pre-state: unbound_session is already a function on a fresh engine.
  assert.equal(typeof engine.getRule("unbound_session"), "function");

  registerAllRules(engine);

  for (const kind of ATTENTION_KINDS) {
    const rule = engine.getRule(kind);
    assert.equal(
      typeof rule,
      "function",
      `kind '${kind}' should have a function registered after registerAllRules`,
    );
  }
});

test("registerAllRules: compute() on empty input does not throw", () => {
  const engine = new AttentionEngine();
  registerAllRules(engine);
  const items = engine.compute({
    sessions: [],
    jobs: [],
    warnings: [],
    conflicts: [],
    trackerSnapshot: {},
  });
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
});

test("registerAllRules: throws TypeError when engine is missing registerRule", () => {
  assert.throws(() => registerAllRules(null), TypeError);
  assert.throws(() => registerAllRules({}), TypeError);
});
