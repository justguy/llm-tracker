// test/sessions-auth-tokens.test.js — SH-2-06 (TDD v0.5 §19.2)
//
// SessionTokenStore + requireSessionToken middleware acceptance tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SessionTokenStore,
  DEFAULT_MAX_LIFETIME_MINUTES,
  TOKEN_REJECT_REASONS,
  hashToken,
} from "../hub/sessions/auth/tokens.js";
import { requireSessionToken } from "../hub/api/middleware/session-token.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

// -- token store ------------------------------------------------------------

test("SessionTokenStore.issue: returns cleartext + metadata; stores only hash", () => {
  const store = new SessionTokenStore();
  const res = store.issue({ sessionId: "ses_x", capabilities: ["status", "checkpoint"] });
  assert.equal(typeof res.token, "string");
  assert.ok(res.token.length >= 32, "cleartext is non-trivial length");
  assert.match(res.token, /^[A-Za-z0-9_-]+$/, "cleartext is base64url");
  assert.equal(res.tokenHash, hashToken(res.token));
  assert.equal(res.sessionId, "ses_x");
  assert.deepEqual([...res.capabilities], ["status", "checkpoint"]);

  // list() exposes hash + record metadata, not the cleartext.
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenHash, res.tokenHash);
  assert.equal(listed[0].sessionId, "ses_x");
  assert.equal(listed[0].token, undefined, "list() must never expose cleartext");
});

test("SessionTokenStore.issue: default lifetime is 1440 minutes (24h)", () => {
  const base = new Date("2026-05-24T12:00:00Z");
  const store = new SessionTokenStore({ now: () => base });
  const res = store.issue({ sessionId: "ses_x" });
  const expected = new Date(base.getTime() + DEFAULT_MAX_LIFETIME_MINUTES * 60_000).toISOString();
  assert.equal(res.expiresAt, expected);
});

test("SessionTokenStore.validate: ok / missing / unknown / session_mismatch", () => {
  const store = new SessionTokenStore();
  const issued = store.issue({ sessionId: "ses_a" });

  assert.deepEqual(store.validate(issued.token).ok, true);

  const missing = store.validate("");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, TOKEN_REJECT_REASONS.MISSING);

  const unknown = store.validate("not-a-real-token");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, TOKEN_REJECT_REASONS.UNKNOWN);

  const mismatch = store.validate(issued.token, { expectedSessionId: "ses_other" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, TOKEN_REJECT_REASONS.SESSION_MISMATCH);
});

test("SessionTokenStore.validate: expired tokens reject and purge from store", () => {
  let nowDate = new Date("2026-05-24T12:00:00Z");
  const store = new SessionTokenStore({ now: () => nowDate });
  const issued = store.issue({ sessionId: "ses_x", lifetimeMinutes: 10 });
  // Advance past expiry.
  nowDate = new Date("2026-05-24T12:10:01Z");
  const r = store.validate(issued.token);
  assert.equal(r.ok, false);
  assert.equal(r.reason, TOKEN_REJECT_REASONS.EXPIRED);
  // Second call still rejects but now as UNKNOWN — the expired entry was purged.
  const r2 = store.validate(issued.token);
  assert.equal(r2.reason, TOKEN_REJECT_REASONS.UNKNOWN);
  assert.equal(store.list().length, 0);
});

test("SessionTokenStore.revoke: invalidates every outstanding token for the session", () => {
  const store = new SessionTokenStore();
  const a1 = store.issue({ sessionId: "ses_a" });
  const a2 = store.issue({ sessionId: "ses_a" });
  const b1 = store.issue({ sessionId: "ses_b" });
  assert.equal(store.revoke("ses_a"), 2);
  assert.equal(store.validate(a1.token).reason, TOKEN_REJECT_REASONS.UNKNOWN);
  assert.equal(store.validate(a2.token).reason, TOKEN_REJECT_REASONS.UNKNOWN);
  assert.equal(store.validate(b1.token).ok, true);
});

test("SessionTokenStore.purgeExpired: bulk cleanup", () => {
  let nowDate = new Date("2026-05-24T12:00:00Z");
  const store = new SessionTokenStore({ now: () => nowDate });
  store.issue({ sessionId: "ses_a", lifetimeMinutes: 1 });
  store.issue({ sessionId: "ses_b", lifetimeMinutes: 1 });
  store.issue({ sessionId: "ses_c", lifetimeMinutes: 60 });
  nowDate = new Date("2026-05-24T12:02:00Z");
  assert.equal(store.purgeExpired(), 2);
  assert.equal(store.list().length, 1);
});

test("SessionTokenStore.issue: rejects bad input", () => {
  const store = new SessionTokenStore();
  assert.throws(() => store.issue({}), /sessionId required/);
  assert.throws(() => store.issue({ sessionId: "ses_x", capabilities: [42] }), /string\[\]/);
  assert.throws(() => store.issue({ sessionId: "ses_x", lifetimeMinutes: 0 }), /positive integer/);
});

test("SessionTokenStore constructor: rejects invalid defaultLifetimeMinutes", () => {
  assert.throws(() => new SessionTokenStore({ defaultLifetimeMinutes: 0 }), /positive integer/);
  assert.throws(() => new SessionTokenStore({ defaultLifetimeMinutes: 1.5 }), /positive integer/);
});

// -- middleware -------------------------------------------------------------

async function startMiddlewareApp({ runtimeStore, tokenStore, workspace }) {
  const app = express();
  app.use(express.json());
  app.post(
    "/api/sessions/:sessionId/mutate",
    requireSessionToken({
      tokenStore,
      runtimeStore,
      makeRuntimeId,
      validateRuntimeEvent,
      workspace,
    }),
    (req, res) => {
      res.status(200).json({ ok: true, sessionToken: req.sessionToken });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function buildEnv() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-token-mw-"));
  const projection = new RuntimeProjection();
  const appended = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (e) => {
      appended.push(e);
      projection.apply(e);
    },
  });
  const tokenStore = new SessionTokenStore();
  const app = await startMiddlewareApp({ runtimeStore, tokenStore, workspace: workspaceRoot });
  return {
    workspaceRoot,
    runtimeStore,
    tokenStore,
    appended,
    base: app.base,
    cleanup: async () => {
      await app.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

test("middleware: missing token → 401; emits token_audit reject=missing", async () => {
  const env = await buildEnv();
  try {
    const res = await fetch(`${env.base}/api/sessions/ses_x/mutate`, { method: "POST" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "SESSION_TOKEN_REJECTED");
    assert.equal(body.error.details.reason, "missing");

    const audit = env.appended.find((e) => e.type === "session.token_audit");
    assert.ok(audit, "audit event appended");
    assert.equal(audit.outcome, "rejected");
    assert.equal(audit.reason, "missing");
    assert.equal(audit.sessionId, "ses_x");
    assert.equal(audit.path, "/api/sessions/ses_x/mutate");
    assert.equal(audit.method, "POST");
  } finally {
    await env.cleanup();
  }
});

test("middleware: unknown token → 401; emits token_audit reject=unknown", async () => {
  const env = await buildEnv();
  try {
    const res = await fetch(`${env.base}/api/sessions/ses_x/mutate`, {
      method: "POST",
      headers: { "X-LT-Session-Token": "garbage" },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.details.reason, "unknown");
    const audit = env.appended.find((e) => e.type === "session.token_audit");
    assert.equal(audit.reason, "unknown");
  } finally {
    await env.cleanup();
  }
});

test("middleware: session_mismatch when token belongs to another session", async () => {
  const env = await buildEnv();
  try {
    const issued = env.tokenStore.issue({ sessionId: "ses_a", capabilities: ["status"] });
    const res = await fetch(`${env.base}/api/sessions/ses_b/mutate`, {
      method: "POST",
      headers: { "X-LT-Session-Token": issued.token },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.details.reason, "session_mismatch");
    const audit = env.appended.find((e) => e.type === "session.token_audit");
    assert.equal(audit.reason, "session_mismatch");
    assert.equal(audit.sessionId, "ses_b"); // audit logs requested session, not issued
  } finally {
    await env.cleanup();
  }
});

test("middleware: valid token attaches req.sessionToken and forwards to handler", async () => {
  const env = await buildEnv();
  try {
    const issued = env.tokenStore.issue({ sessionId: "ses_a", capabilities: ["status", "checkpoint"] });
    const res = await fetch(`${env.base}/api/sessions/ses_a/mutate`, {
      method: "POST",
      headers: { "X-LT-Session-Token": issued.token },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.sessionToken.sessionId, "ses_a");
    assert.deepEqual(body.sessionToken.capabilities, ["status", "checkpoint"]);
    // No audit event on accept.
    assert.equal(env.appended.filter((e) => e.type === "session.token_audit").length, 0);
  } finally {
    await env.cleanup();
  }
});

test("middleware: header name is case-insensitive", async () => {
  const env = await buildEnv();
  try {
    const issued = env.tokenStore.issue({ sessionId: "ses_a" });
    const res = await fetch(`${env.base}/api/sessions/ses_a/mutate`, {
      method: "POST",
      headers: { "x-lt-SESSION-TOKEN": issued.token },
    });
    assert.equal(res.status, 200);
  } finally {
    await env.cleanup();
  }
});

test("middleware: rejects expired tokens", async () => {
  let nowDate = new Date("2026-05-24T12:00:00Z");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-token-mw-exp-"));
  const projection = new RuntimeProjection();
  const appended = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (e) => {
      appended.push(e);
      projection.apply(e);
    },
  });
  const tokenStore = new SessionTokenStore({ now: () => nowDate });
  const app = await startMiddlewareApp({ runtimeStore, tokenStore, workspace: workspaceRoot });
  try {
    const issued = tokenStore.issue({ sessionId: "ses_a", lifetimeMinutes: 5 });
    nowDate = new Date("2026-05-24T12:05:01Z");
    const res = await fetch(`${app.base}/api/sessions/ses_a/mutate`, {
      method: "POST",
      headers: { "X-LT-Session-Token": issued.token },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.details.reason, "expired");
    const audit = appended.find((e) => e.type === "session.token_audit");
    assert.equal(audit.reason, "expired");
  } finally {
    await app.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("requireSessionToken: rejects misconfigurations at factory time", () => {
  assert.throws(() => requireSessionToken(), /tokenStore/);
  assert.throws(() => requireSessionToken({}), /tokenStore/);
  assert.throws(
    () =>
      requireSessionToken({
        tokenStore: new SessionTokenStore(),
        runtimeStore: { append: 42 },
      }),
    /runtimeStore.append must be a function/,
  );
  assert.throws(
    () =>
      requireSessionToken({
        tokenStore: new SessionTokenStore(),
        runtimeStore: { append: async () => {} },
      }),
    /makeRuntimeId required/,
  );
  assert.throws(
    () =>
      requireSessionToken({
        tokenStore: new SessionTokenStore(),
        runtimeStore: { append: async () => {} },
        makeRuntimeId: () => "evt_x",
      }),
    /validateRuntimeEvent required/,
  );
  assert.throws(
    () =>
      requireSessionToken({
        tokenStore: new SessionTokenStore(),
        runtimeStore: { append: async () => {} },
        makeRuntimeId: () => "evt_x",
        validateRuntimeEvent: () => true,
      }),
    /workspace required/,
  );
});

test("middleware: works without runtimeStore (no-op audit)", async () => {
  const tokenStore = new SessionTokenStore();
  const issued = tokenStore.issue({ sessionId: "ses_a" });
  const app = express();
  app.use(express.json());
  app.post(
    "/api/sessions/:sessionId/mutate",
    requireSessionToken({ tokenStore }),
    (req, res) => res.status(200).json({ ok: true }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/sessions/ses_a/mutate`, {
      method: "POST",
      headers: { "X-LT-Session-Token": issued.token },
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(`http://127.0.0.1:${port}/api/sessions/ses_a/mutate`, {
      method: "POST",
    });
    assert.equal(bad.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("middleware: getSessionId override supports non-:sessionId routes", async () => {
  const tokenStore = new SessionTokenStore();
  const issued = tokenStore.issue({ sessionId: "ses_z" });
  const app = express();
  app.use(express.json());
  app.post(
    "/api/mutate",
    requireSessionToken({
      tokenStore,
      getSessionId: (req) => req.body && req.body.sessionId,
    }),
    (req, res) => res.status(200).json({ ok: true, who: req.sessionToken.sessionId }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: {
        "X-LT-Session-Token": issued.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: "ses_z" }),
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: {
        "X-LT-Session-Token": issued.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: "ses_other" }),
    });
    assert.equal(bad.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
