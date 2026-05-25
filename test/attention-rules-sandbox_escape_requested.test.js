// test/attention-rules-sandbox_escape_requested.test.js — SH-4-11 (addendum §15)

import { test } from "node:test";
import assert from "node:assert/strict";

import { sandboxEscapeRequestedRule } from "../hub/attention/rules/sandbox_escape_requested.js";
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

test("sandbox_escape_requested: empty input returns []", () => {
  assert.deepEqual(sandboxEscapeRequestedRule(baseInput()), []);
});

test("sandbox_escape_requested: missing/non-object input returns []", () => {
  assert.deepEqual(sandboxEscapeRequestedRule(undefined), []);
  assert.deepEqual(sandboxEscapeRequestedRule(null), []);
});

test("sandbox_escape_requested: session warning produces critical structured item", () => {
  const session = {
    id: "ses_01h00000000000000000000001",
    projectSlug: "proj",
    taskId: "T-1",
    activeJobId: "job_1",
    warnings: [
      { kind: "sandbox_escape_requested", source: "app_server", actionId: "esc_42" },
    ],
  };
  const items = sandboxEscapeRequestedRule(baseInput({ sessions: [session] }));
  assert.equal(items.length, 1);
  const item = items[0];
  assertValidAttentionItem(item);
  assert.equal(item.kind, "sandbox_escape_requested");
  assert.equal(item.severity, "critical");
  assert.equal(item.source, "structured");
  assert.equal(item.sessionId, "ses_01h00000000000000000000001");
  assert.equal(item.projectSlug, "proj");
  assert.equal(item.taskId, "T-1");
  assert.equal(item.jobId, "job_1");
  assert.equal(item.evidenceRef, "esc_42");
  assert.equal(
    item.dedupeKey,
    computeAttentionDedupeKey({
      kind: "sandbox_escape_requested",
      projectSlug: "proj",
      taskId: "T-1",
      sessionId: "ses_01h00000000000000000000001",
      evidenceRef: "esc_42",
    }),
  );
  assert.ok(item.recommendedActions.length > 0, "recommendedActions non-empty");
  assert.ok(
    item.recommendedActions.some((a) => a.kind === "escalate_sandbox"),
    "expected escalate_sandbox action",
  );
  assert.ok(
    item.recommendedActions.some((a) => a.kind === "deny"),
    "expected deny action",
  );
});

test("sandbox_escape_requested: top-level warning produces critical structured item", () => {
  const items = sandboxEscapeRequestedRule(
    baseInput({
      warnings: [
        {
          kind: "sandbox_escape_requested",
          sessionId: "ses_top",
          source: "mcp",
          eventId: "evt_x",
        },
      ],
    }),
  );
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].severity, "critical");
  assert.equal(items[0].source, "structured");
  assert.equal(items[0].sessionId, "ses_top");
  assert.equal(items[0].evidenceRef, "evt_x");
});

test("sandbox_escape_requested: dedupes session + top-level warning by sessionId+evidenceRef", () => {
  const session = {
    id: "ses_dedupe",
    warnings: [{ kind: "sandbox_escape_requested", actionId: "esc_same" }],
  };
  const items = sandboxEscapeRequestedRule(
    baseInput({
      sessions: [session],
      warnings: [
        {
          kind: "sandbox_escape_requested",
          sessionId: "ses_dedupe",
          eventId: "esc_same",
        },
      ],
    }),
  );
  assert.equal(items.length, 1, "expected dedupe to collapse identical signals");
});

test("sandbox_escape_requested: non-matching warning kinds ignored", () => {
  const session = {
    id: "ses_z",
    warnings: [{ kind: "approval_needed", source: "app_server" }],
  };
  assert.deepEqual(
    sandboxEscapeRequestedRule(baseInput({ sessions: [session] })),
    [],
  );
});

test("sandbox_escape_requested: trigger gone returns []", () => {
  assert.deepEqual(
    sandboxEscapeRequestedRule(baseInput({ sessions: [], warnings: [] })),
    [],
  );
});
