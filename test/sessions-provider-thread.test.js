// test/sessions-provider-thread.test.js — SH-2-21 (addendum §7)
//
// SessionRegistry.create() accepts the two runtime-only v0.7 input fields
// per addendum §7:
//
//   providerThread?: ProviderThreadRef
//   providerCapabilities?: ProviderCapabilities (20-flag; addendum §5)
//
// Both ride through `session.started.session` via the schema's
// `additionalProperties: true`. They are NEVER written into durable tracker
// JSON. Projection absorption (storing them on projection.sessions[id]) is
// deferred to SH-2-17 / SH-2-18 — provider adapters that emit
// `session.provider.*` events. The regression test at the bottom of this
// file asserts the projection record does NOT carry these keys today, which
// is the property-of-architecture proof that they never reach the durable
// tracker side either: tracker JSON is written by the tracker subsystem
// (`hub/projects.js` / legacy tracker layer), not by the runtime layer that
// the registry feeds — and the runtime layer's projection.sessions Map is
// the only place a SessionRecord shape exists. If it isn't there, it isn't
// anywhere durable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SessionRegistry,
  assertValidProviderThreadRef,
} from "../hub/sessions/registry.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";
import { defaultProviderCapabilities } from "../hub/providers/capabilities.js";

function startEnv() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-sessions-provider-thread-"));
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
    projection,
    appendedEvents,
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

function fullyPopulatedProviderThread() {
  return {
    providerId: "codex-app-server",
    transport: "websocket",
    threadId: "thr_01h00000000000000000000000",
    turnId: "turn_42",
    processHandleId: "proc_01h00000000000000000000000",
    providerSessionId: "psess_01h00000000000000000000000",
    cwd: "/tmp/demo",
    repoRoot: "/tmp/demo",
    worktreePath: "/tmp/demo/wt-1",
    branch: "feature/foo",
    model: "gpt-5-1m",
    resumedFromThreadId: "thr_old",
    forkedFromThreadId: "thr_parent",
    schemaVersion: "v0.7",
  };
}

// --- happy paths -----------------------------------------------------------

test("create: fully-populated providerThread rides through the session.started event", async () => {
  const env = startEnv();
  try {
    const providerThread = fullyPopulatedProviderThread();
    const created = await env.registry.create({
      name: "with-thread",
      tier: "codex_app_server",
      providerThread,
    });
    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    assert.ok(evt, "session.started event was appended");
    assert.deepEqual(evt.session.providerThread, providerThread);
    assert.equal(created.sessionId, evt.session.id);
  } finally {
    env.close();
  }
});

test("create: minimal providerThread (just providerId + transport) is accepted", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create({
      name: "minimal",
      tier: "manual",
      providerThread: { providerId: "manual", transport: "manual" },
    });
    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    assert.deepEqual(evt.session.providerThread, {
      providerId: "manual",
      transport: "manual",
    });
    assert.ok(created.sessionId);
  } finally {
    env.close();
  }
});

test("create: providerCapabilities rides through the session.started event", async () => {
  const env = startEnv();
  try {
    const providerCapabilities = {
      ...defaultProviderCapabilities(),
      structuredTurns: true,
      structuredApprovals: true,
      rawStdio: true,
    };
    await env.registry.create({
      name: "with-caps",
      tier: "hybrid",
      providerCapabilities,
    });
    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    assert.ok(evt);
    assert.deepEqual(evt.session.providerCapabilities, providerCapabilities);
  } finally {
    env.close();
  }
});

test("create: providerThread + providerCapabilities together both ride through", async () => {
  const env = startEnv();
  try {
    const providerThread = { providerId: "codex-app-server", transport: "stdio" };
    const providerCapabilities = defaultProviderCapabilities();
    await env.registry.create({
      name: "both",
      tier: "codex_app_server",
      providerThread,
      providerCapabilities,
    });
    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    assert.deepEqual(evt.session.providerThread, providerThread);
    assert.deepEqual(evt.session.providerCapabilities, providerCapabilities);
  } finally {
    env.close();
  }
});

// --- validation rejections (ProviderThreadRef) -----------------------------

test("create: rejects providerThread missing providerId", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerThread: { transport: "manual" },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_THREAD" &&
        /providerId/.test(err.message),
    );
    assert.equal(env.appendedEvents.length, 0);
  } finally {
    env.close();
  }
});

test("create: rejects providerThread missing transport", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerThread: { providerId: "codex" },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_THREAD" && /transport/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test("create: rejects providerThread with bad transport value", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerThread: { providerId: "codex", transport: "telepathy" },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_THREAD" && /transport/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test("create: rejects providerThread with unknown extra key", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerThread: {
          providerId: "codex",
          transport: "stdio",
          surpriseKey: "boom",
        },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_THREAD" && /surpriseKey/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test("create: rejects providerThread with non-string optional field", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerThread: {
          providerId: "codex",
          transport: "stdio",
          threadId: 42,
        },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_THREAD" && /threadId/.test(err.message),
    );
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerThread: {
          providerId: "codex",
          transport: "stdio",
          model: "",
        },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_THREAD" && /model/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test("create: rejects providerThread that is not an object", async () => {
  const env = startEnv();
  try {
    for (const bad of [null, "string", 42, []]) {
      await assert.rejects(
        env.registry.create({ name: "x", tier: "manual", providerThread: bad }),
        (err) => err.code === "INVALID_PROVIDER_THREAD",
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  } finally {
    env.close();
  }
});

// --- validation rejections (ProviderCapabilities) --------------------------

test("create: rejects providerCapabilities with unknown key", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerCapabilities: { ...defaultProviderCapabilities(), bogusFlag: true },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_CAPABILITIES" && /bogusFlag/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test("create: rejects providerCapabilities with non-boolean value", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({
        name: "x",
        tier: "manual",
        providerCapabilities: {
          ...defaultProviderCapabilities(),
          rawStdio: "yes",
        },
      }),
      (err) =>
        err.code === "INVALID_PROVIDER_CAPABILITIES" && /rawStdio/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test("create: rejects providerCapabilities that is not an object", async () => {
  const env = startEnv();
  try {
    for (const bad of [null, "string", 42, []]) {
      await assert.rejects(
        env.registry.create({
          name: "x",
          tier: "manual",
          providerCapabilities: bad,
        }),
        (err) => err.code === "INVALID_PROVIDER_CAPABILITIES",
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  } finally {
    env.close();
  }
});

// --- projection-absorption-deferred invariant ------------------------------

test("create: projection.sessions record does NOT carry providerThread / providerCapabilities", async () => {
  // This test pins the durable-truth boundary asserted by SH-2-21:
  //
  //   1. providerThread + providerCapabilities are runtime-only.
  //   2. They ride through the session.started event payload via the
  //      schema's additionalProperties: true (no schema change).
  //   3. Today's `handleSessionStarted` in hub/runtime/projection.js does
  //      NOT absorb either key. That absorption is deferred to SH-2-17 /
  //      SH-2-18 (provider adapters that emit `session.provider.*` events).
  //   4. The tracker JSON write path (hub/projects.js / legacy tracker
  //      layer) only writes data sourced from the projection — so a key
  //      that never reaches projection.sessions never reaches the tracker
  //      JSON either. This is the "never written into durable tracker
  //      JSON" evidence required by the task's DoD #2.
  //
  // When SH-2-17 / SH-2-18 land and start absorbing these fields onto the
  // projection record, this test should be updated alongside that change.
  const env = startEnv();
  try {
    const providerThread = fullyPopulatedProviderThread();
    const providerCapabilities = defaultProviderCapabilities();
    const created = await env.registry.create({
      name: "deferred-absorption",
      tier: "codex_app_server",
      providerThread,
      providerCapabilities,
    });

    // Event-side: both fields present (they rode through the event payload).
    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    assert.ok(evt.session.providerThread);
    assert.ok(evt.session.providerCapabilities);

    // Projection-side: neither field present (absorption is deferred).
    const stored = env.projection.sessions.get(created.sessionId);
    assert.ok(stored, "session record was created in the projection");
    assert.equal(
      stored.providerThread,
      undefined,
      "projection does not yet absorb providerThread (SH-2-17/18 follow-up)",
    );
    assert.equal(
      stored.providerCapabilities,
      undefined,
      "projection does not yet absorb providerCapabilities (SH-2-17/18 follow-up)",
    );
  } finally {
    env.close();
  }
});

// --- assertValidProviderThreadRef export ----------------------------------

test("assertValidProviderThreadRef: exported validator covers the same rules", () => {
  // Smoke test the exported helper for callers that want to validate a ref
  // outside the create() boundary.
  assertValidProviderThreadRef({ providerId: "x", transport: "stdio" });
  assertValidProviderThreadRef(fullyPopulatedProviderThread());

  assert.throws(
    () => assertValidProviderThreadRef(null),
    /must be an object/,
  );
  assert.throws(
    () => assertValidProviderThreadRef({ transport: "stdio" }),
    /providerId/,
  );
  assert.throws(
    () => assertValidProviderThreadRef({ providerId: "x" }),
    /transport/,
  );
  assert.throws(
    () => assertValidProviderThreadRef({ providerId: "x", transport: "moonbeam" }),
    /transport/,
  );
  assert.throws(
    () => assertValidProviderThreadRef({ providerId: "x", transport: "stdio", weird: "key" }),
    /weird/,
  );
});
