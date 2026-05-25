// test/attention-types-new-kinds.test.js — SH-4-11 (addendum §15)
//
// Regression: the new AttentionKind values from addendum §15 are present in
// ATTENTION_KINDS and pass assertValidAttentionItem; existing kinds still pass.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_KINDS,
  assertValidAttentionItem,
} from "../hub/attention/types.js";

const ISO_NOW = "2026-05-24T12:34:56.000Z";

function baseItem(overrides) {
  return {
    id: "att_01h00000000000000000000000",
    kind: "approval_needed",
    severity: "critical",
    title: "x",
    detail: "y",
    source: "structured",
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    dedupeKey: "approval_needed|||||",
    recommendedActions: [],
    ...overrides,
  };
}

test("ATTENTION_KINDS includes 'sandbox_escape_requested'", () => {
  assert.ok(ATTENTION_KINDS.includes("sandbox_escape_requested"));
});

test("ATTENTION_KINDS includes 'provider_error'", () => {
  assert.ok(ATTENTION_KINDS.includes("provider_error"));
});

test("ATTENTION_KINDS remains frozen after §15 additions", () => {
  assert.ok(Object.isFrozen(ATTENTION_KINDS));
});

test("assertValidAttentionItem accepts a 'sandbox_escape_requested' item", () => {
  assert.doesNotThrow(() =>
    assertValidAttentionItem(
      baseItem({
        kind: "sandbox_escape_requested",
        severity: "critical",
        dedupeKey: "sandbox_escape_requested|||||",
      }),
    ),
  );
});

test("assertValidAttentionItem accepts a 'provider_error' item (medium)", () => {
  assert.doesNotThrow(() =>
    assertValidAttentionItem(
      baseItem({
        kind: "provider_error",
        severity: "medium",
        dedupeKey: "provider_error|||||",
      }),
    ),
  );
});

test("assertValidAttentionItem accepts a 'provider_error' item (low retryable)", () => {
  assert.doesNotThrow(() =>
    assertValidAttentionItem(
      baseItem({
        kind: "provider_error",
        severity: "low",
        dedupeKey: "provider_error|||||",
      }),
    ),
  );
});

test("regression: existing kind 'unbound_session' still passes assertValidAttentionItem", () => {
  assert.doesNotThrow(() =>
    assertValidAttentionItem(
      baseItem({
        kind: "unbound_session",
        severity: "low",
        dedupeKey: "unbound_session|||||",
      }),
    ),
  );
});
