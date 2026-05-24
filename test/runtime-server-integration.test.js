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
import { SESSION_ID_RE } from "../hub/runtime/ids.js";

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

async function patchJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

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
    });
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
