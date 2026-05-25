// test/api-attention-endpoints.test.js — SH-4-05 (TDD v0.5 §12.0, §8A.3)
//
// Acceptance tests for POST /api/attention/:id/{ack|snooze|clear}. Each test
// stands up a fresh Express app on 127.0.0.1:0 wired to a real RuntimeStore
// so we can observe the persisted runtime event after the handler returns.
//
// The endpoints DO NOT read the AttentionEngine projection — the projection
// layer consumes the events on the next tick. These tests confirm only:
//   (1) endpoint shape + validation,
//   (2) the right event type + payload reaches RuntimeStore.append.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { registerAttentionRoutes } from "../hub/api/attention.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const TEST_TIMEOUT = 8000;

async function startMiniApp() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-attention-api-"));
  const appended = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appended.push(event);
    },
  });
  const app = express();
  app.use(express.json());
  registerAttentionRoutes(app, { runtimeStore, workspace: workspaceRoot });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    workspaceRoot,
    runtimeStore,
    appended,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- ack -------------------------------------------------------------------

test("POST /api/attention/:id/ack: 201 happy path appends attention.ack", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/ack`, {
      dedupeKey: "kind=quiet|sessionId=ses_x",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.event.type, "attention.ack");
    assert.equal(body.event.attentionItemId, attId);
    assert.equal(body.event.dedupeKey, "kind=quiet|sessionId=ses_x");
    assert.equal(body.event.source, "http");
    assert.match(body.eventId, /^evt_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(body.rev, 1);
    assert.equal(env.appended.length, 1);
    assert.equal(env.appended[0].type, "attention.ack");
    assert.equal(env.appended[0].attentionItemId, attId);
    assert.equal(typeof env.appended[0].acknowledgedAt, "string");
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/ack: 400 on invalid att_ id", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, `/api/attention/not-an-id/ack`, { dedupeKey: "k" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_ATTENTION_ID");
    assert.equal(env.appended.length, 0);
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/ack: 400 on missing dedupeKey", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/ack`, {});
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /dedupeKey/);
    assert.equal(env.appended.length, 0);
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/ack: 400 on unknown body field", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/ack`, {
      dedupeKey: "k",
      bogus: 1,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "UNKNOWN_FIELDS");
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/ack: optional actor flows into the event", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/ack`, {
      dedupeKey: "k",
      actor: "adi@example.com",
    });
    assert.equal(res.status, 201);
    assert.equal(env.appended[0].actor, "adi@example.com");
  } finally {
    await env.close();
  }
});

// --- snooze ----------------------------------------------------------------

test("POST /api/attention/:id/snooze: 201 happy path appends attention.snoozed", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await postJson(env.base, `/api/attention/${attId}/snooze`, {
      dedupeKey: "k",
      until,
      reason: "stepping away for an hour",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.event.type, "attention.snoozed");
    assert.equal(body.event.snoozedUntil, until);
    assert.equal(body.event.reason, "stepping away for an hour");
    assert.equal(env.appended[0].type, "attention.snoozed");
    assert.equal(env.appended[0].snoozedUntil, until);
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/snooze: 400 when until is missing", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/snooze`, {
      dedupeKey: "k",
      reason: "r",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /until/);
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/snooze: 400 when until is unparseable", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/snooze`, {
      dedupeKey: "k",
      until: "not-a-date",
      reason: "r",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /parseable ISO-8601/);
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/snooze: 400 when until is in the past", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/snooze`, {
      dedupeKey: "k",
      until: "2000-01-01T00:00:00Z",
      reason: "r",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /future timestamp/);
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/snooze: 400 when reason is missing", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const until = new Date(Date.now() + 3600_000).toISOString();
    const res = await postJson(env.base, `/api/attention/${attId}/snooze`, {
      dedupeKey: "k",
      until,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /reason/);
  } finally {
    await env.close();
  }
});

// --- clear -----------------------------------------------------------------

test("POST /api/attention/:id/clear: 201 happy path appends attention.cleared", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/clear`, {
      dedupeKey: "k",
      reason: "operator confirms underlying conflict is resolved",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.event.type, "attention.cleared");
    assert.equal(body.event.reason, "operator confirms underlying conflict is resolved");
    assert.equal(env.appended[0].type, "attention.cleared");
    assert.equal(typeof env.appended[0].clearedAt, "string");
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/clear: 400 when reason is missing", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await postJson(env.base, `/api/attention/${attId}/clear`, { dedupeKey: "k" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.match(body.error.message, /reason/);
  } finally {
    await env.close();
  }
});

test("POST /api/attention/:id/clear: 400 on body being an array", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const attId = makeRuntimeId("att");
    const res = await fetch(`${env.base}/api/attention/${attId}/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
  } finally {
    await env.close();
  }
});

// --- registerAttentionRoutes guards ---------------------------------------

test("registerAttentionRoutes: throws when runtimeStore is missing", () => {
  const app = express();
  assert.throws(() => registerAttentionRoutes(app, { workspace: "/tmp/x" }), /runtimeStore/);
});

test("registerAttentionRoutes: throws when workspace is missing", () => {
  const app = express();
  assert.throws(
    () => registerAttentionRoutes(app, { runtimeStore: { append: () => {} } }),
    /workspace/,
  );
});
