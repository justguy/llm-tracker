// ui/attention/__tests__/rollover-actions.test.js -- SH-8-07

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAttentionActions,
  getAttentionActionPlan as getHubAttentionActionPlan,
} from "../../../hub/attention/actions.js";
import {
  decorateAttentionActions,
  getAttentionActionPlan as getUiAttentionActionPlan,
} from "../actions.js";

const BASE_ITEM = Object.freeze({
  id: "att_rollover_1",
  severity: "high",
  title: "Needs rollover",
  detail: "",
  source: "structured",
  createdAt: "2026-05-29T12:00:00.000Z",
  updatedAt: "2026-05-29T12:00:00.000Z",
  dedupeKey: "kind=context_high|sessionId=ses_rollover",
  sessionId: "ses_rollover",
  jobId: "job_rollover",
});

function item(kind, overrides = {}) {
  return { ...BASE_ITEM, kind, ...overrides };
}

test("attention action decoration adds visible rollover for rollover-worthy item kinds", () => {
  for (const kind of ["context_high", "not_responding", "done_claimed_verify_missing"]) {
    const uiActions = decorateAttentionActions([], item(kind));
    const hubActions = normalizeAttentionActions(item(kind), []);

    assert.equal(uiActions.length, 1, kind);
    assert.equal(uiActions[0].kind, "rollover", kind);
    assert.equal(uiActions[0].enabled, false, kind);
    assert.match(uiActions[0].disabledReason, /Rollover action handlers are gated/, kind);
    assert.equal(hubActions.length, 1, kind);
    assert.equal(hubActions[0].kind, "rollover", kind);
  }
});

test("default rollover action is omitted when no job id is available", () => {
  const noJob = item("done_claimed_verify_missing", { jobId: undefined });
  assert.deepEqual(decorateAttentionActions([], noJob), []);
  assert.deepEqual(normalizeAttentionActions(noJob, []), []);
});

test("explicit rollover action is preserved and uses trigger source as request reason", () => {
  const existing = [
    {
      id: "rollover",
      label: "Roll over",
      kind: "rollover",
      enabled: true,
      rolloverTriggerSource: "not_responding",
    },
  ];

  const decorated = decorateAttentionActions(existing, item("not_responding"), {
    features: { rollover: true },
  });
  assert.equal(decorated.length, 1);
  assert.equal(decorated[0].enabled, true);

  const uiPlan = getUiAttentionActionPlan(item("not_responding"), existing[0], {
    features: { rollover: true },
  });
  const hubPlan = getHubAttentionActionPlan(item("not_responding"), existing[0], {
    features: { rollover: true },
  });
  assert.deepEqual(uiPlan.body, { reason: "not_responding" });
  assert.deepEqual(hubPlan.body, { reason: "not_responding" });
});
