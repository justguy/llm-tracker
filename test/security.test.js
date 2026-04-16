import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
        Origin: `http://localhost:${port}`
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

test("bearer token is required and UI injects it", async () => {
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

    const read = await fetch(`http://127.0.0.1:${port}/api/projects/test-project`);
    assert.equal(read.status, 200);

    const html = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(html.status, 200);
    const text = await html.text();
    assert.match(text, /window\.__LLM_TRACKER_TOKEN=/);
    assert.match(text, /s3cret/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
