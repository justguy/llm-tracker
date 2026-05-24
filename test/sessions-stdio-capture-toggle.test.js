// test/sessions-stdio-capture-toggle.test.js — SH-2-23 (TDD v0.5 §19.3)
//
// Acceptance tests for POST /api/sessions/:sessionId/stdio/capture. Each test
// stands up a fresh Express app on a kernel-assigned port wired to a real
// RuntimeStore + RuntimeProjection + SessionTokenStore, then exercises the
// toggle endpoint end-to-end. Also covers the
// createSessionStdioCaptureChangedEvent factory directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { registerSessionsRoutes } from "../hub/api/sessions.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import {
  validateRuntimeEvent,
  createSessionStdioCaptureChangedEvent,
} from "../hub/runtime/events.js";
import { SessionTokenStore } from "../hub/sessions/auth/tokens.js";

const TEST_TIMEOUT = 8000;

async function startApp({ withTokenStore = true } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-stdio-toggle-"));
  const projection = new RuntimeProjection();
  const appended = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appended.push(event);
      projection.apply(event);
    },
  });
  const tokenStore = withTokenStore ? new SessionTokenStore() : undefined;
  const app = express();
  app.use(express.json());
  registerSessionsRoutes(app, {
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
    ...(tokenStore ? { tokenStore } : {}),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    workspaceRoot,
    projection,
    runtimeStore,
    tokenStore,
    appended,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function createSession(env, body = { name: "stdio-toggle-test", tier: "manual" }) {
  const res = await fetch(`${env.base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, "session creation should succeed");
  const { session } = await res.json();
  return session;
}

function postToggle(base, sessionId, body, headers = {}) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${base}/api/sessions/${sessionId}/stdio/capture`, init);
}

// --- happy paths -----------------------------------------------------------

test("toggle ON appends session.stdio_capture_changed event", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const issued = env.tokenStore.issue({ sessionId: session.id });

    const res = await postToggle(
      env.base,
      session.id,
      { captureToDisk: true, reason: "operator-enabled" },
      { "X-LT-Session-Token": issued.token },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.rev, "number");
    assert.match(body.eventId, /^evt_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.notEqual(body.noop, true, "first toggle is not a no-op");

    const evt = env.appended.find((e) => e.type === "session.stdio_capture_changed");
    assert.ok(evt, "session.stdio_capture_changed event was appended");
    assert.equal(evt.sessionId, session.id);
    assert.equal(evt.captureToDisk, true);
    assert.equal(evt.capture.enabled, true);
    assert.equal(evt.reason, "operator-enabled");
    assert.equal(evt.source, "http");
    assert.equal(evt.workspace, env.workspaceRoot);
  } finally {
    await env.close();
  }
});

test("concurrent same-state toggles serialize no-op detection", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const t1 = env.tokenStore.issue({ sessionId: session.id });
    const t2 = env.tokenStore.issue({ sessionId: session.id });

    const [a, b] = await Promise.all([
      postToggle(env.base, session.id, { captureToDisk: true }, { "X-LT-Session-Token": t1.token }),
      postToggle(env.base, session.id, { captureToDisk: true }, { "X-LT-Session-Token": t2.token }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const bodies = await Promise.all([a.json(), b.json()]);
    assert.equal(bodies.filter((body) => body.noop === true).length, 1);

    const events = env.appended.filter((e) => e.type === "session.stdio_capture_changed");
    assert.equal(events.length, 1, "only one ON event should be appended");
    assert.equal(events[0].capture.enabled, true);
    assert.equal(events[0].captureToDisk, true);
  } finally {
    await env.close();
  }
});

test("toggle OFF (after ON) appends a second event", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);

    // Turn ON first.
    const t1 = env.tokenStore.issue({ sessionId: session.id });
    const onRes = await postToggle(env.base, session.id, { captureToDisk: true }, { "X-LT-Session-Token": t1.token });
    assert.equal(onRes.status, 200);

    // Now turn OFF.
    const t2 = env.tokenStore.issue({ sessionId: session.id });
    const offRes = await postToggle(
      env.base,
      session.id,
      { captureToDisk: false, reason: "done-debugging" },
      { "X-LT-Session-Token": t2.token },
    );
    assert.equal(offRes.status, 200);
    const offBody = await offRes.json();
    assert.notEqual(offBody.noop, true);

    const events = env.appended.filter((e) => e.type === "session.stdio_capture_changed");
    assert.equal(events.length, 2);
    assert.equal(events[0].capture.enabled, true);
    assert.equal(events[1].capture.enabled, false);
    assert.equal(events[1].reason, "done-debugging");
  } finally {
    await env.close();
  }
});

test("no-op (same state) returns 200 without appending an event", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);

    // Default is OFF — request OFF and expect noop.
    const issued = env.tokenStore.issue({ sessionId: session.id });
    const res = await postToggle(env.base, session.id, { captureToDisk: false }, { "X-LT-Session-Token": issued.token });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.noop, true);
    assert.equal(typeof body.rev, "number");
    assert.equal(body.eventId, undefined, "no-op must not include eventId");

    const evt = env.appended.find((e) => e.type === "session.stdio_capture_changed");
    assert.equal(evt, undefined, "no event appended on no-op");
  } finally {
    await env.close();
  }
});

test("no-op after ON (re-request ON) returns 200 without a second event", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);

    // First call: ON (state-changing).
    const t1 = env.tokenStore.issue({ sessionId: session.id });
    const first = await postToggle(env.base, session.id, { captureToDisk: true }, { "X-LT-Session-Token": t1.token });
    assert.equal(first.status, 200);

    // Second call: ON again (no-op).
    const t2 = env.tokenStore.issue({ sessionId: session.id });
    const second = await postToggle(env.base, session.id, { captureToDisk: true }, { "X-LT-Session-Token": t2.token });
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.noop, true);

    const events = env.appended.filter((e) => e.type === "session.stdio_capture_changed");
    assert.equal(events.length, 1, "only the first ON appended an event");
  } finally {
    await env.close();
  }
});

// --- token gating ----------------------------------------------------------

test("toggle 401 when no X-LT-Session-Token header is supplied (turn ON)", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const res = await postToggle(env.base, session.id, { captureToDisk: true });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "SESSION_TOKEN_REJECTED");
  } finally {
    await env.close();
  }
});

test("toggle 401 when no token is supplied (turn OFF — also gated)", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);

    // Bootstrap to capture-ON via a token so we can test the OFF-without-token path.
    const t1 = env.tokenStore.issue({ sessionId: session.id });
    await postToggle(env.base, session.id, { captureToDisk: true }, { "X-LT-Session-Token": t1.token });

    const res = await postToggle(env.base, session.id, { captureToDisk: false });
    assert.equal(res.status, 401, "turning OFF without a token must also be 401");
  } finally {
    await env.close();
  }
});

// --- 400/404 paths ---------------------------------------------------------

test("toggle 400 when captureToDisk is missing", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const issued = env.tokenStore.issue({ sessionId: session.id });
    const res = await postToggle(env.base, session.id, {}, { "X-LT-Session-Token": issued.token });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /captureToDisk/);
  } finally {
    await env.close();
  }
});

test("toggle 400 when captureToDisk is non-boolean", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);

    for (const bad of ["true", 1, 0, null, []]) {
      const issued = env.tokenStore.issue({ sessionId: session.id });
      const res = await postToggle(
        env.base,
        session.id,
        { captureToDisk: bad },
        { "X-LT-Session-Token": issued.token },
      );
      assert.equal(res.status, 400, `captureToDisk=${JSON.stringify(bad)} should be 400`);
      const body = await res.json();
      assert.equal(body.error.code, "INVALID_BODY");
    }
  } finally {
    await env.close();
  }
});

test("toggle 400 on unknown body field", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const issued = env.tokenStore.issue({ sessionId: session.id });
    const res = await postToggle(
      env.base,
      session.id,
      { captureToDisk: true, weird: 1 },
      { "X-LT-Session-Token": issued.token },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_FIELDS");
    assert.deepEqual(body.error.details.unknown, ["weird"]);
  } finally {
    await env.close();
  }
});

test("toggle 400 when reason is empty string", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const issued = env.tokenStore.issue({ sessionId: session.id });
    const res = await postToggle(
      env.base,
      session.id,
      { captureToDisk: true, reason: "" },
      { "X-LT-Session-Token": issued.token },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /reason/);
  } finally {
    await env.close();
  }
});

test("toggle 404 when sessionId does not exist in projection", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const phantom = makeRuntimeId("ses");
    // Issue a token for the phantom so the middleware accepts the request and
    // we exercise the handler's projection lookup.
    const issued = env.tokenStore.issue({ sessionId: phantom });
    const res = await postToggle(
      env.base,
      phantom,
      { captureToDisk: true },
      { "X-LT-Session-Token": issued.token },
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_SESSION");

    const evt = env.appended.find((e) => e.type === "session.stdio_capture_changed");
    assert.equal(evt, undefined, "no event appended for phantom session");
  } finally {
    await env.close();
  }
});

test("toggle 400 on malformed :sessionId", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const issued = env.tokenStore.issue({ sessionId: "foo" });
    const res = await postToggle(
      env.base,
      "foo",
      { captureToDisk: true },
      { "X-LT-Session-Token": issued.token },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_SESSION_ID");
  } finally {
    await env.close();
  }
});

// --- mounting --------------------------------------------------------------

test("stdio capture route is NOT mounted when tokenStore dep is omitted", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp({ withTokenStore: false });
  try {
    const phantom = makeRuntimeId("ses");
    const res = await postToggle(env.base, phantom, { captureToDisk: true });
    // Express returns 404 for unmatched routes by default.
    assert.equal(res.status, 404);
  } finally {
    await env.close();
  }
});

// --- factory unit tests ----------------------------------------------------

test("factory: produces a schema-valid event with capture.enabled set", () => {
  const evt = createSessionStdioCaptureChangedEvent({
    sessionId: makeRuntimeId("ses"),
    captureToDisk: true,
    workspace: "/tmp/ws",
  });
  assert.equal(evt.type, "session.stdio_capture_changed");
  assert.equal(evt.captureToDisk, true);
  assert.equal(evt.capture.enabled, true);
  assert.equal(evt.id, undefined, "id is left for RuntimeStore to stamp at append time");
  assert.equal(evt.schemaVersion, 1);
  // Validating with a placeholder id should pass — the factory itself ran the
  // same validation as a defence-in-depth check; this is an explicit re-check.
  assert.equal(validateRuntimeEvent({ ...evt, id: makeRuntimeId("evt") }), true);
});

test("factory: rejects non-boolean captureToDisk", () => {
  assert.throws(
    () => createSessionStdioCaptureChangedEvent({
      sessionId: makeRuntimeId("ses"),
      captureToDisk: "true",
      workspace: "/tmp/ws",
    }),
    /captureToDisk required \(boolean\)/,
  );
});

test("factory: rejects missing sessionId", () => {
  assert.throws(
    () => createSessionStdioCaptureChangedEvent({
      captureToDisk: false,
      workspace: "/tmp/ws",
    }),
    /sessionId required/,
  );
});

test("factory: rejects empty-string reason", () => {
  assert.throws(
    () => createSessionStdioCaptureChangedEvent({
      sessionId: makeRuntimeId("ses"),
      captureToDisk: true,
      workspace: "/tmp/ws",
      reason: "",
    }),
    /reason must be a non-empty string/,
  );
});

test("factory: omits reason from payload when not supplied", () => {
  const evt = createSessionStdioCaptureChangedEvent({
    sessionId: makeRuntimeId("ses"),
    captureToDisk: false,
    workspace: "/tmp/ws",
  });
  assert.equal(evt.reason, undefined);
});
