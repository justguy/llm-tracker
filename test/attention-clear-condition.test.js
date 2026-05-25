// test/attention-clear-condition.test.js — SH-4-12 (addendum §15)
//
// Verifies that:
//   1. CLEAR_CONDITIONS_BY_KIND covers every AttentionKind with a non-empty
//      string default (addendum §15: every item to have one).
//   2. defaultClearConditionForKind returns the right string for known kinds
//      and `undefined` for unknowns.
//   3. assertValidAttentionItem default-fills clearCondition from the map
//      when the caller omitted it.
//   4. assertValidAttentionItem rejects items whose kind has no default and
//      whose clearCondition is missing or empty.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_KINDS,
  CLEAR_CONDITIONS_BY_KIND,
  assertValidAttentionItem,
  defaultClearConditionForKind,
} from "../hub/attention/types.js";

const ISO_NOW = "2026-05-24T12:34:56.000Z";

function baseItem(overrides = {}) {
  return {
    id: "att_01h00000000000000000000000",
    kind: "approval_needed",
    severity: "high",
    title: "T",
    detail: "D",
    source: "structured",
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    dedupeKey: "approval_needed|||||",
    recommendedActions: [],
    ...overrides,
  };
}

test("CLEAR_CONDITIONS_BY_KIND is frozen and covers every AttentionKind", () => {
  assert.ok(Object.isFrozen(CLEAR_CONDITIONS_BY_KIND));
  for (const kind of ATTENTION_KINDS) {
    const v = CLEAR_CONDITIONS_BY_KIND[kind];
    assert.equal(typeof v, "string", `kind ${kind} missing default`);
    assert.ok(v.length > 0, `kind ${kind} has empty default`);
  }
});

test("defaultClearConditionForKind returns the §15 default for each kind", () => {
  for (const kind of ATTENTION_KINDS) {
    assert.equal(defaultClearConditionForKind(kind), CLEAR_CONDITIONS_BY_KIND[kind]);
  }
});

test("defaultClearConditionForKind returns undefined for unknown / non-string", () => {
  assert.equal(defaultClearConditionForKind("ghost"), undefined);
  assert.equal(defaultClearConditionForKind(undefined), undefined);
  assert.equal(defaultClearConditionForKind(null), undefined);
  assert.equal(defaultClearConditionForKind(42), undefined);
});

test("assertValidAttentionItem default-fills clearCondition from the kind map when omitted", () => {
  const item = baseItem();
  assert.equal(item.clearCondition, undefined);
  assertValidAttentionItem(item);
  assert.equal(item.clearCondition, CLEAR_CONDITIONS_BY_KIND.approval_needed);
});

test("assertValidAttentionItem keeps an explicit clearCondition rather than overwriting", () => {
  const item = baseItem({ clearCondition: "custom rule explained inline" });
  assertValidAttentionItem(item);
  assert.equal(item.clearCondition, "custom rule explained inline");
});

test("assertValidAttentionItem rejects empty-string clearCondition", () => {
  assert.throws(
    () => assertValidAttentionItem(baseItem({ clearCondition: "" })),
    /clearCondition required/,
  );
});

test("assertValidAttentionItem rejects non-string clearCondition", () => {
  assert.throws(
    () => assertValidAttentionItem(baseItem({ clearCondition: 5 })),
    /clearCondition required/,
  );
});

test("every kind validates with default-filled clearCondition", () => {
  for (const kind of ATTENTION_KINDS) {
    const dedupeKey = `${kind}|||||`;
    const item = baseItem({ kind, dedupeKey });
    delete item.clearCondition;
    assert.doesNotThrow(
      () => assertValidAttentionItem(item),
      `kind ${kind} should default-fill`,
    );
    assert.equal(item.clearCondition, CLEAR_CONDITIONS_BY_KIND[kind]);
  }
});
