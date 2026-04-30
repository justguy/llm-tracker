import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { validProject } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-sec-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# sec test\n");
  return ws;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf-8",
    timeout: 15000,
    ...options
  });
}

function sendHttpRequest({ port, method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers
      },
      (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function stopDaemon(workspace) {
  runCli(["daemon", "stop", "--path", workspace]);
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

test("cross-origin POST is blocked with 403", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example.com"
      },
      body: JSON.stringify({ meta: { scratchpad: "hacked" } })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /cross-origin/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("malformed Referer on mutating request is blocked with 403", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Referer: "http://%"
      },
      body: JSON.stringify({ meta: { scratchpad: "blocked" } })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /invalid Referer/);
    assert.match(body.hint, /loopback/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("same-origin and no-origin POST are allowed", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({ meta: { scratchpad: "hi" } })
    });
    assert.equal(sameOrigin.status, 200);

    const noOrigin = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta: { scratchpad: "cli" } })
    });
    assert.equal(noOrigin.status, 200);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("same-origin POST is allowed for an explicit non-loopback host origin", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"], {
      env: { ...process.env, LLM_TRACKER_HOST: "0.0.0.0" }
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const res = await sendHttpRequest({
      port,
      method: "POST",
      path: "/api/projects/test-project/patch",
      headers: {
        "Content-Type": "application/json",
        Host: `devbox.lan:${port}`,
        Origin: `http://devbox.lan:${port}`
      },
      body: JSON.stringify({ meta: { scratchpad: "lan" } })
    });
    assert.equal(res.status, 200);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("bearer token is required and browser UI uses a session cookie without exposing the raw token", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"], {
      env: { ...process.env, LLM_TRACKER_TOKEN: "s3cret" }
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const unauth = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta: { scratchpad: "x" } })
    });
    assert.equal(unauth.status, 401);

    const wrong = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ meta: { scratchpad: "x" } })
    });
    assert.equal(wrong.status, 401);

    const good = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer s3cret"
      },
      body: JSON.stringify({ meta: { scratchpad: "ok" } })
    });
    assert.equal(good.status, 200);
    const goodBody = await good.json();
    assert.equal(goodBody.ok, true);
    assert.equal(goodBody.noop, false);
    assert.ok(Number.isInteger(goodBody.rev) && goodBody.rev >= 1);
    assert.match(goodBody.updatedAt || "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(goodBody.file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(goodBody.workspace, workspace);
    assert.equal(goodBody.port, port);
    assert.equal(goodBody.topology, "shared-workspace");
    assert.equal(goodBody.registrationFile, join(workspace, "trackers", "test-project.json"));

    const read = await fetch(`http://127.0.0.1:${port}/api/projects/test-project`);
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.equal(readBody.file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(readBody.registrationFile, join(workspace, "trackers", "test-project.json"));
    assert.equal(readBody.workspace, workspace);
    assert.equal(readBody.port, port);
    assert.equal(readBody.topology, "shared-workspace");
    assert.deepEqual(readBody.target, {
      workspace,
      port,
      file: realpathSync(join(workspace, "trackers", "test-project.json")),
      registrationFile: join(workspace, "trackers", "test-project.json"),
      topology: "shared-workspace"
    });

    const history = await fetch(`http://127.0.0.1:${port}/api/history/test-project`);
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.equal(historyBody.file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(historyBody.registrationFile, join(workspace, "trackers", "test-project.json"));
    assert.equal(historyBody.workspace, workspace);
    assert.equal(historyBody.port, port);
    assert.equal(historyBody.topology, "shared-workspace");

    const reload = await fetch(`http://127.0.0.1:${port}/api/reload`, {
      method: "POST",
      headers: { Authorization: "Bearer s3cret" }
    });
    assert.equal(reload.status, 200);
    const reloadBody = await reload.json();
    assert.equal(reloadBody.workspace, workspace);
    assert.equal(reloadBody.port, port);
    assert.equal(reloadBody.reloaded[0].file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(reloadBody.reloaded[0].registrationFile, join(workspace, "trackers", "test-project.json"));
    assert.equal(reloadBody.reloaded[0].topology, "shared-workspace");

    const html = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(html.status, 200);
    const text = await html.text();
    assert.doesNotMatch(text, /window\.__LLM_TRACKER_TOKEN=/);
    assert.doesNotMatch(text, /s3cret/);

    const cookie = html.headers.get("set-cookie");
    assert.match(cookie || "", /llm_tracker_ui_session=/);

    const uiAuthed = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
        Cookie: (cookie || "").split(";")[0]
      },
      body: JSON.stringify({ meta: { scratchpad: "ui" } })
    });
    assert.equal(uiAuthed.status, 200);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("websocket rejects cross-origin upgrade with 403", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: "http://evil.example.com" }
    });
    const outcome = await new Promise((resolve) => {
      ws.once("open", () => {
        ws.close();
        resolve({ status: "open" });
      });
      ws.once("unexpected-response", (_req, res) => {
        resolve({ status: "rejected", code: res.statusCode });
      });
      ws.once("error", (err) => resolve({ status: "error", message: err.message }));
    });
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.code, 403);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("websocket allows same-origin upgrade", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: `http://127.0.0.1:${port}` }
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.close();
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("websocket requires bearer token when LLM_TRACKER_TOKEN is set", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"], {
      env: { ...process.env, LLM_TRACKER_TOKEN: "wsauth" }
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const unauth = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const unauthResult = await new Promise((resolve) => {
      unauth.once("open", () => resolve({ status: "open" }));
      unauth.once("unexpected-response", (_req, res) => resolve({ status: "rejected", code: res.statusCode }));
      unauth.once("error", (err) => resolve({ status: "error", message: err.message }));
    });
    assert.equal(unauthResult.status, "rejected");
    assert.equal(unauthResult.code, 401);

    const good = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: "Bearer wsauth" }
    });
    await new Promise((resolve, reject) => {
      good.once("open", resolve);
      good.once("error", reject);
    });
    good.close();
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
