// test/runtime-idempotency.test.js — sh-1-03 (TDD v0.5 §6.6, §5.2)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IdempotencyIndex,
  DEFAULT_DEDUPE_WINDOW_MS,
} from "../hub/runtime/idempotency.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { makeRuntimeId, RUNTIME_EVENT_ID_RE } from "../hub/runtime/ids.js";

const ROOT = process.platform === "win32" ? "C:\\workspace\\proj" : "/workspace/proj";

// --- IdempotencyIndex unit tests ---------------------------------------------

test("IdempotencyIndex.key returns null when idempotencyKey is missing/blank/non-string", () => {
  assert.equal(IdempotencyIndex.key({ source: "mcp" }), null);
  assert.equal(IdempotencyIndex.key({ source: "mcp", idempotencyKey: "" }), null);
  assert.equal(IdempotencyIndex.key({ source: "mcp", idempotencyKey: 123 }), null);
  assert.equal(IdempotencyIndex.key({}), null);
});

test("IdempotencyIndex.key returns null when source is missing/blank/non-string", () => {
  assert.equal(IdempotencyIndex.key({ idempotencyKey: "k1" }), null);
  assert.equal(IdempotencyIndex.key({ source: "", idempotencyKey: "k1" }), null);
  assert.equal(IdempotencyIndex.key({ source: 99, idempotencyKey: "k1" }), null);
});

test("IdempotencyIndex.key combines sessionId/jobId/source/idempotencyKey consistently", () => {
  const k1 = IdempotencyIndex.key({
    sessionId: "ses_1",
    jobId: "job_1",
    source: "mcp",
    idempotencyKey: "abc",
  });
  const k2 = IdempotencyIndex.key({
    sessionId: "ses_1",
    jobId: "job_1",
    source: "mcp",
    idempotencyKey: "abc",
  });
  assert.equal(k1, k2);
  assert.equal(typeof k1, "string");
  assert.ok(k1.includes("ses_1"));
  assert.ok(k1.includes("job_1"));
  assert.ok(k1.includes("mcp"));
  assert.ok(k1.includes("abc"));
});

test("IdempotencyIndex.key treats absent sessionId/jobId as distinct from present ones", () => {
  const both = IdempotencyIndex.key({
    sessionId: "ses_1",
    jobId: "job_1",
    source: "mcp",
    idempotencyKey: "abc",
  });
  const sessionOnly = IdempotencyIndex.key({
    sessionId: "ses_1",
    source: "mcp",
    idempotencyKey: "abc",
  });
  const neither = IdempotencyIndex.key({ source: "mcp", idempotencyKey: "abc" });
  assert.notEqual(both, sessionOnly);
  assert.notEqual(sessionOnly, neither);
  assert.notEqual(both, neither);
});

test("IdempotencyIndex set+get returns cached eventId/rev within window", () => {
  let now = 1_000_000;
  const idx = new IdempotencyIndex({ windowMs: 60_000, clock: () => now });
  const k = IdempotencyIndex.key({ source: "mcp", idempotencyKey: "x" });
  idx.set(k, { eventId: "evt_aaa", rev: 7 });
  now += 30_000; // still within window
  assert.deepEqual(idx.get(k), { eventId: "evt_aaa", rev: 7 });
});

test("IdempotencyIndex.get returns null and lazily prunes when entry is past windowMs", () => {
  let now = 1_000_000;
  const idx = new IdempotencyIndex({ windowMs: 60_000, clock: () => now });
  const k = IdempotencyIndex.key({ source: "mcp", idempotencyKey: "x" });
  idx.set(k, { eventId: "evt_bbb", rev: 2 });
  assert.equal(idx.size, 1);
  now += 60_001; // just past the window
  assert.equal(idx.get(k), null);
  assert.equal(idx.size, 0, "expired entry must be lazily deleted on get()");
});

test("IdempotencyIndex.prune() drops every expired entry in one sweep", () => {
  let now = 1_000_000;
  const idx = new IdempotencyIndex({ windowMs: 1_000, clock: () => now });
  idx.set("a", { eventId: "evt_a", rev: 1 });
  idx.set("b", { eventId: "evt_b", rev: 2 });
  now += 5_000;
  idx.set("c", { eventId: "evt_c", rev: 3 });
  assert.equal(idx.size, 3);
  idx.prune();
  assert.equal(idx.size, 1, "only the freshly-recorded entry survives the sweep");
  assert.deepEqual(idx.get("c"), { eventId: "evt_c", rev: 3 });
});

test("IdempotencyIndex rejects invalid windowMs / clock", () => {
  assert.throws(() => new IdempotencyIndex({ windowMs: -1 }), /windowMs/);
  assert.throws(() => new IdempotencyIndex({ windowMs: Number.NaN }), /windowMs/);
  assert.throws(() => new IdempotencyIndex({ clock: "not-a-fn" }), /clock/);
});

test("IdempotencyIndex default windowMs is 5 minutes", () => {
  const idx = new IdempotencyIndex();
  assert.equal(idx.windowMs, DEFAULT_DEDUPE_WINDOW_MS);
  assert.equal(idx.windowMs, 5 * 60 * 1000);
});

test("IdempotencyIndex.set/get are no-ops for falsy keys", () => {
  const idx = new IdempotencyIndex();
  idx.set(null, { eventId: "evt_x", rev: 1 });
  idx.set("", { eventId: "evt_x", rev: 1 });
  assert.equal(idx.size, 0);
  assert.equal(idx.get(null), null);
  assert.equal(idx.get(""), null);
  assert.equal(idx.get(undefined), null);
});

// --- RuntimeStore integration tests ------------------------------------------

test("RuntimeStore accepts idempotencyWindowMs + clock options", () => {
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    idempotencyWindowMs: 60_000,
    clock: () => 42,
  });
  assert.equal(store.idempotency.windowMs, 60_000);
  assert.equal(store.idempotency.clock(), 42);
});

test("Two appends with same (source, idempotencyKey) return identical eventId+rev, second deduped", async () => {
  const calls = [];
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    onAppend: (ev) => {
      calls.push(ev.id);
    },
  });
  const event = { type: "job.checkpoint", source: "mcp", idempotencyKey: "ckpt-1" };
  const r1 = await store.append({ ...event });
  const r2 = await store.append({ ...event });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.eventId, r2.eventId);
  assert.equal(r1.rev, r2.rev);
  assert.equal(r1.deduped, undefined, "first call must not be marked deduped");
  assert.equal(r2.deduped, true, "retry must be marked deduped");
  assert.equal(calls.length, 1, "onAppend hook fires exactly once across both calls");
  assert.equal(store.rev, 1, "rev only bumps for the original");
});

test("Same key with sessionId scope dedupes; different sessionId does not", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const baseA = {
    type: "session.status",
    source: "mcp",
    idempotencyKey: "hb-1",
    sessionId: "ses_1",
  };
  const r1 = await store.append({ ...baseA });
  const r2 = await store.append({ ...baseA });
  assert.equal(r2.deduped, true);
  assert.equal(r1.eventId, r2.eventId);

  // Different sessionId, same idempotencyKey → distinct
  const r3 = await store.append({
    type: "session.status",
    source: "mcp",
    idempotencyKey: "hb-1",
    sessionId: "ses_2",
  });
  assert.notEqual(r3.eventId, r1.eventId);
  assert.equal(r3.deduped, undefined);
  assert.equal(r3.rev, 2);
});

test("Same idempotencyKey scoped by jobId only is distinct from sessionId scoping", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const r1 = await store.append({
    type: "job.checkpoint",
    source: "mcp",
    idempotencyKey: "k",
    jobId: "job_a",
  });
  const r2 = await store.append({
    type: "job.checkpoint",
    source: "mcp",
    idempotencyKey: "k",
    sessionId: "ses_x",
  });
  assert.notEqual(r1.eventId, r2.eventId);
  assert.equal(r2.deduped, undefined);
});

test("Nested event.session.id / event.job.id are honored as fallback scope", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const baseA = {
    type: "session.status",
    source: "mcp",
    idempotencyKey: "nested-1",
    session: { id: "ses_42" },
  };
  const r1 = await store.append({ ...baseA });
  // Same scope expressed through top-level sessionId must dedupe with r1.
  const r2 = await store.append({
    type: "session.status",
    source: "mcp",
    idempotencyKey: "nested-1",
    sessionId: "ses_42",
  });
  assert.equal(r2.deduped, true);
  assert.equal(r2.eventId, r1.eventId);
});

test("Different idempotencyKey → no dedupe → distinct eventId+rev", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const r1 = await store.append({ type: "x", source: "mcp", idempotencyKey: "a" });
  const r2 = await store.append({ type: "x", source: "mcp", idempotencyKey: "b" });
  assert.notEqual(r1.eventId, r2.eventId);
  assert.equal(r1.rev, 1);
  assert.equal(r2.rev, 2);
  assert.equal(r2.deduped, undefined);
});

test("Missing idempotencyKey → never dedupes (always appends)", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const r1 = await store.append({ type: "ping", source: "mcp" });
  const r2 = await store.append({ type: "ping", source: "mcp" });
  const r3 = await store.append({ type: "ping", source: "mcp" });
  assert.notEqual(r1.eventId, r2.eventId);
  assert.notEqual(r2.eventId, r3.eventId);
  assert.equal(r3.rev, 3);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.deduped, undefined);
    assert.ok(RUNTIME_EVENT_ID_RE.test(r.eventId));
  }
});

test("Missing source on an event with idempotencyKey still appends (no dedupe)", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const r1 = await store.append({ type: "x", idempotencyKey: "k" });
  const r2 = await store.append({ type: "x", idempotencyKey: "k" });
  assert.notEqual(r1.eventId, r2.eventId);
  assert.equal(r2.deduped, undefined);
});

test("After windowMs elapses the same key produces a fresh append", async () => {
  let now = 5_000_000;
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    idempotencyWindowMs: 1_000,
    clock: () => now,
  });
  const evt = { type: "x", source: "mcp", idempotencyKey: "expiring" };
  const r1 = await store.append({ ...evt });
  // Inside window → dedupes.
  const r2 = await store.append({ ...evt });
  assert.equal(r2.deduped, true);
  assert.equal(r2.eventId, r1.eventId);
  // Advance past the window → fresh append.
  now += 1_001;
  const r3 = await store.append({ ...evt });
  assert.notEqual(r3.eventId, r1.eventId);
  assert.equal(r3.deduped, undefined);
  assert.equal(r3.rev, 2);
});

test("onAppend hook is NOT called for deduped retries", async () => {
  let calls = 0;
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    onAppend: async () => {
      calls += 1;
    },
  });
  const evt = { type: "x", source: "mcp", idempotencyKey: "hook-check" };
  await store.append({ ...evt });
  await store.append({ ...evt });
  await store.append({ ...evt });
  assert.equal(calls, 1, "onAppend invoked exactly once across three identical calls");
});

test("Concurrent identical retries dedupe to a single append", async () => {
  let calls = 0;
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    onAppend: async () => {
      // Add a tiny delay to widen the race window.
      await new Promise((res) => setTimeout(res, 5));
      calls += 1;
    },
  });
  const evt = { type: "x", source: "mcp", idempotencyKey: "race", sessionId: "ses_r" };
  const results = await Promise.all([
    store.append({ ...evt }),
    store.append({ ...evt }),
    store.append({ ...evt }),
    store.append({ ...evt }),
  ]);
  assert.equal(calls, 1, "only the first concurrent call performs the append");
  const uniqueIds = new Set(results.map((r) => r.eventId));
  assert.equal(uniqueIds.size, 1, "all four results share the same eventId");
  assert.equal(results.filter((r) => r.deduped === true).length, 3);
  assert.equal(results.filter((r) => r.deduped === undefined).length, 1);
});

test("Dedupe does NOT mutate the caller-supplied event object", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const ev = { type: "x", source: "mcp", idempotencyKey: "k" };
  await store.append(ev);
  await store.append(ev);
  assert.equal(ev.id, undefined, "caller object must remain pristine");
});

test("Different source with same idempotencyKey → distinct events", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  const r1 = await store.append({ type: "x", source: "mcp", idempotencyKey: "k" });
  const r2 = await store.append({ type: "x", source: "http", idempotencyKey: "k" });
  assert.notEqual(r1.eventId, r2.eventId);
  assert.equal(r2.deduped, undefined);
});
