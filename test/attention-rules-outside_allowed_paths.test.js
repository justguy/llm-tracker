// test/attention-rules-outside_allowed_paths.test.js — SH-4-03

import { test } from "node:test";
import assert from "node:assert/strict";

import { outsideAllowedPathsRule } from "../hub/attention/rules/outside_allowed_paths.js";
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

test("outside_allowed_paths: empty input returns []", () => {
  assert.deepEqual(outsideAllowedPathsRule(baseInput()), []);
});

test("outside_allowed_paths: watcher conflict produces watcher_git-sourced item", () => {
  const c = {
    id: "cf_oap_1",
    kind: "outside_allowed_paths",
    projectSlug: "p",
    sessionId: "ses_1",
    paths: ["docs/x.md"],
  };
  const items = outsideAllowedPathsRule(baseInput({ conflicts: [c] }));
  assert.equal(items.length, 1);
  assertValidAttentionItem(items[0]);
  assert.equal(items[0].source, "watcher_git");
  assert.equal(items[0].severity, "critical");
  assert.equal(items[0].evidenceRef, "cf_oap_1");
  assert.match(items[0].detail, /docs\/x\.md/);
  assert.ok(items[0].recommendedActions.some((a) => a.kind === "view_conflict"));
});

test("outside_allowed_paths: non-OAP kinds are ignored", () => {
  const c = { id: "cf_other", kind: "file_conflict" };
  assert.deepEqual(outsideAllowedPathsRule(baseInput({ conflicts: [c] })), []);
});

test("outside_allowed_paths: trigger gone returns []", () => {
  assert.deepEqual(outsideAllowedPathsRule(baseInput({ conflicts: [] })), []);
});
