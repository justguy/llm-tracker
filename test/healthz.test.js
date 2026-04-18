import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-healthz-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# healthz test\n");
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

test("GET /healthz returns 200 with ok/projects/uptimeSeconds — no auth needed", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.projects, "number");
    assert.equal(typeof body.uptimeSeconds, "number");
    // An empty workspace has zero projects — the endpoint must still succeed.
    assert.ok(body.projects >= 0);
    assert.ok(body.uptimeSeconds >= 0);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("GET /healthz is reachable without bearer token when LLM_TRACKER_TOKEN is set", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"], {
      env: { ...process.env, LLM_TRACKER_TOKEN: "s3cret" }
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    // No Authorization header — must still get 200.
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.projects, "number");
    assert.equal(typeof body.uptimeSeconds, "number");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
