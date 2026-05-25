// test/sessions-token-rotation.test.js — SH-2-07 (TDD v0.5 §19.2)
//
// Acceptance test for POST /api/sessions/:sessionId/token/rotate. Each test
// stands up a fresh Express app on a kernel-assigned port wired to a real
// RuntimeStore + RuntimeProjection + SessionTokenStore, then exercises the
// rotation endpoint end-to-end.

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
import { validateRuntimeEvent } from "../hub/runtime/events.js";
import {
  SessionTokenStore,
  hashToken,
  TOKEN_REJECT_REASONS,
} from "../hub/sessions/auth/tokens.js";

const TEST_TIMEOUT = 8000;

async function startApp() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-session-rotate-"));
  const projection = new RuntimeProjection();
  const appended = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appended.push(event);
      projection.apply(event);
    },
  });
  const tokenStore = new SessionTokenStore();
  const app = express();
  app.use(express.json());
  registerSessionsRoutes(app, {
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
    tokenStore,
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

async function createSession(env, body = { name: "rotate-test", tier: "manual" }) {
  const res = await fetch(`${env.base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, "session creation should succeed");
  const { session } = await res.json();
  return session;
}

async function createSessionResponse(env, body = { name: "rotate-test", tier: "manual" }) {
  const res = await fetch(`${env.base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, "session creation should succeed");
  return res.json();
}

function postRotate(base, sessionId, body, headers = {}) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${base}/api/sessions/${sessionId}/token/rotate`, init);
}

function patchSession(base, sessionId, body, headers = {}) {
  return fetch(`${base}/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("create returns initial token that can authenticate session mutation", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const body = await createSessionResponse(env);
    assert.equal(body.token.sessionId, body.session.id);
    assert.equal(body.token.tokenHash, hashToken(body.token.token));
    assert.equal(env.tokenStore.validate(body.token.token, { expectedSessionId: body.session.id }).ok, true);

    const patch = await patchSession(
      env.base,
      body.session.id,
      { status: "quiet" },
      { "X-LT-Session-Token": body.token.token },
    );
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).session.status, "quiet");
  } finally {
    await env.close();
  }
});

test("PATCH /api/sessions/:id requires token when tokenStore is wired", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const res = await patchSession(env.base, session.id, { status: "quiet" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "SESSION_TOKEN_REJECTED");
    assert.equal(body.error.details.reason, "missing");
  } finally {
    await env.close();
  }
});

test("rotate 401 when no X-LT-Session-Token header is supplied", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const res = await postRotate(env.base, session.id, {});
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "SESSION_TOKEN_REJECTED");
    assert.equal(body.error.details.reason, "missing");
  } finally {
    await env.close();
  }
});

test("rotate 401 when token is garbage / unknown", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const res = await postRotate(env.base, session.id, {}, { "X-LT-Session-Token": "not-a-real-token" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.details.reason, "unknown");
  } finally {
    await env.close();
  }
});

test("rotate 200 happy path: returns fresh token; old token now fails validation", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const old = env.tokenStore.issue({ sessionId: session.id, capabilities: ["status"] });

    const res = await postRotate(env.base, session.id, {}, { "X-LT-Session-Token": old.token });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(typeof body.token, "string", "cleartext token returned");
    assert.ok(body.token.length >= 32, "cleartext is non-trivial length");
    assert.notEqual(body.token, old.token, "new token is not the old token");
    assert.equal(body.tokenHash, hashToken(body.token), "hash matches cleartext");
    assert.equal(body.sessionId, session.id);
    assert.ok(typeof body.expiresAt === "string" && body.expiresAt.length > 0);
    assert.ok(typeof body.issuedAt === "string" && body.issuedAt.length > 0);
    assert.equal(typeof body.rev, "number");
    assert.match(body.eventId, /^evt_[0-9a-hjkmnp-tv-z]{26}$/);

    // Old token must be invalid post-rotation.
    const oldCheck = env.tokenStore.validate(old.token);
    assert.equal(oldCheck.ok, false);
    assert.equal(oldCheck.reason, TOKEN_REJECT_REASONS.UNKNOWN, "revoked tokens read as unknown after delete");

    // New token must validate.
    const newCheck = env.tokenStore.validate(body.token);
    assert.equal(newCheck.ok, true);
    assert.equal(newCheck.record.sessionId, session.id);
  } finally {
    await env.close();
  }
});

test("rotate append failure rolls back the fresh token and leaves old token valid", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const old = env.tokenStore.issue({ sessionId: session.id, capabilities: ["status"] });
    const beforeCount = env.tokenStore.list().length;
    const originalAppend = env.runtimeStore.append.bind(env.runtimeStore);
    env.runtimeStore.append = async (event) => {
      if (event?.type === "session.token_rotated") {
        throw new Error("simulated append failure");
      }
      return originalAppend(event);
    };

    const res = await postRotate(env.base, session.id, {}, { "X-LT-Session-Token": old.token });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "APPEND_FAILED");
    assert.equal(env.tokenStore.validate(old.token, { expectedSessionId: session.id }).ok, true);
    assert.equal(env.tokenStore.list().length, beforeCount, "fresh token was rolled back");
  } finally {
    await env.close();
  }
});

test("rotate appends session.token_rotated event with tokenHash; cleartext never appears anywhere", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const old = env.tokenStore.issue({ sessionId: session.id, capabilities: ["status"] });

    const res = await postRotate(env.base, session.id, {}, { "X-LT-Session-Token": old.token });
    assert.equal(res.status, 200);
    const body = await res.json();

    const rotated = env.appended.find((e) => e.type === "session.token_rotated");
    assert.ok(rotated, "session.token_rotated event was appended");
    assert.equal(rotated.sessionId, session.id);
    assert.equal(rotated.tokenHash, hashToken(body.token), "event tokenHash matches new token");
    assert.equal(rotated.source, "http");
    assert.equal(rotated.workspace, env.workspaceRoot);

    // Cleartext must NEVER appear in the appended event under ANY key.
    const serialized = JSON.stringify(rotated);
    assert.equal(serialized.includes(body.token), false, "cleartext token must not appear in event JSON");
  } finally {
    await env.close();
  }
});

test("rotate 404 when sessionId does not exist", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    // Issue a token for a session that exists in token store but not in
    // projection — middleware will accept the token (it's valid for that
    // sessionId), then the handler's projection lookup will 404.
    const phantom = makeRuntimeId("ses");
    const issued = env.tokenStore.issue({ sessionId: phantom });
    const res = await postRotate(env.base, phantom, {}, { "X-LT-Session-Token": issued.token });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_SESSION");

    // No session.token_rotated event for a phantom session.
    const rotated = env.appended.find((e) => e.type === "session.token_rotated");
    assert.equal(rotated, undefined, "rotation event must not be appended for phantom session");
  } finally {
    await env.close();
  }
});

test("rotate 400 on malformed :sessionId", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    // The middleware needs a token whose sessionId matches the URL param —
    // issue one for the malformed id so we hit the handler's shape check.
    const issued = env.tokenStore.issue({ sessionId: "foo" });
    const res = await postRotate(env.base, "foo", {}, { "X-LT-Session-Token": issued.token });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_SESSION_ID");
  } finally {
    await env.close();
  }
});

test("rotate 400 on unknown body field", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const old = env.tokenStore.issue({ sessionId: session.id });
    const res = await postRotate(env.base, session.id, { weird: 1 }, { "X-LT-Session-Token": old.token });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_FIELDS");
    assert.deepEqual(body.error.details.unknown, ["weird"]);
  } finally {
    await env.close();
  }
});

test("rotate 400 on invalid lifetimeMinutes (0, negative, non-integer)", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);

    for (const bad of [0, -5, 1.5, "100", null]) {
      const issued = env.tokenStore.issue({ sessionId: session.id });
      const res = await postRotate(
        env.base,
        session.id,
        { lifetimeMinutes: bad },
        { "X-LT-Session-Token": issued.token },
      );
      assert.equal(res.status, 400, `lifetimeMinutes=${bad} should be 400`);
      const body = await res.json();
      assert.equal(body.error.code, "INVALID_BODY");
      assert.match(body.error.message, /lifetimeMinutes/);
    }
  } finally {
    await env.close();
  }
});

test("rotate inherits capabilities from the presented token when body omits them", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const old = env.tokenStore.issue({
      sessionId: session.id,
      capabilities: ["status", "checkpoint", "rotate"],
    });

    const res = await postRotate(env.base, session.id, {}, { "X-LT-Session-Token": old.token });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([...body.capabilities], ["status", "checkpoint", "rotate"]);
  } finally {
    await env.close();
  }
});

test("rotate uses body-supplied capabilities when present (explicit narrowing)", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const old = env.tokenStore.issue({
      sessionId: session.id,
      capabilities: ["status", "checkpoint", "rotate"],
    });

    const res = await postRotate(
      env.base,
      session.id,
      { capabilities: ["status"] },
      { "X-LT-Session-Token": old.token },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([...body.capabilities], ["status"]);
  } finally {
    await env.close();
  }
});

test("rotate honors body-supplied lifetimeMinutes (positive integer)", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);
    const old = env.tokenStore.issue({ sessionId: session.id });

    const before = Date.now();
    const res = await postRotate(
      env.base,
      session.id,
      { lifetimeMinutes: 30 },
      { "X-LT-Session-Token": old.token },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const expires = Date.parse(body.expiresAt);
    // Expect ~30 minutes from now (±2s).
    assert.ok(Math.abs(expires - before - 30 * 60_000) < 2000, "expiresAt is ~30 minutes from now");
  } finally {
    await env.close();
  }
});

test("rotate 400 on capabilities not being a non-empty string[]", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startApp();
  try {
    const session = await createSession(env);

    for (const bad of [42, [42], [""], "status"]) {
      const issued = env.tokenStore.issue({ sessionId: session.id });
      const res = await postRotate(
        env.base,
        session.id,
        { capabilities: bad },
        { "X-LT-Session-Token": issued.token },
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, "INVALID_BODY");
      assert.match(body.error.message, /capabilities/);
    }
  } finally {
    await env.close();
  }
});

test("rotation route is NOT mounted when tokenStore dep is omitted", { timeout: TEST_TIMEOUT }, async () => {
  // Stand up an app without tokenStore — rotation route must 404 (no handler).
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-session-rotate-no-ts-"));
  const projection = new RuntimeProjection();
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => projection.apply(event),
  });
  const app = express();
  app.use(express.json());
  registerSessionsRoutes(app, {
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
    // tokenStore intentionally omitted
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  try {
    const phantom = makeRuntimeId("ses");
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${phantom}/token/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // Express returns 404 for unmatched routes by default.
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
