// test/attention-actions.test.js — SH-4-08
//
// Contract tests for AttentionAction dispatch planning. The hub policy is the
// canonical table; the browser dispatcher mirrors it so action chips can be
// made live without waiting for the full app shell to wire every surface.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_ACTION_KINDS,
} from "../hub/attention/types.js";
import {
  ATTENTION_ACTION_SPECS,
  getAttentionActionPlan as getHubPlan,
  normalizeAttentionActions,
} from "../hub/attention/actions.js";
import {
  UI_ATTENTION_ACTION_KINDS,
  UI_ATTENTION_ACTION_SPECS,
  decorateAttentionActions,
  dispatchAttentionAction,
  getAttentionActionPlan as getUiPlan,
} from "../ui/attention/actions.js";

const ITEM = Object.freeze({
  id: "att_01h00000000000000000000000",
  kind: "blocked",
  severity: "high",
  title: "Blocked",
  detail: "",
  source: "structured",
  createdAt: "2026-05-24T12:00:00.000Z",
  updatedAt: "2026-05-24T12:00:00.000Z",
  dedupeKey: "kind=blocked|jobId=job_01h00000000000000000000000",
  projectSlug: "demo",
  taskId: "t-1",
  sessionId: "ses_01h00000000000000000000000",
  jobId: "job_01h00000000000000000000000",
});

function action(kind) {
  return { id: `act_${kind}`, label: kind, kind, enabled: true };
}

test("hub and UI dispatch tables cover every AttentionAction.kind exactly", () => {
  assert.deepEqual(Object.keys(ATTENTION_ACTION_SPECS).sort(), [...ATTENTION_ACTION_KINDS].sort());
  assert.deepEqual(UI_ATTENTION_ACTION_KINDS, ATTENTION_ACTION_KINDS);
  assert.deepEqual(Object.keys(UI_ATTENTION_ACTION_SPECS).sort(), [...ATTENTION_ACTION_KINDS].sort());
});

test("every AttentionAction.kind produces a concrete hub dispatch plan or gated disabled reason", () => {
  for (const kind of ATTENTION_ACTION_KINDS) {
    const plan = getHubPlan(ITEM, action(kind), { now: new Date("2026-05-24T12:00:00.000Z") });
    assert.equal(plan.kind, kind);
    assert.ok(["http", "event", "copy", "none"].includes(plan.dispatch));
    if (!plan.enabled) assert.match(plan.disabledReason, /\S/);
  }
});

test("later-phase AttentionActions are disabled by default with disabledReason", () => {
  const gatedKinds = [
    "rollover",
    "spawn_reviewer",
    "escalate_sandbox",
    "interrupt",
    "complete_override",
    "attach_task",
    "add_task_then_run",
    "swap_model_live",
    "restart_with_new_model",
    "restart_stricter_sandbox",
    "restart_all_quiet",
  ];
  const normalized = normalizeAttentionActions(ITEM, gatedKinds.map(action));
  for (const normalizedAction of normalized) {
    assert.equal(normalizedAction.enabled, false, normalizedAction.kind);
    assert.match(normalizedAction.disabledReason, /\S/, normalizedAction.kind);
  }
});

test("implemented HTTP actions plan exact runtime endpoints and bodies", () => {
  assert.deepEqual(
    getHubPlan(ITEM, action("acknowledge")),
    {
      ok: true,
      enabled: true,
      kind: "acknowledge",
      dispatch: "http",
      itemId: ITEM.id,
      actionId: "act_acknowledge",
      method: "POST",
      url: `/api/attention/${ITEM.id}/ack`,
      body: { dedupeKey: ITEM.dedupeKey },
    },
  );

  const snooze = getHubPlan(ITEM, action("snooze"), {
    now: new Date("2026-05-24T12:00:00.000Z"),
    snoozeReason: "later",
  });
  assert.equal(snooze.url, `/api/attention/${ITEM.id}/snooze`);
  assert.deepEqual(snooze.body, {
    dedupeKey: ITEM.dedupeKey,
    until: "2026-05-24T13:00:00.000Z",
    reason: "later",
  });

  const checkpoint = getHubPlan(ITEM, action("request_checkpoint"), {
    checkpointSummary: "snapshot please",
  });
  assert.equal(checkpoint.url, `/api/jobs/${ITEM.jobId}/checkpoint`);
  assert.deepEqual(checkpoint.body, { summary: "snapshot please" });

  const unblock = getHubPlan(ITEM, action("unblock"), { unblockReason: "resolved" });
  assert.equal(unblock.url, `/api/jobs/${ITEM.jobId}/unblock`);
  assert.deepEqual(unblock.body, { reason: "resolved" });

  const ask = getHubPlan(ITEM, action("ask"), {
    senderSessionId: "ses_sender0000000000000000000",
    sessionToken: "lt_session_token",
    askPrompt: "Need a status check",
  });
  assert.equal(ask.url, "/api/sessions/ses_sender0000000000000000000/ask");
  assert.deepEqual(ask.body, {
    targetSessionId: ITEM.sessionId,
    prompt: "Need a status check",
  });
});

test("actions requiring runtime ids become disabled when fields are absent", () => {
  const noJob = { ...ITEM };
  delete noJob.jobId;
  const decorated = decorateAttentionActions([action("unblock"), action("request_checkpoint")], noJob);
  assert.equal(decorated[0].enabled, false);
  assert.match(decorated[0].disabledReason, /item\.jobId/);
  assert.equal(decorated[1].enabled, false);
  assert.match(decorated[1].disabledReason, /item\.jobId/);
});

test("ask action requires sender session and token options before planning HTTP call", () => {
  const plan = getHubPlan(ITEM, action("ask"));
  assert.equal(plan.enabled, false);
  assert.match(plan.disabledReason, /options\.senderSessionId/);
  assert.match(plan.disabledReason, /options\.sessionToken/);

  const missingToken = getHubPlan(ITEM, action("ask"), {
    senderSessionId: "ses_sender0000000000000000000",
  });
  assert.equal(missingToken.enabled, false);
  assert.match(missingToken.disabledReason, /options\.sessionToken/);
});

test("UI dispatcher POSTs acknowledge and returns parsed response", async () => {
  const calls = [];
  const result = await dispatchAttentionAction(ITEM, action("acknowledge"), {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        json: async () => ({ ok: true, eventId: "evt_1" }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/attention/${ITEM.id}/ack`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { dedupeKey: ITEM.dedupeKey });
});

test("UI dispatcher POSTs ask action to session ask endpoint", async () => {
  const calls = [];
  const result = await dispatchAttentionAction(ITEM, action("ask"), {
    senderSessionId: "ses_sender0000000000000000000",
    sessionToken: "lt_session_token",
    askPrompt: "Status?",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, eventId: "evt_1" }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/sessions/ses_sender0000000000000000000/ask");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-LT-Session-Token"], "lt_session_token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    targetSessionId: ITEM.sessionId,
    prompt: "Status?",
  });
});

test("UI dispatcher emits browser events for client-owned actions", async () => {
  const emitted = [];
  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const result = await dispatchAttentionAction(ITEM, action("open_session"), {
    window: {
      CustomEvent: FakeCustomEvent,
      dispatchEvent: (evt) => emitted.push(evt),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "llm-tracker:attention-open-session");
  assert.equal(emitted[0].detail.item.sessionId, ITEM.sessionId);
});

test("UI dispatcher can copy item context through clipboard", async () => {
  const writes = [];
  const result = await dispatchAttentionAction(ITEM, action("copy_context"), {
    clipboard: { writeText: async (text) => writes.push(text) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.copied, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"sessionId": "ses_01h/);
});

test("UI and hub plans agree on default feature gating", () => {
  const kind = "rollover";
  assert.equal(getHubPlan(ITEM, action(kind)).enabled, false);
  assert.equal(getUiPlan(ITEM, action(kind)).enabled, false);
  assert.equal(
    getHubPlan(ITEM, action(kind), { features: { rollover: true } }).enabled,
    true,
  );
  assert.equal(
    getUiPlan(ITEM, action(kind), { features: { rollover: true } }).enabled,
    true,
  );
});
