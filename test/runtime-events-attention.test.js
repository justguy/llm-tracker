// test/runtime-events-attention.test.js — SH-4-05 (TDD v0.5 §6.6, §8A.3)
//
// Unit tests for the three SH-4-05 runtime event factories:
//   - createAttentionAckEvent
//   - createAttentionSnoozedEvent
//   - createAttentionClearedEvent
//
// Schema admissibility: §6.6 declares `AttentionAckEvent`, `AttentionSnoozedEvent`,
// `AttentionClearedEvent` as variants but does not (yet) provide tight per-variant
// JSON Schemas. The three `attention.*` types are listed in the
// `GenericRuntimeEvent` enum in schema/runtime-events.schema.json with
// `additionalProperties: true`, so the base RuntimeEvent shape is validated
// and the attention-specific payload rides as extra properties. The
// "documents §6.6 enum gap" test below records that admissibility status
// explicitly so a future strict-variant schema lands cleanly (the test will
// remain green; it only asserts the base shape, which the strict variant
// will still enforce).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAttentionAckEvent,
  createAttentionSnoozedEvent,
  createAttentionClearedEvent,
  validateRuntimeEvent,
  RUNTIME_EVENT_TYPES,
} from "../hub/runtime/events.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const WORKSPACE = "/tmp/lt-attention-events-test";

function freshAttId() {
  return makeRuntimeId("att");
}

function freshEventId() {
  return makeRuntimeId("evt");
}

// --- enum coverage ---------------------------------------------------------

test("RUNTIME_EVENT_TYPES includes attention.ack, attention.snoozed, attention.cleared", () => {
  assert.ok(RUNTIME_EVENT_TYPES.includes("attention.ack"));
  assert.ok(RUNTIME_EVENT_TYPES.includes("attention.snoozed"));
  assert.ok(RUNTIME_EVENT_TYPES.includes("attention.cleared"));
});

test("documents §6.6 enum gap for attention.* shape (admissible via GenericRuntimeEvent)", () => {
  // The three attention.* types are admitted by the GenericRuntimeEvent
  // variant (additionalProperties: true). A strict per-variant schema is
  // expected in a later TDD revision; until then, the base RuntimeEvent
  // shape is the contract. Round-trip a representative event of each type
  // through validateRuntimeEvent to confirm admissibility.
  for (const type of ["attention.ack", "attention.snoozed", "attention.cleared"]) {
    const evt = {
      schemaVersion: 1,
      id: freshEventId(),
      ts: new Date().toISOString(),
      type,
      source: "http",
      workspace: WORKSPACE,
      attentionItemId: freshAttId(),
      dedupeKey: "kind=quiet|sessionId=ses_x",
    };
    assert.equal(validateRuntimeEvent(evt), true, `${type} must round-trip via GenericRuntimeEvent`);
  }
});

// --- createAttentionAckEvent ----------------------------------------------

test("createAttentionAckEvent: builds a schema-valid event with default acknowledgedAt", () => {
  const evt = createAttentionAckEvent({
    attentionItemId: freshAttId(),
    dedupeKey: "kind=quiet|sessionId=ses_x",
    workspace: WORKSPACE,
  });
  assert.equal(evt.type, "attention.ack");
  assert.equal(evt.source, "http");
  assert.equal(evt.schemaVersion, 1);
  assert.equal(evt.id, undefined, "id is left for RuntimeStore to stamp");
  assert.equal(typeof evt.acknowledgedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(evt.acknowledgedAt)));
  // Defence-in-depth: re-run validation with a stamped id.
  assert.equal(validateRuntimeEvent({ ...evt, id: freshEventId() }), true);
});

test("createAttentionAckEvent: accepts actor + custom acknowledgedAt", () => {
  const acknowledgedAt = "2026-05-24T10:00:00Z";
  const evt = createAttentionAckEvent({
    attentionItemId: freshAttId(),
    dedupeKey: "k",
    workspace: WORKSPACE,
    acknowledgedAt,
    actor: "adi@example.com",
  });
  assert.equal(evt.acknowledgedAt, acknowledgedAt);
  assert.equal(evt.actor, "adi@example.com");
});

test("createAttentionAckEvent: rejects invalid attentionItemId", () => {
  assert.throws(
    () => createAttentionAckEvent({
      attentionItemId: "not-an-att-id",
      dedupeKey: "k",
      workspace: WORKSPACE,
    }),
    /attentionItemId required/,
  );
});

test("createAttentionAckEvent: rejects missing dedupeKey", () => {
  assert.throws(
    () => createAttentionAckEvent({
      attentionItemId: freshAttId(),
      workspace: WORKSPACE,
    }),
    /dedupeKey required/,
  );
});

test("createAttentionAckEvent: rejects missing workspace", () => {
  assert.throws(
    () => createAttentionAckEvent({
      attentionItemId: freshAttId(),
      dedupeKey: "k",
    }),
    /workspace required/,
  );
});

// --- createAttentionSnoozedEvent ------------------------------------------

test("createAttentionSnoozedEvent: builds a schema-valid event", () => {
  const evt = createAttentionSnoozedEvent({
    attentionItemId: freshAttId(),
    dedupeKey: "k",
    snoozedUntil: "2099-01-01T00:00:00Z",
    reason: "out for the night",
    workspace: WORKSPACE,
  });
  assert.equal(evt.type, "attention.snoozed");
  assert.equal(evt.snoozedUntil, "2099-01-01T00:00:00Z");
  assert.equal(evt.reason, "out for the night");
  assert.equal(validateRuntimeEvent({ ...evt, id: freshEventId() }), true);
});

test("createAttentionSnoozedEvent: rejects missing snoozedUntil", () => {
  assert.throws(
    () => createAttentionSnoozedEvent({
      attentionItemId: freshAttId(),
      dedupeKey: "k",
      reason: "r",
      workspace: WORKSPACE,
    }),
    /snoozedUntil required/,
  );
});

test("createAttentionSnoozedEvent: rejects unparseable snoozedUntil", () => {
  assert.throws(
    () => createAttentionSnoozedEvent({
      attentionItemId: freshAttId(),
      dedupeKey: "k",
      snoozedUntil: "not-a-date",
      reason: "r",
      workspace: WORKSPACE,
    }),
    /parseable ISO-8601/,
  );
});

test("createAttentionSnoozedEvent: rejects empty reason", () => {
  assert.throws(
    () => createAttentionSnoozedEvent({
      attentionItemId: freshAttId(),
      dedupeKey: "k",
      snoozedUntil: "2099-01-01T00:00:00Z",
      reason: "",
      workspace: WORKSPACE,
    }),
    /reason required/,
  );
});

// --- createAttentionClearedEvent ------------------------------------------

test("createAttentionClearedEvent: builds a schema-valid event with default clearedAt", () => {
  const evt = createAttentionClearedEvent({
    attentionItemId: freshAttId(),
    dedupeKey: "k",
    reason: "underlying conflict resolved",
    workspace: WORKSPACE,
  });
  assert.equal(evt.type, "attention.cleared");
  assert.equal(evt.reason, "underlying conflict resolved");
  assert.equal(typeof evt.clearedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(evt.clearedAt)));
  assert.equal(validateRuntimeEvent({ ...evt, id: freshEventId() }), true);
});

test("createAttentionClearedEvent: rejects missing reason", () => {
  assert.throws(
    () => createAttentionClearedEvent({
      attentionItemId: freshAttId(),
      dedupeKey: "k",
      workspace: WORKSPACE,
    }),
    /reason required/,
  );
});

test("createAttentionClearedEvent: rejects invalid actor type", () => {
  assert.throws(
    () => createAttentionClearedEvent({
      attentionItemId: freshAttId(),
      dedupeKey: "k",
      reason: "r",
      workspace: WORKSPACE,
      actor: "",
    }),
    /actor must be a non-empty string/,
  );
});
