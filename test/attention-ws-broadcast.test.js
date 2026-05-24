// test/attention-ws-broadcast.test.js — SH-4-09 (TDD v0.5 §15, §8A.4)
//
// Covers RuntimeBroadcaster.broadcastAttention: the on-wire envelope
// (`{type:"attention.updated", items, scope}`), scope validation, empty-items
// fan-out, and reuse of the slow-client policy shared with broadcast().

import { test } from "node:test";
import assert from "node:assert/strict";

import { RuntimeBroadcaster } from "../hub/runtime/ws.js";

const TEST_TIMEOUT_MS = 5000;
const WS_OPEN = 1;
const WS_CLOSED = 3;

function makeFakeWs({ bufferedAmount = 0 } = {}) {
  const sent = [];
  const closeCalls = [];
  const listeners = new Map();
  let _bufferedAmount = bufferedAmount;
  let _readyState = WS_OPEN;
  const ws = {
    get readyState() {
      return _readyState;
    },
    set readyState(v) {
      _readyState = v;
    },
    get bufferedAmount() {
      return _bufferedAmount;
    },
    set bufferedAmount(v) {
      _bufferedAmount = v;
    },
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close(code, reason) {
      closeCalls.push({ code, reason });
      _readyState = WS_CLOSED;
      const fns = listeners.get("close") || [];
      for (const fn of fns) fn({ code, reason });
    },
    on(event, fn) {
      const arr = listeners.get(event) || [];
      arr.push(fn);
      listeners.set(event, arr);
    },
    emit(event, ...args) {
      const fns = (listeners.get(event) || []).slice();
      for (const fn of fns) fn(...args);
    },
  };
  return { ws, sent, closeCalls };
}

function sampleItem(overrides = {}) {
  return {
    id: "att_test_1",
    kind: "unbound_session",
    severity: "low",
    title: "Unbound session",
    detail: "Bind a task or acknowledge to clear.",
    source: "derived",
    sessionId: "ses_01h00000000000000000000000",
    createdAt: "2026-05-24T12:05:00.000Z",
    updatedAt: "2026-05-24T12:05:00.000Z",
    dedupeKey: "unbound_session||ses_01h00000000000000000000000|||",
    recommendedActions: [],
    ...overrides,
  };
}

test(
  "broadcastAttention writes {type:'attention.updated',items,scope} to every subscriber",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const broadcaster = new RuntimeBroadcaster();
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const { ws, sent } = makeFakeWs();
      await broadcaster.subscribe(ws, () => ({ tag: `snap-${i}` }));
      clients.push({ ws, sent });
    }
    const items = [sampleItem()];
    broadcaster.broadcastAttention({ items, scope: "global" });
    for (const { sent } of clients) {
      // snapshot + attention.updated
      assert.equal(sent.length, 2);
      assert.equal(sent[1].type, "attention.updated");
      assert.equal(sent[1].scope, "global");
      assert.deepEqual(sent[1].items, items);
    }
  },
);

test(
  "broadcastAttention rejects invalid scope",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const broadcaster = new RuntimeBroadcaster();
    assert.throws(
      () => broadcaster.broadcastAttention({ items: [], scope: "bogus" }),
      /scope must be 'global' or 'project'/,
    );
    assert.throws(
      () => broadcaster.broadcastAttention({ items: [], scope: undefined }),
      /scope must be 'global' or 'project'/,
    );
  },
);

test(
  "broadcastAttention rejects non-array items",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const broadcaster = new RuntimeBroadcaster();
    assert.throws(
      () => broadcaster.broadcastAttention({ items: null, scope: "global" }),
      /items must be an array/,
    );
    assert.throws(
      () => broadcaster.broadcastAttention({ items: "x", scope: "global" }),
      /items must be an array/,
    );
  },
);

test(
  "broadcastAttention with empty items still broadcasts (consumer wants to see empty set)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const broadcaster = new RuntimeBroadcaster();
    const { ws, sent } = makeFakeWs();
    await broadcaster.subscribe(ws, () => ({}));
    broadcaster.broadcastAttention({ items: [], scope: "global" });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].type, "attention.updated");
    assert.deepEqual(sent[1].items, []);
    assert.equal(sent[1].scope, "global");
  },
);

test(
  "broadcastAttention accepts scope='project'",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const broadcaster = new RuntimeBroadcaster();
    const { ws, sent } = makeFakeWs();
    await broadcaster.subscribe(ws, () => ({}));
    broadcaster.broadcastAttention({ items: [sampleItem()], scope: "project" });
    assert.equal(sent[1].scope, "project");
  },
);

test(
  "broadcastAttention applies the slow-client drop policy",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const broadcaster = new RuntimeBroadcaster({
      slowClientPolicy: "drop",
      slowClientThresholdBytes: 1024,
      lagReportEveryMessages: 5,
    });
    const { ws: fast, sent: fastSent } = makeFakeWs();
    const { ws: slow, sent: slowSent } = makeFakeWs({ bufferedAmount: 2048 });
    await broadcaster.subscribe(fast, () => ({ which: "fast" }));
    await broadcaster.subscribe(slow, () => ({ which: "slow" }));

    for (let i = 0; i < 10; i++) {
      broadcaster.broadcastAttention({ items: [sampleItem()], scope: "global" });
    }
    // Fast client receives every attention.updated.
    const fastDeliveries = fastSent.filter((m) => m.type === "attention.updated");
    assert.equal(fastDeliveries.length, 10);
    // Slow client receives no attention.updated (drop policy), but DOES get a
    // runtime.lag notice after lagReportEveryMessages drops.
    const slowDeliveries = slowSent.filter((m) => m.type === "attention.updated");
    assert.equal(slowDeliveries.length, 0);
    const lag = slowSent.find((m) => m.type === "runtime.lag");
    assert.ok(lag, "expected a runtime.lag message after slow-client drops");
  },
);

test(
  "broadcastAttention applies the slow-client close policy (code 1011, slow_consumer)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const broadcaster = new RuntimeBroadcaster({
      slowClientPolicy: "close",
      slowClientThresholdBytes: 512,
    });
    const { ws, closeCalls } = makeFakeWs({ bufferedAmount: 4096 });
    await broadcaster.subscribe(ws, () => ({}));
    assert.equal(broadcaster.clientCount, 1);
    broadcaster.broadcastAttention({ items: [sampleItem()], scope: "global" });
    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0].code, 1011);
    assert.equal(closeCalls[0].reason, "slow_consumer");
    assert.equal(broadcaster.clientCount, 0);
  },
);

test(
  "broadcastAttention does NOT touch the existing broadcast() envelope",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    // Sanity: broadcast() still ships {type:'runtime.event',event} unchanged.
    const broadcaster = new RuntimeBroadcaster();
    const { ws, sent } = makeFakeWs();
    await broadcaster.subscribe(ws, () => ({}));
    broadcaster.broadcast({ id: "evt_x", type: "ping" });
    broadcaster.broadcastAttention({ items: [], scope: "global" });
    assert.equal(sent[1].type, "runtime.event");
    assert.equal(sent[1].event.id, "evt_x");
    assert.equal(sent[2].type, "attention.updated");
  },
);
