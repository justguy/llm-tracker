// Production hub wiring for Track 0 runtime surfaces:
//   - /api/sessions is mounted by startHub()
//   - /runtime/ws receives runtime snapshots/events
//   - legacy /ws still receives the tracker SNAPSHOT contract

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { startHub } from "../hub/server.js";
import { createSessionWarningEvent } from "../hub/runtime/events.js";
import { SESSION_ID_RE, JOB_ID_RE } from "../hub/runtime/ids.js";

const TEST_TIMEOUT = 10000;

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "lt-runtime-server-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# runtime server integration\n");
  return ws;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => {
      try {
        resolve(JSON.parse(raw.toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });
}

function waitForMessageType(ws, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onMessage = (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (parsed.type !== type) return;
      cleanup();
      resolve(parsed);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function openWsWithFirstMessage(url, options) {
  const ws = new WebSocket(url, options);
  const firstMessage = waitForMessage(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, firstMessage: await firstMessage };
}

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function waitForEventOfType(ws, eventType) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch (err) {
        ws.off("message", onMessage);
        reject(err);
        return;
      }
      if (msg && msg.type === "runtime.event" && msg.event && msg.event.type === eventType) {
        ws.off("message", onMessage);
        resolve(msg);
      }
    };
    ws.on("message", onMessage);
    ws.once("error", (err) => {
      ws.off("message", onMessage);
      reject(err);
    });
  });
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

test("startHub mounts /api/jobs routes live — create + PATCH drive runtime events", { timeout: TEST_TIMEOUT }, async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const hub = await startHub({ workspace, port, uiDir: join(process.cwd(), "ui") });
  const base = `http://127.0.0.1:${port}`;
  let runtimeWs;

  try {
    const runtimeConn = await openWsWithFirstMessage(`ws://127.0.0.1:${port}/runtime/ws`, {
      headers: { Origin: base },
    });
    runtimeWs = runtimeConn.ws;
    assert.equal(runtimeConn.firstMessage.type, "runtime.snapshot");

    // The registry needs a real session id; mint one via the live sessions API.
    const sessionRes = await postJson(base, "/api/sessions", { name: "jobs-smoke", tier: "manual" });
    assert.equal(sessionRes.status, 201);
    const sessionBody = await sessionRes.json();
    const sessionId = sessionBody.session.id;
    assert.ok(SESSION_ID_RE.test(sessionId));

    const jobStartedPromise = waitForEventOfType(runtimeWs, "job.started");
    const createRes = await postJson(base, "/api/projects/demo/tasks/t-1/jobs", {
      sessionId,
      profileId: "code-implementer",
      kind: "code",
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.ok(JOB_ID_RE.test(createBody.jobId));
    assert.equal(createBody.job.status, "running");

    const startedMsg = await jobStartedPromise;
    assert.equal(startedMsg.event.type, "job.started");
    assert.equal(startedMsg.event.jobId, createBody.jobId);

    const checkpointPromise = waitForEventOfType(runtimeWs, "job.checkpoint");
    const patchRes = await patchJson(base, `/api/jobs/${createBody.jobId}`, { status: "blocked" });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.job.status, "blocked");

    const cpMsg = await checkpointPromise;
    assert.equal(cpMsg.event.type, "job.checkpoint");
    assert.equal(cpMsg.event.jobId, createBody.jobId);
    assert.equal(cpMsg.event.status, "blocked");
  } finally {
    if (runtimeWs) runtimeWs.close();
    await hub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("startHub mounts runtime sessions API and runtime websocket without changing legacy /ws", { timeout: TEST_TIMEOUT }, async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const hub = await startHub({ workspace, port, uiDir: join(process.cwd(), "ui") });
  const base = `http://127.0.0.1:${port}`;
  let runtimeWs;
  let legacyWs;

  try {
    const runtimeConn = await openWsWithFirstMessage(`ws://127.0.0.1:${port}/runtime/ws`, {
      headers: { Origin: base },
    });
    runtimeWs = runtimeConn.ws;
    const runtimeInitial = runtimeConn.firstMessage;
    assert.equal(runtimeInitial.type, "runtime.snapshot");
    assert.deepEqual(runtimeInitial.snapshot.sessions, []);
    assert.deepEqual(runtimeInitial.snapshot.jobs, []);
    assert.deepEqual(runtimeInitial.snapshot.skillRuns, []);

    const legacyConn = await openWsWithFirstMessage(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: base },
    });
    legacyWs = legacyConn.ws;
    const legacyInitial = legacyConn.firstMessage;
    assert.equal(legacyInitial.type, "SNAPSHOT");
    assert.ok(legacyInitial.projects);

    const layoutGet = await fetch(`${base}/api/layouts/session-hub`);
    assert.equal(layoutGet.status, 200);
    const layoutGetBody = await layoutGet.json();
    assert.equal(layoutGetBody.layout.version, 1);
    assert.equal(layoutGetBody.layout.global.cardSizeDefault, "normal");

    const layoutPut = await fetch(`${base}/api/layouts/session-hub`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        version: 1,
        global: { cardSizeDefault: "compact" },
        views: { hub: { groupBy: "project" } },
      }),
    });
    assert.equal(layoutPut.status, 200);
    const layoutPutBody = await layoutPut.json();
    assert.equal(layoutPutBody.layout.global.cardSizeDefault, "compact");

    const layoutPatch = await fetch(`${base}/api/layouts/session-hub`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ views: { hub: { groupBy: "urgency" } } }),
    });
    assert.equal(layoutPatch.status, 200);
    const layoutPatchBody = await layoutPatch.json();
    assert.equal(layoutPatchBody.layout.global.cardSizeDefault, "compact");
    assert.equal(layoutPatchBody.layout.views.hub.groupBy, "urgency");

    const providersRes = await fetch(`${base}/api/providers`);
    assert.equal(providersRes.status, 200);
    const providersBody = await providersRes.json();
    assert.deepEqual(providersBody.providers, [
      { id: "manual", label: "Manual (advisory)" },
      { id: "codex_cli", label: "Codex CLI" },
      { id: "claude_code", label: "Claude Code" },
      { id: "kimi", label: "Kimi" },
      { id: "gemini", label: "Gemini" },
    ]);

    const manualCapabilitiesRes = await fetch(`${base}/api/providers/manual/capabilities`);
    assert.equal(manualCapabilitiesRes.status, 200);
    const manualCapabilitiesBody = await manualCapabilitiesRes.json();
    assert.equal(manualCapabilitiesBody.providerId, "manual");
    assert.equal(manualCapabilitiesBody.capabilities.rawStdio, false);
    assert.equal(manualCapabilitiesBody.capabilities.processLifecycle, false);

    const eventPromise = waitForMessage(runtimeWs);
    const createRes = await postJson(base, "/api/sessions", {
      name: "prod-smoke",
      tier: "manual",
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.ok(SESSION_ID_RE.test(createBody.session.id));
    assert.equal(createBody.session.name, "prod-smoke");
    assert.equal(createBody.token.sessionId, createBody.session.id);

    const eventMsg = await eventPromise;
    assert.equal(eventMsg.type, "runtime.event");
    assert.equal(eventMsg.event.type, "session.started");
    assert.equal(eventMsg.event.session.id, createBody.session.id);

    const rotateMissingTokenRes = await fetch(`${base}/api/sessions/${createBody.session.id}/token/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({}),
    });
    assert.equal(rotateMissingTokenRes.status, 401);
    const rotateMissingTokenBody = await rotateMissingTokenRes.json();
    assert.equal(rotateMissingTokenBody.error.code, "SESSION_TOKEN_REJECTED");
    assert.equal(rotateMissingTokenBody.error.details.reason, "missing");

    const listRes = await fetch(`${base}/api/sessions`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.sessions.length, 1);
    assert.equal(listBody.sessions[0].id, createBody.session.id);

    const patchRes = await patchJson(base, `/api/sessions/${createBody.session.id}`, {
      status: "quiet",
    }, { "X-LT-Session-Token": createBody.token.token });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.session.status, "quiet");
  } finally {
    if (runtimeWs) runtimeWs.close();
    if (legacyWs) legacyWs.close();
    await hub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("startHub activity monitor marks stale dumb_terminal output quiet", { timeout: TEST_TIMEOUT }, async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const hub = await startHub({ workspace, port, uiDir: join(process.cwd(), "ui") });
  let runtimeWs;

  try {
    const base = `http://127.0.0.1:${port}`;
    const runtimeConn = await openWsWithFirstMessage(`ws://127.0.0.1:${port}/runtime/ws`, {
      headers: { Origin: base },
    });
    runtimeWs = runtimeConn.ws;
    assert.equal(runtimeConn.firstMessage.type, "runtime.snapshot");

    const startedPromise = waitForEventOfType(runtimeWs, "session.started");
    const createRes = await postJson(base, "/api/sessions", {
      name: "quiet-terminal",
      tier: "dumb_terminal",
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    await startedPromise;

    const staleOutputAt = isoMinutesAgo(15);
    const statusPromise = waitForEventOfType(runtimeWs, "session.status");
    await hub.runtimeStore.append({
      schemaVersion: 1,
      ts: staleOutputAt,
      type: "session.output",
      source: "system",
      workspace,
      sessionId: createBody.session.id,
      stream: "stdout",
      bytes: 8,
      preview: "stale",
    });

    const statusMsg = await statusPromise;
    assert.equal(statusMsg.event.source, "system");
    assert.equal(statusMsg.event.status, "quiet");
    assert.equal(statusMsg.event.sessionId, createBody.session.id);

    const getRes = await fetch(`${base}/api/sessions/${createBody.session.id}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.session.status, "quiet");
    assert.equal(getBody.session.lastOutputAt, staleOutputAt);
  } finally {
    if (runtimeWs) runtimeWs.close();
    await hub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("startHub activity monitor marks stale structured heartbeat quiet", { timeout: TEST_TIMEOUT }, async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const hub = await startHub({ workspace, port, uiDir: join(process.cwd(), "ui") });
  let runtimeWs;

  try {
    const base = `http://127.0.0.1:${port}`;
    const runtimeConn = await openWsWithFirstMessage(`ws://127.0.0.1:${port}/runtime/ws`, {
      headers: { Origin: base },
    });
    runtimeWs = runtimeConn.ws;
    assert.equal(runtimeConn.firstMessage.type, "runtime.snapshot");

    const startedPromise = waitForEventOfType(runtimeWs, "session.started");
    const createRes = await postJson(base, "/api/sessions", {
      name: "quiet-heartbeat",
      tier: "mcp_tracked",
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    await startedPromise;

    const staleHeartbeatAt = isoMinutesAgo(15);
    const statusPromise = waitForEventOfType(runtimeWs, "session.status");
    await hub.runtimeStore.append({
      schemaVersion: 1,
      ts: staleHeartbeatAt,
      type: "session.output",
      source: "mcp",
      workspace,
      sessionId: createBody.session.id,
      stream: "structured",
      bytes: 0,
      preview: "heartbeat",
    });

    const statusMsg = await statusPromise;
    assert.equal(statusMsg.event.source, "system");
    assert.equal(statusMsg.event.status, "quiet");
    assert.equal(statusMsg.event.sessionId, createBody.session.id);

    const getRes = await fetch(`${base}/api/sessions/${createBody.session.id}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.session.status, "quiet");
    assert.equal(getBody.session.lastStructuredEventAt, staleHeartbeatAt);
  } finally {
    if (runtimeWs) runtimeWs.close();
    await hub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("startHub activity monitor preserves explicit human status", { timeout: TEST_TIMEOUT }, async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const hub = await startHub({ workspace, port, uiDir: join(process.cwd(), "ui") });
  let runtimeWs;

  try {
    const base = `http://127.0.0.1:${port}`;
    const runtimeConn = await openWsWithFirstMessage(`ws://127.0.0.1:${port}/runtime/ws`, {
      headers: { Origin: base },
    });
    runtimeWs = runtimeConn.ws;
    assert.equal(runtimeConn.firstMessage.type, "runtime.snapshot");

    const startedPromise = waitForEventOfType(runtimeWs, "session.started");
    const createRes = await postJson(base, "/api/sessions", {
      name: "explicit-human",
      tier: "mcp_tracked",
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    await startedPromise;

    const patchRes = await patchJson(
      base,
      `/api/sessions/${createBody.session.id}`,
      { status: "waiting_for_human" },
      { "X-LT-Session-Token": createBody.token.token },
    );
    assert.equal(patchRes.status, 200);

    const staleHeartbeatAt = isoMinutesAgo(15);
    await hub.runtimeStore.append({
      schemaVersion: 1,
      ts: staleHeartbeatAt,
      type: "session.output",
      source: "mcp",
      workspace,
      sessionId: createBody.session.id,
      stream: "structured",
      bytes: 0,
      preview: "heartbeat",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const getRes = await fetch(`${base}/api/sessions/${createBody.session.id}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.session.status, "waiting_for_human");
    assert.equal(getBody.session.statusSource.kind, "http");
    assert.equal(getBody.session.lastStructuredEventAt, staleHeartbeatAt);

    const startingPatchRes = await patchJson(
      base,
      `/api/sessions/${createBody.session.id}`,
      { status: "starting" },
      { "X-LT-Session-Token": createBody.token.token },
    );
    assert.equal(startingPatchRes.status, 200);

    const secondStaleHeartbeatAt = isoMinutesAgo(16);
    await hub.runtimeStore.append({
      schemaVersion: 1,
      ts: secondStaleHeartbeatAt,
      type: "session.output",
      source: "mcp",
      workspace,
      sessionId: createBody.session.id,
      stream: "structured",
      bytes: 0,
      preview: "heartbeat",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const startingGetRes = await fetch(`${base}/api/sessions/${createBody.session.id}`);
    assert.equal(startingGetRes.status, 200);
    const startingGetBody = await startingGetRes.json();
    assert.equal(startingGetBody.session.status, "starting");
    assert.equal(startingGetBody.session.statusSource.kind, "http");
    assert.equal(startingGetBody.session.statusSource.eventType, "session.status");
    assert.equal(startingGetBody.session.lastStructuredEventAt, secondStaleHeartbeatAt);
  } finally {
    if (runtimeWs) runtimeWs.close();
    await hub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("startHub wires attention routes to runtime attention broadcasts", { timeout: TEST_TIMEOUT }, async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const hub = await startHub({ workspace, port, uiDir: join(process.cwd(), "ui") });
  let runtimeWs;

  try {
    const base = `http://127.0.0.1:${port}`;
    const runtimeConn = await openWsWithFirstMessage(`ws://127.0.0.1:${port}/runtime/ws`, {
      headers: { Origin: base },
    });
    runtimeWs = runtimeConn.ws;
    assert.equal(runtimeConn.firstMessage.type, "runtime.snapshot");
    assert.deepEqual(runtimeConn.firstMessage.snapshot.attention, []);

    const sessionEvent = waitForMessageType(runtimeWs, "runtime.event");
    const createRes = await postJson(base, "/api/sessions", {
      name: "attention-smoke",
      tier: "manual",
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.ok(SESSION_ID_RE.test(createBody.session.id));
    assert.equal((await sessionEvent).event.type, "session.started");

    const warningRuntimeEvent = waitForMessageType(runtimeWs, "runtime.event");
    const warningAttentionUpdate = waitForMessageType(runtimeWs, "attention.updated");
    await hub.runtimeStore.append(
      createSessionWarningEvent({
        sessionId: createBody.session.id,
        workspace,
        source: "system",
        warning: { kind: "approval_needed", source: "app_server", actionId: "act_1" },
      }),
    );

    assert.equal((await warningRuntimeEvent).event.type, "session.warning");
    const createdUpdate = await warningAttentionUpdate;
    assert.equal(createdUpdate.scope, "global");
    assert.equal(createdUpdate.items.length, 1);
    const [item] = createdUpdate.items;
    assert.equal(item.kind, "approval_needed");
    assert.equal(item.sessionId, createBody.session.id);

    const ackRuntimeEvent = waitForMessageType(runtimeWs, "runtime.event");
    const ackAttentionUpdate = waitForMessageType(runtimeWs, "attention.updated");
    const ackRes = await postJson(base, `/api/attention/${item.id}/ack`, {
      dedupeKey: item.dedupeKey,
      actor: "test",
    });
    assert.equal(ackRes.status, 201);
    assert.equal((await ackRuntimeEvent).event.type, "attention.ack");
    const ackUpdate = await ackAttentionUpdate;
    const ackedItem = ackUpdate.items.find((i) => i.id === item.id);
    assert.ok(ackedItem, "acknowledged attention item should remain in the active set");
    assert.equal(typeof ackedItem.acknowledgedAt, "string");

    const clearRuntimeEvent = waitForMessageType(runtimeWs, "runtime.event");
    const clearAttentionUpdate = waitForMessageType(runtimeWs, "attention.updated");
    const clearRes = await postJson(base, `/api/attention/${item.id}/clear`, {
      dedupeKey: item.dedupeKey,
      reason: "operator resolved the approval",
    });
    assert.equal(clearRes.status, 201);
    assert.equal((await clearRuntimeEvent).event.type, "attention.cleared");
    const clearUpdate = await clearAttentionUpdate;
    assert.equal(clearUpdate.items.find((i) => i.id === item.id), undefined);

    const afterClearRes = await fetch(`${base}/api/attention?scope=global`);
    assert.equal(afterClearRes.status, 200);
    const afterClearBody = await afterClearRes.json();
    assert.equal(afterClearBody.items.find((i) => i.id === item.id), undefined);
  } finally {
    if (runtimeWs) runtimeWs.close();
    await hub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
