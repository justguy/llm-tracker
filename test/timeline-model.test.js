// test/timeline-model.test.js — SH-4A-01 (EXECUTOR_ADDENDUM §11, TDD v0.5 §23.2 #23)
//
// Acceptance suite for the TimelineItem model. Pure shape tests; no runtime
// store wiring needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TIMELINE_KINDS,
  TIMELINE_SOURCES,
  TIMELINE_CONFIDENCES,
  assertValidTimelineItem,
  assertValidTimelineAction,
} from "../hub/timeline/timeline-model.js";

// --- enum sets: literal-array regressions ----------------------------------

test("TIMELINE_KINDS matches addendum §11 exactly (12 values)", () => {
  assert.ok(Object.isFrozen(TIMELINE_KINDS));
  assert.equal(TIMELINE_KINDS.length, 12);
  assert.deepEqual([...TIMELINE_KINDS], [
    "message",
    "reasoning",
    "command",
    "file_change",
    "approval",
    "checkpoint",
    "skill",
    "verify",
    "repo_change",
    "warning",
    "handoff",
    "status",
  ]);
});

test("TIMELINE_SOURCES matches addendum §11 exactly (8 values)", () => {
  assert.ok(Object.isFrozen(TIMELINE_SOURCES));
  assert.equal(TIMELINE_SOURCES.length, 8);
  assert.deepEqual([...TIMELINE_SOURCES], [
    "provider",
    "mcp",
    "http",
    "watcher_git",
    "derived",
    "human",
    "raw_stdio",
    "system",
  ]);
});

test("TIMELINE_CONFIDENCES matches addendum §11 exactly (5 values)", () => {
  assert.ok(Object.isFrozen(TIMELINE_CONFIDENCES));
  assert.equal(TIMELINE_CONFIDENCES.length, 5);
  assert.deepEqual([...TIMELINE_CONFIDENCES], [
    "structured",
    "reported",
    "derived",
    "manual",
    "unknown",
  ]);
});

// --- minimal happy-path item -----------------------------------------------

function minimalItem(overrides) {
  return {
    id: "tl_01h00000000000000000000000",
    sessionId: "ses_01h00000000000000000000000",
    kind: "message",
    title: "user: hello",
    ts: "2026-05-24T12:34:56.000Z",
    source: "provider",
    confidence: "structured",
    evidenceRef: "evt_01h00000000000000000000000",
    ...overrides,
  };
}

test("assertValidTimelineItem accepts a minimal well-formed item (required-only)", () => {
  assert.doesNotThrow(() => assertValidTimelineItem(minimalItem()));
});

test("assertValidTimelineItem accepts a fully-populated item with one action", () => {
  assert.doesNotThrow(() =>
    assertValidTimelineItem(
      minimalItem({
        jobId: "job_01h00000000000000000000000",
        taskId: "t-1",
        projectSlug: "demo",
        detail: "raw text body",
        actions: [
          {
            id: "act_1",
            label: "Approve",
            kind: "approve",
            enabled: true,
          },
        ],
      }),
    ),
  );
});

// --- assertValidTimelineItem rejections ------------------------------------

test("assertValidTimelineItem rejects unknown kind", () => {
  assert.throws(
    () => assertValidTimelineItem(minimalItem({ kind: "ghost" })),
    /kind 'ghost' not in TIMELINE_KINDS/,
  );
});

test("assertValidTimelineItem rejects unknown source", () => {
  assert.throws(
    () => assertValidTimelineItem(minimalItem({ source: "rumor" })),
    /source 'rumor' not in TIMELINE_SOURCES/,
  );
});

test("assertValidTimelineItem rejects unknown confidence", () => {
  assert.throws(
    () => assertValidTimelineItem(minimalItem({ confidence: "vibes" })),
    /confidence 'vibes' not in TIMELINE_CONFIDENCES/,
  );
});

test("assertValidTimelineItem rejects missing evidenceRef (every item links to evidence)", () => {
  const item = minimalItem();
  delete item.evidenceRef;
  assert.throws(
    () => assertValidTimelineItem(item),
    /evidenceRef required.*every timeline item must link to its evidence source/,
  );
});

test("assertValidTimelineItem rejects empty-string evidenceRef", () => {
  assert.throws(
    () => assertValidTimelineItem(minimalItem({ evidenceRef: "" })),
    /evidenceRef required/,
  );
});

test("assertValidTimelineItem rejects malformed ts", () => {
  assert.throws(
    () => assertValidTimelineItem(minimalItem({ ts: "yesterday" })),
    /ts must be an ISO-8601 timestamp/,
  );
});

test("assertValidTimelineItem rejects actions: 'not-an-array'", () => {
  assert.throws(
    () => assertValidTimelineItem(minimalItem({ actions: "not-an-array" })),
    /actions must be an array when present/,
  );
});

// --- assertValidTimelineAction rejections ----------------------------------

test("assertValidTimelineAction rejects missing enabled", () => {
  assert.throws(
    () =>
      assertValidTimelineAction({
        id: "act_1",
        label: "Approve",
        kind: "approve",
      }),
    /enabled must be a boolean/,
  );
});

test("assertValidTimelineAction rejects disabledReason when enabled: true", () => {
  assert.throws(
    () =>
      assertValidTimelineAction({
        id: "act_1",
        label: "Approve",
        kind: "approve",
        enabled: true,
        disabledReason: "shouldn't be here",
      }),
    /disabledReason only allowed when enabled === false/,
  );
});
