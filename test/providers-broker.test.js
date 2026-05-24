// test/providers-broker.test.js — SH-2-15 (addendum §4 / §6)
//
// ProviderRegistry + ProviderBroker acceptance tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ProviderRegistry, assertValidProvider } from "../hub/providers/registry.js";
import { ProviderBroker, BROKER_ERROR_CODES } from "../hub/providers/broker.js";

// -- fake provider helpers --------------------------------------------------

function fakeProvider(overrides = {}) {
  return {
    id: overrides.id ?? "fake",
    label: overrides.label ?? "Fake Provider",
    probe: overrides.probe ?? (async () => ({ ok: true })),
    capabilities: overrides.capabilities ?? (() => ({ rawStdio: true, stdinWrite: true, processLifecycle: true })),
    start: overrides.start ?? (async (req) => ({ providerId: overrides.id ?? "fake", request: req })),
    streamEvents: overrides.streamEvents ?? (async function* () {
      yield { kind: "thread.started" };
    }),
    ...overrides,
  };
}

// -- ProviderRegistry --------------------------------------------------------

test("assertValidProvider: enforces required shape", () => {
  assert.throws(() => assertValidProvider(null), /must be an object/);
  assert.throws(() => assertValidProvider({}), /id/);
  assert.throws(() => assertValidProvider({ id: "x" }), /label/);
  assert.throws(() => assertValidProvider({ id: "x", label: "X" }), /probe/);
  // valid:
  assertValidProvider(fakeProvider());
});

test("ProviderRegistry.register: stores provider; rejects duplicates and bad shape", () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider({ id: "a" }));
  assert.equal(reg.has("a"), true);
  assert.deepEqual(reg.list().map((p) => p.id), ["a"]);

  assert.throws(() => reg.register(fakeProvider({ id: "a" })), /duplicate providerId 'a'/);
  assert.throws(() => reg.register({}), /id/);
});

test("ProviderRegistry.discover: probes factories; skips failures and !ok probes", async () => {
  const logEvents = [];
  const reg = new ProviderRegistry({ log: (l, m, meta) => logEvents.push({ l, m, meta }) });

  const factories = [
    // healthy factory
    () => fakeProvider({ id: "ok" }),
    // factory that throws
    () => { throw new Error("module not found"); },
    // factory returning a provider whose probe rejects
    () => fakeProvider({ id: "missing-binary", probe: async () => ({ ok: false, reason: "binary not on PATH" }) }),
    // factory returning a provider whose probe throws
    () => fakeProvider({ id: "boom", probe: async () => { throw new Error("syscall failed"); } }),
    // factory returning an invalid provider shape
    () => ({ id: "bad" }),
    // factory returning a healthy second provider
    fakeProvider({ id: "also-ok" }),
  ];

  const result = await reg.discover({ factories });
  assert.deepEqual(result.registered, ["ok", "also-ok"]);
  assert.equal(result.skipped.length, 4);
  assert.ok(result.skipped.some((s) => s.id === "missing-binary"));
  assert.ok(result.skipped.some((s) => s.id === "boom"));
  // The "bad" entry is skipped at shape validation; id is captured.
  assert.ok(result.skipped.some((s) => s.id === "bad"));
  // The throwing factory has no id in the skip record.
  assert.ok(result.skipped.some((s) => s.id === undefined && /factory threw/.test(s.reason)));

  // Log captured at least one entry per skip.
  assert.ok(logEvents.length >= 4);
});

test("ProviderRegistry.discover: deduplicates against already-registered providers", async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider({ id: "ok" }));
  const result = await reg.discover({ factories: [() => fakeProvider({ id: "ok" })] });
  assert.deepEqual(result.registered, []);
  assert.equal(result.skipped[0].reason, "duplicate providerId during discovery");
});

// -- ProviderBroker ----------------------------------------------------------

test("ProviderBroker constructor: requires a registry", () => {
  assert.throws(() => new ProviderBroker(), /registry/);
  assert.throws(() => new ProviderBroker({}), /registry/);
  assert.throws(() => new ProviderBroker({ registry: {} }), /registry/);
  // valid:
  new ProviderBroker({ registry: new ProviderRegistry() });
});

test("ProviderBroker.start: dispatches to provider by id; returns ProviderThreadHandle", async () => {
  const reg = new ProviderRegistry();
  let observed;
  reg.register(fakeProvider({
    id: "alpha",
    start: async (req) => {
      observed = req;
      return { threadId: "t1", providerId: "alpha" };
    },
  }));
  const broker = new ProviderBroker({ registry: reg });
  const handle = await broker.start("alpha", { cwd: "/tmp" });
  assert.deepEqual(handle, { threadId: "t1", providerId: "alpha" });
  assert.deepEqual(observed, { cwd: "/tmp" });
});

test("ProviderBroker.start: unknown providerId → NOT_FOUND", async () => {
  const broker = new ProviderBroker({ registry: new ProviderRegistry() });
  await assert.rejects(
    broker.start("nope", {}),
    (err) => err.code === BROKER_ERROR_CODES.NOT_FOUND && err.details.providerId === "nope",
  );
});

test("ProviderBroker.start: missing providerId → INVALID_ARGUMENT", async () => {
  const broker = new ProviderBroker({ registry: new ProviderRegistry() });
  await assert.rejects(
    broker.start(undefined, {}),
    (err) => err.code === BROKER_ERROR_CODES.INVALID_ARGUMENT,
  );
});

test("ProviderBroker: optional methods raise NOT_SUPPORTED when provider doesn't expose them", async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider({ id: "minimal" }));
  const broker = new ProviderBroker({ registry: reg });

  for (const op of ["attach", "resume", "fork", "send", "steer", "interrupt", "approve", "deny", "stop", "listModels", "listSkills"]) {
    await assert.rejects(
      broker[op]("minimal", {}, {}),
      (err) => err.code === BROKER_ERROR_CODES.NOT_SUPPORTED && err.details.method === op,
      `expected ${op} to raise NOT_SUPPORTED`,
    );
  }
});

test("ProviderBroker: every optional method routes when the provider supports it", async () => {
  const calls = [];
  const reg = new ProviderRegistry();
  reg.register(fakeProvider({
    id: "full",
    listModels: async () => { calls.push("listModels"); return [{ id: "m1" }]; },
    listSkills: async (r) => { calls.push(["listSkills", r]); return [{ id: "s1" }]; },
    attach: async (r) => { calls.push(["attach", r]); return { threadId: "att" }; },
    resume: async (r) => { calls.push(["resume", r]); return { threadId: "res" }; },
    fork: async (r, q) => { calls.push(["fork", r, q]); return { threadId: "fk" }; },
    send: async (r, i) => { calls.push(["send", r, i]); },
    steer: async (r, i) => { calls.push(["steer", r, i]); },
    interrupt: async (r) => { calls.push(["interrupt", r]); },
    approve: async (d) => { calls.push(["approve", d]); },
    deny: async (d) => { calls.push(["deny", d]); },
    stop: async (r) => { calls.push(["stop", r]); },
  }));
  const broker = new ProviderBroker({ registry: reg });

  await broker.listModels("full");
  await broker.listSkills("full", { cwd: "/tmp" });
  await broker.attach("full", { threadId: "x" });
  await broker.resume("full", { threadId: "y" });
  await broker.fork("full", { threadId: "z" }, { prompt: "hi" });
  await broker.send("full", { threadId: "z" }, { text: "go" });
  await broker.steer("full", { threadId: "z" }, { hint: "stop" });
  await broker.interrupt("full", { threadId: "z" });
  await broker.approve("full", { decisionId: "d1" });
  await broker.deny("full", { decisionId: "d2" });
  await broker.stop("full", { threadId: "z" });

  assert.equal(calls.length, 11);
  assert.equal(calls[0], "listModels");
  assert.deepEqual(calls[1], ["listSkills", { cwd: "/tmp" }]);
  assert.deepEqual(calls[4], ["fork", { threadId: "z" }, { prompt: "hi" }]);
});

test("ProviderBroker.streamEvents: returns the provider's AsyncIterable", async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider({
    id: "src",
    streamEvents: async function* () {
      yield { kind: "thread.started" };
      yield { kind: "turn.started" };
      yield { kind: "turn.completed" };
    },
  }));
  const broker = new ProviderBroker({ registry: reg });

  const collected = [];
  for await (const e of broker.streamEvents("src", { threadId: "t" })) {
    collected.push(e.kind);
  }
  assert.deepEqual(collected, ["thread.started", "turn.started", "turn.completed"]);
});

test("ProviderBroker.probe / capabilities / listProviderIds", async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider({ id: "a", capabilities: () => ({ rawStdio: true }) }));
  reg.register(fakeProvider({ id: "b", probe: async () => ({ ok: false, reason: "absent" }) }));
  const broker = new ProviderBroker({ registry: reg });

  assert.deepEqual(broker.listProviderIds(), ["a", "b"]);
  assert.deepEqual(broker.capabilities("a"), { rawStdio: true });
  const probe = await broker.probe("b");
  assert.deepEqual(probe, { ok: false, reason: "absent" });
});
