// test/attention-rules-provider_error.test.js — SH-4-11 (addendum §15)

import { test } from "node:test";
import assert from "node:assert/strict";

import { providerErrorRule } from "../hub/attention/rules/provider_error.js";
import { assertValidAttentionItem } from "../hub/attention/types.js";
import { computeAttentionDedupeKey } from "../hub/attention/dedupe.js";

let _n = 0;
function makeId(prefix) {
  _n += 1;
  return `${prefix}_t${_n.toString().padStart(26, "0")}`;
}

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

test("provider_error: empty input returns []", () => {
  assert.deepEqual(providerErrorRule(baseInput()), []);
});

test("provider_error: missing/non-object input returns []", () => {
  assert.deepEqual(providerErrorRule(undefined), []);
  assert.deepEqual(providerErrorRule(null), []);
});

test("provider_error: retryable=false → severity 'medium' (§15)", () => {
  const session = {
    id: "ses_pe_1",
    projectSlug: "proj",
    warnings: [
      {
        kind: "provider_error",
        retryable: false,
        message: "rate-limited",
        errorId: "err_1",
      },
    ],
  };
  const items = providerErrorRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  const item = items[0];
  assertValidAttentionItem(item);
  assert.equal(item.kind, "provider_error");
  assert.equal(item.severity, "medium");
  assert.equal(item.source, "structured");
  assert.equal(item.sessionId, "ses_pe_1");
  assert.equal(item.evidenceRef, "err_1");
  assert.equal(
    item.dedupeKey,
    computeAttentionDedupeKey({
      kind: "provider_error",
      sessionId: "ses_pe_1",
      evidenceRef: "err_1",
    }),
  );
  assert.ok(item.recommendedActions.some((a) => a.kind === "restart_with_new_model"));
});

test("provider_error: retryable=true → severity 'low' (§15 does not list above)", () => {
  const session = {
    id: "ses_pe_2",
    warnings: [
      { kind: "provider_error", retryable: true, message: "transient", errorId: "err_2" },
    ],
  };
  const items = providerErrorRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].severity, "low");
});

test("provider_error: retryable absent → severity 'medium' (visible default)", () => {
  const session = {
    id: "ses_pe_3",
    warnings: [{ kind: "provider_error", errorId: "err_3" }],
  };
  const items = providerErrorRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].severity, "medium");
});

test("provider_error: top-level warning produces structured item", () => {
  const items = providerErrorRule(
    baseInput({
      warnings: [
        {
          kind: "provider_error",
          retryable: false,
          sessionId: "ses_top",
          errorId: "err_top",
          message: "boom",
        },
      ],
    }),
  );
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].severity, "medium");
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].sessionId, "ses_top");
  assert.equal(items[0].evidenceRef, "err_top");
});

test("provider_error: dedupes by sessionId+evidenceRef across session + top-level", () => {
  const session = {
    id: "ses_dedupe",
    warnings: [{ kind: "provider_error", retryable: false, errorId: "err_same" }],
  };
  const items = providerErrorRule(
    baseInput({
      sessions: [session],
      warnings: [
        {
          kind: "provider_error",
          retryable: false,
          sessionId: "ses_dedupe",
          errorId: "err_same",
        },
      ],
    }),
  );
  assert.equal(items.length, 1);
});

test("provider_error: non-matching warning kinds ignored", () => {
  const session = {
    id: "ses_x",
    warnings: [{ kind: "approval_needed", source: "app_server" }],
  };
  assert.deepEqual(providerErrorRule(baseInput({ sessions: [session] })), []);
});

test("provider_error: trigger gone returns []", () => {
  assert.deepEqual(providerErrorRule(baseInput({ sessions: [], warnings: [] })), []);
});
