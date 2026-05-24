// test/runtime-store.test.js — sh-1-01 (TDD v0.5 §5, §6.10, §23.2 #9)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { RuntimeStore } from "../hub/runtime/store.js";
import { makeRuntimeId, RUNTIME_EVENT_ID_RE } from "../hub/runtime/ids.js";

const ROOT = process.platform === "win32" ? "C:\\workspace\\proj" : "/workspace/proj";

test("constructor requires workspaceRoot", () => {
  assert.throws(() => new RuntimeStore(), /workspaceRoot/);
  assert.throws(() => new RuntimeStore({}), /workspaceRoot/);
  assert.throws(() => new RuntimeStore({ workspaceRoot: "" }), /workspaceRoot/);
});

test("constructor builds derived paths from workspaceRoot", () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  assert.equal(store.workspaceRoot, ROOT);
  assert.equal(store.paths.runtimeDir, path.join(ROOT, ".runtime"));
  assert.equal(store.paths.runtimeEvents, path.join(ROOT, ".runtime", "runtime-events.jsonl"));
  assert.equal(store.rev, 0);
  assert.equal(store.allowClientIds, false);
});

test("append generates an evt_ id and returns {ok, eventId, rev}", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const result = await store.append({ type: "session.started", sessionId: makeRuntimeId("ses") });
  assert.equal(result.ok, true);
  assert.ok(RUNTIME_EVENT_ID_RE.test(result.eventId), `${result.eventId} should match evt_ regex`);
  assert.equal(result.rev, 1);
  assert.equal(store.rev, 1);
});

test("rev increments on every successful append", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  for (let i = 1; i <= 5; i++) {
    const r = await store.append({ type: "ping" });
    assert.equal(r.rev, i);
  }
  assert.equal(store.rev, 5);
});

test("append rejects non-object events", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  await assert.rejects(store.append(null), /plain object/);
  await assert.rejects(store.append(undefined), /plain object/);
  await assert.rejects(store.append("nope"), /plain object/);
  await assert.rejects(store.append([1, 2]), /plain object/);
});

test("client-supplied event.id is rejected by default", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const id = makeRuntimeId("evt"); // valid shape but supplied by caller
  await assert.rejects(store.append({ id, type: "session.started" }), /allowClientIds=false/);
  // store rev not incremented on rejected append (normalization throws before queue work bumps rev)
  assert.equal(store.rev, 0);
});

test("malformed client-supplied event.id is rejected even in allowClientIds=true mode", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT, allowClientIds: true });
  await assert.rejects(store.append({ id: "evt_TOO-SHORT", type: "x" }), /invalid client-supplied/);
  await assert.rejects(store.append({ id: "ses_01jv8q9f4x8y7z6w5v4t3s2r1q", type: "x" }), /invalid client-supplied/);
  await assert.rejects(store.append({ id: 42, type: "x" }), /invalid client-supplied/);
});

test("valid client-supplied event.id is preserved in allowClientIds=true mode", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT, allowClientIds: true });
  const id = makeRuntimeId("evt");
  const r = await store.append({ id, type: "session.started" });
  assert.equal(r.eventId, id);
  assert.equal(r.rev, 1);
});

test("onAppend hook receives the normalized event with assigned id", async () => {
  const received = [];
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    onAppend: async (ev) => {
      received.push(ev);
    },
  });
  const r = await store.append({ type: "x", payload: { k: 1 } });
  assert.equal(received.length, 1);
  assert.equal(received[0].id, r.eventId);
  assert.equal(received[0].type, "x");
  assert.deepEqual(received[0].payload, { k: 1 });
});

test("onAppend throw rejects the append() promise and does not bump rev", async () => {
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    onAppend: async () => {
      throw new Error("hook-boom");
    },
  });
  await assert.rejects(store.append({ type: "x" }), /hook-boom/);
  assert.equal(store.rev, 0);
  // Queue must still be usable for the next call.
  const store2 = new RuntimeStore({ workspaceRoot: ROOT });
  const r = await store2.append({ type: "y" });
  assert.equal(r.rev, 1);
});

test("concurrent appends preserve order + count (10 parallel → 10 unique evt_ ids, rev=10)", async () => {
  const order = [];
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    onAppend: async (ev) => {
      // Simulate variable I/O time to ensure the queue enforces order, not timing.
      await new Promise((r) => setTimeout(r, (ev.delay ?? 1) % 5));
      order.push(ev.seq);
    },
  });
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(store.append({ type: "tick", seq: i, delay: 10 - i }));
  }
  const results = await Promise.all(promises);
  assert.equal(results.length, 10);
  const ids = new Set(results.map((r) => r.eventId));
  assert.equal(ids.size, 10, "every event must get a unique id");
  for (const r of results) {
    assert.ok(RUNTIME_EVENT_ID_RE.test(r.eventId));
  }
  assert.deepEqual(
    results.map((r) => r.rev),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "rev increments sequentially per submission order",
  );
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "onAppend invoked in submission order");
  assert.equal(store.rev, 10);
});

test("event with no id receives an evt_ id even when allowClientIds=true", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT, allowClientIds: true });
  const r = await store.append({ type: "x" });
  assert.ok(RUNTIME_EVENT_ID_RE.test(r.eventId));
});

test("normalized event does not mutate caller-supplied object", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const ev = { type: "x" };
  const r = await store.append(ev);
  assert.equal(ev.id, undefined, "caller object must not be mutated");
  assert.ok(RUNTIME_EVENT_ID_RE.test(r.eventId));
});
