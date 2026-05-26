// test/runtime-ws.test.js — sh-1-08 (TDD v0.5 §5.2, §15)
//
// Covers the standalone RuntimeBroadcaster: snapshot-on-subscribe, per-event
// fan-out, slow-client backpressure (drop + close policies), unsubscribe on
// 'close', and the synchronous return contract for broadcast().
//
// All tests use in-process fake WebSocket objects so they are deterministic
// and never bind a network socket. The real `ws` package is exercised by the
// existing daemon/healthz/security integration tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { RuntimeBroadcaster } from "../hub/runtime/ws.js";

const TEST_TIMEOUT_MS = 5000;
const WS_OPEN = 1;
const WS_CLOSED = 3;

/**
 * Build a minimal WebSocket-like stub. `sent` collects every payload passed
 * to `ws.send()`. `closeCalls` records every `close(code, reason)` invocation.
 * Listener registration is tracked so tests can fire 'close'/'error' events
 * deterministically.
 */
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
    off(event, fn) {
      const arr = listeners.get(event) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    emit(event, ...args) {
      const fns = (listeners.get(event) || []).slice();
      for (const fn of fns) fn(...args);
    },
  };
  return { ws, sent, closeCalls };
}

test("subscribe() delivers a runtime.snapshot as the first message", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const { ws, sent } = makeFakeWs();
  await broadcaster.subscribe(ws, () => ({
    sessions: [],
    jobs: [{ id: "job_x" }],
    skillRuns: [],
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "runtime.snapshot");
  assert.deepEqual(sent[0].snapshot, {
    sessions: [],
    jobs: [{ id: "job_x" }],
    skillRuns: [],
  });
});

test("subscribe() awaits an async getSnapshot before sending", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const { ws, sent } = makeFakeWs();
  await broadcaster.subscribe(ws, async () => {
    await new Promise((r) => setImmediate(r));
    return { async: true };
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: "runtime.snapshot", snapshot: { async: true } });
});

test("broadcast() fans every event out to every subscribed client", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const clients = [];
  for (let i = 0; i < 3; i++) {
    const { ws, sent } = makeFakeWs();
    await broadcaster.subscribe(ws, () => ({ tag: `snap-${i}` }));
    clients.push({ ws, sent });
  }
  assert.equal(broadcaster.clientCount, 3);
  for (let i = 0; i < 5; i++) {
    broadcaster.broadcast({ id: `evt_${i}`, type: "ping", n: i });
  }
  for (let i = 0; i < 3; i++) {
    const { sent } = clients[i];
    assert.equal(sent.length, 6, "expected snapshot + 5 events");
    assert.equal(sent[0].type, "runtime.snapshot");
    assert.deepEqual(sent[0].snapshot, { tag: `snap-${i}` });
    for (let j = 0; j < 5; j++) {
      assert.equal(sent[j + 1].type, "runtime.event");
      assert.equal(sent[j + 1].event.n, j);
      assert.equal(sent[j + 1].event.id, `evt_${j}`);
    }
  }
});

test("broadcast() returns synchronously (not a Promise)", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const ret = broadcaster.broadcast({ id: "evt_a", type: "ping" });
  assert.equal(ret, undefined);
  assert.equal(typeof ret, "undefined");
  // Even with a subscriber whose send returns a never-resolving promise,
  // broadcast() does not await it.
  let sendCalls = 0;
  const fakeWs = {
    readyState: WS_OPEN,
    bufferedAmount: 0,
    send: () => {
      sendCalls += 1;
      return new Promise(() => {});
    },
    on: () => {},
    close: () => {},
  };
  await broadcaster.subscribe(fakeWs, () => ({}));
  const t0 = performance.now();
  const ret2 = broadcaster.broadcast({ id: "evt_b", type: "ping" });
  const elapsed = performance.now() - t0;
  assert.equal(ret2, undefined);
  assert.ok(elapsed < 50, `broadcast() should return quickly, took ${elapsed}ms`);
  assert.equal(sendCalls, 2, "send called for snapshot + event");
});

test("slow client (drop policy) does not stall broadcast() and receives runtime.lag", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster({
    slowClientPolicy: "drop",
    slowClientThresholdBytes: 1024,
    lagReportEveryMessages: 50,
  });

  const { ws: fastWs, sent: fastSent } = makeFakeWs();
  const { ws: slowWs, sent: slowSent } = makeFakeWs({ bufferedAmount: 2048 });

  await broadcaster.subscribe(fastWs, () => ({ which: "fast" }));
  await broadcaster.subscribe(slowWs, () => ({ which: "slow" }));

  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    broadcaster.broadcast({ id: `evt_${i}`, type: "ping", n: i });
  }
  const elapsed = performance.now() - t0;
  assert.ok(
    elapsed < 50,
    `200 broadcasts must complete quickly even with a slow client (took ${elapsed}ms)`,
  );

  // Fast client got snapshot + 200 events.
  assert.equal(fastSent.length, 201);
  assert.equal(fastSent[0].type, "runtime.snapshot");
  assert.equal(fastSent[200].type, "runtime.event");
  assert.equal(fastSent[200].event.n, 199);

  // Slow client: snapshot was sent in subscribe() before bufferedAmount is
  // consulted by broadcast(). After that every broadcast drops; every Nth
  // drop emits a runtime.lag notice.
  assert.equal(slowSent[0].type, "runtime.snapshot");
  const lag = slowSent.find((m) => m.type === "runtime.lag");
  assert.ok(lag, "expected a runtime.lag message");
  assert.equal(typeof lag.missedEvents, "number");
  assert.ok(
    lag.missedEvents >= 50,
    `missedEvents should be at least lagReportEveryMessages (got ${lag.missedEvents})`,
  );
  assert.equal(
    slowSent.filter((m) => m.type === "runtime.event").length,
    0,
    "slow client must not receive runtime.event payloads under drop policy",
  );
});

test("slow client (close policy) is closed with code 1011 + 'slow_consumer'", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster({
    slowClientPolicy: "close",
    slowClientThresholdBytes: 512,
  });
  const { ws, closeCalls } = makeFakeWs({ bufferedAmount: 4096 });
  await broadcaster.subscribe(ws, () => ({ which: "slow" }));
  assert.equal(broadcaster.clientCount, 1);
  broadcaster.broadcast({ id: "evt_a", type: "ping" });
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].code, 1011);
  assert.equal(closeCalls[0].reason, "slow_consumer");
  assert.equal(broadcaster.clientCount, 0);
});

test("clients are unsubscribed when their ws emits 'close'", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const { ws } = makeFakeWs();
  await broadcaster.subscribe(ws, () => ({}));
  assert.equal(broadcaster.clientCount, 1);
  ws.emit("close", { code: 1000, reason: "client done" });
  assert.equal(broadcaster.clientCount, 0);
});

test("clients are unsubscribed when their ws emits 'error'", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const { ws } = makeFakeWs();
  await broadcaster.subscribe(ws, () => ({}));
  assert.equal(broadcaster.clientCount, 1);
  ws.emit("error", new Error("simulated"));
  assert.equal(broadcaster.clientCount, 0);
});

test("handleAppend forwards to broadcast (RuntimeStore plug-in shape)", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const { ws, sent } = makeFakeWs();
  await broadcaster.subscribe(ws, () => ({ initial: true }));
  broadcaster.handleAppend({ id: "evt_x", type: "session.started" });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "runtime.snapshot");
  assert.deepEqual(sent[0].snapshot, { initial: true });
  assert.equal(sent[1].type, "runtime.event");
  assert.equal(sent[1].event.id, "evt_x");
});

test("broadcastTimeline sends timeline.appended with itemCount", { timeout: TEST_TIMEOUT_MS }, async () => {
  const broadcaster = new RuntimeBroadcaster();
  const { ws, sent } = makeFakeWs();
  await broadcaster.subscribe(ws, () => ({ initial: true }));
  const items = [
    {
      id: "tl_1",
      sessionId: "ses_01ksd83zzzzzzzzzzzzzzzzzzz",
      kind: "status",
      title: "Session running",
      ts: "2026-05-24T12:00:00.000Z",
      source: "mcp",
      confidence: "structured",
      evidenceRef: "evt_01ksd83zzzzzzzzzzzzzzzzzzz",
    },
  ];
  broadcaster.broadcastTimeline({
    sessionId: "ses_01ksd83zzzzzzzzzzzzzzzzzzz",
    items,
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, "timeline.appended");
  assert.equal(sent[1].sessionId, "ses_01ksd83zzzzzzzzzzzzzzzzzzz");
  assert.equal(sent[1].itemCount, 1);
  assert.deepEqual(sent[1].items, items);
});

test("constructor rejects invalid options", { timeout: TEST_TIMEOUT_MS }, () => {
  assert.throws(() => new RuntimeBroadcaster({ slowClientPolicy: "kill" }), /slowClientPolicy/);
  assert.throws(
    () => new RuntimeBroadcaster({ slowClientThresholdBytes: -1 }),
    /slowClientThresholdBytes/,
  );
  assert.throws(() => new RuntimeBroadcaster({ lagReportEveryMessages: 0 }), /lagReportEveryMessages/);
});
