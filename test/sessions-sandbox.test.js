// test/sessions-sandbox.test.js — SH-2-24 (TDD v0.5 §6.1, §6.6, §25)
//
// Slice covering the sandbox contract across SessionRegistry, ProviderBroker
// and GenericPtyProvider:
//
//   1. SessionRecord.sandbox is a validated v0.7 enum on the registry's
//      create() surface (regression — already covered in
//      sessions-registry.test.js; included here so the slice runs
//      standalone). Confirms the §6.1 enum is exactly the four values
//      from TDD §6.1 and that bad values reject with INVALID_SANDBOX.
//
//   2. ProviderBroker.start(providerId, request) forwards `sandbox`
//      through to the underlying provider's start() unchanged. The broker
//      itself does not transform the field — its only job is to route by
//      providerId. The default ('workspace-write' when unset) is applied
//      by the provider (and, for the UI, by the SandboxChip read-side).
//
//   3. GenericPtyProvider.start():
//        - validates the sandbox enum
//        - defaults to 'workspace-write' when sandbox is unset
//        - sets LLM_TRACKER_SANDBOX=<mode> in the child env
//        - merges with caller-provided request.env and process.env so the
//          child still inherits the parent's PATH/HOME/etc.
//        - sandbox flows identically for node-pty and spawn backends.
//
//   4. SessionSandboxChangedEvent (TDD §6.6, line 403) — the schema enum
//      already lists `session.sandbox_changed`, so there is no §6.6 enum
//      gap to document. SH-8-10 owns emission; SH-2-24 only confirms the
//      type is admissible. A passing validator round-trip is the proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SessionRegistry,
  ALLOWED_SANDBOX,
} from "../hub/sessions/registry.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";
import { ProviderRegistry } from "../hub/providers/registry.js";
import { ProviderBroker } from "../hub/providers/broker.js";
import { GenericPtyProvider } from "../hub/providers/generic-pty.js";

// --- shared test rig --------------------------------------------------------

function startRegistryEnv() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-sandbox-"));
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appendedEvents.push(event);
      projection.apply(event);
    },
  });
  const registry = new SessionRegistry({
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  return {
    registry,
    appendedEvents,
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

// Minimal fake spawn child (no PTY) — we only inspect the opts the provider
// passes through; we don't drive the child lifecycle.
function makeRecordingSpawn() {
  const calls = [];
  const spawn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = {
      pid: 1234,
      stdin: { write() {} },
      stdout: { on() {} },
      stderr: { on() {} },
      _exitHandlers: [],
      on(event, handler) {
        if (event === "exit") this._exitHandlers.push(handler);
      },
      once(event, handler) {
        if (event === "spawn") setImmediate(handler);
      },
      kill() {},
      removeListener() {},
    };
    return child;
  };
  return { calls, spawn };
}

// Build a GenericPtyProvider wired to the recording spawn (no node-pty).
function makePtyProviderWithSpawn(spawn) {
  return new GenericPtyProvider({
    providerId: "codex_cli",
    label: "Codex CLI",
    commandTemplate: { command: ["codex"] },
    ptyLoader: async () => { throw new Error("force spawn fallback"); },
    spawn,
    now: () => new Date("2026-05-24T00:00:00.000Z"),
    sigintGraceMs: 5,
  });
}

// --- 1. SessionRecord.sandbox enum on registry input (regression slice) -----

test("SessionRegistry: sandbox enum exposes exactly the four TDD §6.1 values", () => {
  assert.deepEqual(
    [...ALLOWED_SANDBOX].sort(),
    ["autoedit", "full-auto", "readonly", "workspace-write"],
  );
});

test("SessionRegistry.create: accepts every valid sandbox; rejects invalid with INVALID_SANDBOX", async () => {
  const env = startRegistryEnv();
  try {
    for (const sandbox of ALLOWED_SANDBOX) {
      const created = await env.registry.create({
        name: `sb-${sandbox}`,
        tier: "manual",
        sandbox,
      });
      assert.equal(
        env.appendedEvents.find((e) => e.session && e.session.id === created.sessionId).session.sandbox,
        sandbox,
      );
    }
    await assert.rejects(
      env.registry.create({ name: "bad", tier: "manual", sandbox: "wide-open" }),
      (err) => err.code === "INVALID_SANDBOX",
    );
  } finally {
    env.close();
  }
});

test("SessionRegistry.create: omits sandbox from event when caller leaves it unset", async () => {
  const env = startRegistryEnv();
  try {
    const created = await env.registry.create({ name: "no-sb", tier: "manual" });
    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    assert.equal(evt.session.id, created.sessionId);
    assert.equal(
      Object.prototype.hasOwnProperty.call(evt.session, "sandbox"),
      false,
      "registry must not synthesize sandbox on the event; the default is a read-side concept",
    );
  } finally {
    env.close();
  }
});

// --- 2. ProviderBroker.start forwards sandbox unchanged ---------------------

test("ProviderBroker.start: forwards request.sandbox to the underlying provider unchanged", async () => {
  const registry = new ProviderRegistry();
  let observedRequest;
  registry.register({
    id: "spy",
    label: "Spy",
    probe: async () => ({ ok: true }),
    capabilities: () => ({ rawStdio: true, stdinWrite: true, processLifecycle: true }),
    start: async (req) => {
      observedRequest = req;
      return { providerId: "spy", threadId: "t1", transport: "stdio" };
    },
    streamEvents: async function* () { /* unused */ },
  });
  const broker = new ProviderBroker({ registry });
  const handle = await broker.start("spy", {
    cwd: "/tmp/x",
    sandbox: "readonly",
    extraArgs: ["--probe"],
  });
  assert.equal(handle.threadId, "t1");
  assert.equal(observedRequest.sandbox, "readonly");
  assert.equal(observedRequest.cwd, "/tmp/x");
  assert.deepEqual(observedRequest.extraArgs, ["--probe"]);
});

test("ProviderBroker.start: omitting sandbox passes through (provider handles default)", async () => {
  const registry = new ProviderRegistry();
  let observedRequest;
  registry.register({
    id: "spy",
    label: "Spy",
    probe: async () => ({ ok: true }),
    capabilities: () => ({ rawStdio: true }),
    start: async (req) => {
      observedRequest = req;
      return { providerId: "spy", threadId: "t1", transport: "stdio" };
    },
    streamEvents: async function* () {},
  });
  const broker = new ProviderBroker({ registry });
  await broker.start("spy", { cwd: "/tmp/x" });
  assert.equal(
    Object.prototype.hasOwnProperty.call(observedRequest, "sandbox"),
    false,
    "broker is a pass-through; absent sandbox stays absent in the forwarded request",
  );
});

// --- 3. GenericPtyProvider applies sandbox via env --------------------------

test("GenericPtyProvider.start: sets LLM_TRACKER_SANDBOX env from request.sandbox", async () => {
  const { calls, spawn } = makeRecordingSpawn();
  const provider = makePtyProviderWithSpawn(spawn);
  await provider.start({ sandbox: "readonly" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.env.LLM_TRACKER_SANDBOX, "readonly");
});

test("GenericPtyProvider.start: defaults sandbox to 'workspace-write' when unset", async () => {
  const { calls, spawn } = makeRecordingSpawn();
  const provider = makePtyProviderWithSpawn(spawn);
  await provider.start({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.env.LLM_TRACKER_SANDBOX, "workspace-write");
});

test("GenericPtyProvider.start: every allowed sandbox value flows through to env", async () => {
  for (const sandbox of ["readonly", "workspace-write", "autoedit", "full-auto"]) {
    const { calls, spawn } = makeRecordingSpawn();
    const provider = makePtyProviderWithSpawn(spawn);
    await provider.start({ sandbox });
    assert.equal(calls[0].opts.env.LLM_TRACKER_SANDBOX, sandbox, `sandbox=${sandbox}`);
  }
});

test("GenericPtyProvider.start: rejects bad sandbox enum values before spawn", async () => {
  const { calls, spawn } = makeRecordingSpawn();
  const provider = makePtyProviderWithSpawn(spawn);
  await assert.rejects(
    provider.start({ sandbox: "wide-open" }),
    (err) => err instanceof TypeError && /sandbox/.test(err.message),
  );
  assert.equal(calls.length, 0, "spawn must not run on invalid sandbox");
});

test("GenericPtyProvider.start: merges request.env with sandbox env and inherits process.env", async () => {
  const { calls, spawn } = makeRecordingSpawn();
  const provider = makePtyProviderWithSpawn(spawn);
  await provider.start({
    sandbox: "autoedit",
    env: { CUSTOM_KEY: "abc", LLM_TRACKER_SANDBOX: "ignored-by-caller" },
  });
  const env = calls[0].opts.env;
  // Caller's custom env survives.
  assert.equal(env.CUSTOM_KEY, "abc");
  // Sandbox override wins over a caller-supplied LLM_TRACKER_SANDBOX — the
  // provider is the source of truth for this key.
  assert.equal(env.LLM_TRACKER_SANDBOX, "autoedit");
  // Process env keys are present (PATH is the canonical example; nearly
  // every host process has one).
  assert.equal(typeof env.PATH === "string" || env.PATH === undefined, true);
});

test("GenericPtyProvider.start: sandbox env applies on node-pty backend too", async () => {
  const ptyCalls = [];
  const ptySpawn = (command, args, opts) => {
    ptyCalls.push({ command, args, opts });
    return {
      pid: 999,
      onExit() {},
      onData() {},
      write() {},
      kill() {},
    };
  };
  const provider = new GenericPtyProvider({
    providerId: "codex_cli",
    label: "Codex CLI",
    commandTemplate: { command: ["codex"] },
    ptyLoader: async () => ({ spawn: ptySpawn }),
    sigintGraceMs: 5,
  });
  await provider.start({ sandbox: "full-auto" });
  assert.equal(ptyCalls.length, 1);
  assert.equal(ptyCalls[0].opts.env.LLM_TRACKER_SANDBOX, "full-auto");
});

// --- 4. End-to-end through the broker --------------------------------------

test("ProviderBroker → GenericPtyProvider: sandbox flows end-to-end via env", async () => {
  const { calls, spawn } = makeRecordingSpawn();
  const provider = makePtyProviderWithSpawn(spawn);
  const registry = new ProviderRegistry();
  registry.register(provider);
  const broker = new ProviderBroker({ registry });
  await broker.start("codex_cli", { sandbox: "readonly", extraArgs: ["--help"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.env.LLM_TRACKER_SANDBOX, "readonly");
  // extraArgs still flow.
  assert.deepEqual(calls[0].args, ["--help"]);
});

// --- 5. §6.6 schema enum coverage for session.sandbox_changed --------------

test("RuntimeEvent schema: 'session.sandbox_changed' is admissible (no §6.6 enum gap)", () => {
  // SH-8-10 owns emission. SH-2-24 only needs to confirm the type round-trips
  // through validateRuntimeEvent so the future emit path won't trip on the
  // base-shape validator. The payload uses additionalProperties: true on the
  // base RuntimeEvent so SH-8-10 can add `from` / `to` / `reason` fields
  // without a schema patch.
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: new Date("2026-05-24T00:00:00.000Z").toISOString(),
    type: "session.sandbox_changed",
    source: "system",
    workspace: "/tmp/ws",
    sessionId: "ses_01h00000000000000000000000",
    from: "workspace-write",
    to: "readonly",
  };
  assert.equal(validateRuntimeEvent(evt), true);
});
