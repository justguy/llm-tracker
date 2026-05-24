// test/providers-api.test.js — SH-2-20 (addendum §16.1)
//
// Acceptance tests for the /api/providers HTTP routes. Each test stands up
// a fresh Express app on a kernel-assigned port (127.0.0.1, listen(0)) with
// an in-memory ProviderRegistry + ProviderBroker.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { ProviderRegistry } from "../hub/providers/registry.js";
import { ProviderBroker } from "../hub/providers/broker.js";
import { registerProvidersRoutes } from "../hub/api/providers.js";

const TEST_TIMEOUT = 8000;

// -- in-memory provider fixtures -------------------------------------------

function fullProvider(overrides = {}) {
  return {
    id: "full",
    label: "Full Provider",
    probe: async () => ({ ok: true, details: { version: "1.0" } }),
    capabilities: () => ({ rawStdio: true, stdinWrite: true, processLifecycle: true }),
    listModels: async () => [{ id: "m1", label: "Model 1" }, { id: "m2", label: "Model 2" }],
    listSkills: async (req) => [{ id: "s1", cwd: req?.cwd ?? null }],
    start: async () => ({ threadId: "t1" }),
    streamEvents: async function* () { yield { kind: "thread.started" }; },
    ...overrides,
  };
}

function minimalProvider(overrides = {}) {
  return {
    id: "minimal",
    label: "Minimal Provider",
    probe: async () => ({ ok: true }),
    capabilities: () => ({ rawStdio: false }),
    start: async () => ({ threadId: "t-min" }),
    streamEvents: async function* () { yield { kind: "thread.started" }; },
    ...overrides,
  };
}

async function startMiniApp(providerInstances = []) {
  const registry = new ProviderRegistry();
  for (const p of providerInstances) registry.register(p);
  const broker = new ProviderBroker({ registry });
  const app = express();
  app.use(express.json());
  registerProvidersRoutes(app, { broker });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    broker,
    registry,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// -- registerProvidersRoutes wiring guards ---------------------------------

test("registerProvidersRoutes: requires express app", () => {
  assert.throws(() => registerProvidersRoutes(null, { broker: {} }), /express app required/);
  assert.throws(() => registerProvidersRoutes({}, { broker: {} }), /express app required/);
});

test("registerProvidersRoutes: requires a broker with the expected surface", () => {
  const app = express();
  assert.throws(() => registerProvidersRoutes(app, {}), /broker/);
  assert.throws(() => registerProvidersRoutes(app, { broker: {} }), /broker/);
  // missing registry:
  assert.throws(
    () => registerProvidersRoutes(app, {
      broker: {
        capabilities: () => ({}),
        probe: async () => ({ ok: true }),
        listModels: async () => [],
        listSkills: async () => [],
      },
    }),
    /broker/,
  );
});

// -- happy paths ------------------------------------------------------------

test("GET /api/providers returns id+label for every registered provider", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([fullProvider(), minimalProvider()]);
  try {
    const res = await fetch(`${env.base}/api/providers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      providers: [
        { id: "full", label: "Full Provider" },
        { id: "minimal", label: "Minimal Provider" },
      ],
    });
  } finally {
    await env.close();
  }
});

test("GET /api/providers/:id/capabilities returns the provider's capability vector", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([fullProvider()]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/capabilities`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      providerId: "full",
      capabilities: { rawStdio: true, stdinWrite: true, processLifecycle: true },
    });
  } finally {
    await env.close();
  }
});

test("GET /api/providers/:id/models returns ModelOption[]", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([fullProvider()]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      providerId: "full",
      models: [{ id: "m1", label: "Model 1" }, { id: "m2", label: "Model 2" }],
    });
  } finally {
    await env.close();
  }
});

test("GET /api/providers/:id/skills returns ProviderSkill[] and forwards cwd unchanged", { timeout: TEST_TIMEOUT }, async () => {
  let observed;
  const provider = fullProvider({
    listSkills: async (req) => {
      observed = req;
      return [{ id: "s1", from: req?.cwd ?? null }];
    },
  });
  const env = await startMiniApp([provider]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/skills?cwd=/tmp/work`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      providerId: "full",
      skills: [{ id: "s1", from: "/tmp/work" }],
    });
    assert.deepEqual(observed, { cwd: "/tmp/work" });
  } finally {
    await env.close();
  }
});

test("GET /api/providers/:id/skills without cwd passes an empty request to the provider", { timeout: TEST_TIMEOUT }, async () => {
  let observed;
  const provider = fullProvider({
    listSkills: async (req) => {
      observed = req;
      return [];
    },
  });
  const env = await startMiniApp([provider]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/skills`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { providerId: "full", skills: [] });
    assert.deepEqual(observed, {});
  } finally {
    await env.close();
  }
});

test("POST /api/providers/:id/probe returns {providerId, ok:true} for a healthy provider", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([fullProvider()]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/probe`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.providerId, "full");
    assert.equal(body.ok, true);
    assert.deepEqual(body.details, { version: "1.0" });
  } finally {
    await env.close();
  }
});

test("POST /api/providers/:id/probe surfaces probe failure as HTTP 200 with ok:false + reason", { timeout: TEST_TIMEOUT }, async () => {
  const provider = fullProvider({
    probe: async () => ({ ok: false, reason: "binary not on PATH" }),
  });
  const env = await startMiniApp([provider]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/probe`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      providerId: "full",
      ok: false,
      reason: "binary not on PATH",
    });
  } finally {
    await env.close();
  }
});

// -- error mappings ---------------------------------------------------------

test("Unknown providerId → 404 PROVIDER_NOT_FOUND on every endpoint", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([fullProvider()]);
  try {
    const paths = [
      ["GET", "/api/providers/ghost/capabilities"],
      ["GET", "/api/providers/ghost/models"],
      ["GET", "/api/providers/ghost/skills"],
      ["POST", "/api/providers/ghost/probe"],
    ];
    for (const [method, path] of paths) {
      const res = await fetch(`${env.base}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path} should 404`);
      const body = await res.json();
      assert.equal(body.error.code, "PROVIDER_NOT_FOUND");
      assert.equal(body.error.details.providerId, "ghost");
    }
  } finally {
    await env.close();
  }
});

test("Minimal provider → 501 PROVIDER_OPERATION_NOT_SUPPORTED for listModels and listSkills", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([minimalProvider()]);
  try {
    for (const path of ["/api/providers/minimal/models", "/api/providers/minimal/skills"]) {
      const res = await fetch(`${env.base}${path}`);
      assert.equal(res.status, 501, `${path} should 501`);
      const body = await res.json();
      assert.equal(body.error.code, "PROVIDER_OPERATION_NOT_SUPPORTED");
    }
  } finally {
    await env.close();
  }
});

test("Malformed providerId → 400 INVALID_PROVIDER_ID (route-level check)", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([fullProvider()]);
  try {
    // Note: empty path-segment ("") would hit a different route, so we can't
    // exercise the empty-string case here — the regex rejects everything else
    // that doesn't start with [a-z], which covers leading digits + upper-case.
    const badIds = ["Foo", "123abc", "-leading", "has.dot", "has space"];
    for (const id of badIds) {
      const path = `/api/providers/${encodeURIComponent(id)}/capabilities`;
      const res = await fetch(`${env.base}${path}`);
      assert.equal(res.status, 400, `${path} should 400`);
      const body = await res.json();
      assert.equal(body.error.code, "INVALID_PROVIDER_ID");
    }
  } finally {
    await env.close();
  }
});

test("GET /skills?cwd= empty string → 400 INVALID_QUERY", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp([fullProvider()]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/skills?cwd=`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_QUERY");
  } finally {
    await env.close();
  }
});

test("Unexpected broker error → 500 INTERNAL_ERROR", { timeout: TEST_TIMEOUT }, async () => {
  const provider = fullProvider({
    listModels: async () => { throw new Error("disk on fire"); },
  });
  const env = await startMiniApp([provider]);
  try {
    const res = await fetch(`${env.base}/api/providers/full/models`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.match(body.error.message, /disk on fire/);
  } finally {
    await env.close();
  }
});
