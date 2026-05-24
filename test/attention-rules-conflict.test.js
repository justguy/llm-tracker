// test/attention-rules-conflict.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { conflictRule } from "../hub/attention/rules/conflict.js";
import { assertValidAttentionItem } from "../hub/attention/types.js";

let _n = 0;
const makeId = (p) => `${p}_t${(++_n).toString().padStart(26, "0")}`;

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

test("conflict: empty input returns []", () => {
  assert.deepEqual(conflictRule(baseInput()), []);
});

test("conflict: file_conflict produces one watcher_git-sourced item", () => {
  const c = {
    id: "cf_1",
    kind: "file_conflict",
    projectSlug: "p",
    sessionId: "ses_1",
    message: "hub/foo.js diverged",
  };
  const items = conflictRule(baseInput({ conflicts: [c] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "watcher_git");
  assert.equal(items[0].severity, "critical");
  assert.equal(items[0].evidenceRef, "cf_1");
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "view_conflict"));
});

test("conflict: outside_allowed_paths is excluded (separate rule)", () => {
  const c = { id: "cf_oap", kind: "outside_allowed_paths" };
  assert.deepEqual(conflictRule(baseInput({ conflicts: [c] })), []);
});

test("conflict: missing id/conflictId is skipped", () => {
  const c = { kind: "file_conflict" };
  assert.deepEqual(conflictRule(baseInput({ conflicts: [c] })), []);
});

test("conflict: trigger gone returns []", () => {
  assert.deepEqual(conflictRule(baseInput({ conflicts: [] })), []);
});
