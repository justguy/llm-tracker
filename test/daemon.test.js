import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-daemon-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# test workspace\n");
  return ws;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf-8",
    timeout: 10000,
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
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

test("daemon mode starts in the background, creates .runtime, and stops cleanly", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const daemonMeta = join(workspace, ".runtime", "daemon.json");
  const daemonLog = join(workspace, ".runtime", "daemon.log");

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.match(started.stdout, /Background hub started/);
    assert.equal(existsSync(daemonMeta), true);
    assert.equal(existsSync(daemonLog), true);

    const meta = JSON.parse(readFileSync(daemonMeta, "utf-8"));
    assert.equal(meta.port, port);
    assert.ok(meta.pid > 0);

    const health = await fetch(`http://localhost:${port}/api/workspace`);
    assert.equal(health.status, 200);
    const workspacePayload = await health.json();
    assert.equal(workspacePayload.workspace, workspace);

    const status = runCli(["daemon", "status", "--path", workspace]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /Background hub is running/);
    assert.match(status.stdout, new RegExp(String(port)));

    const stopped = runCli(["daemon", "stop", "--path", workspace]);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.match(stopped.stdout, /Stopped background hub/);
    assert.equal(existsSync(daemonMeta), false);

    const afterStop = runCli(["daemon", "status", "--path", workspace]);
    assert.equal(afterStop.status, 0, afterStop.stderr || afterStop.stdout);
    assert.match(afterStop.stdout, /not running/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("help output documents daemon commands and the --daemon flag", () => {
  const res = runCli(["help"]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /--daemon/);
  assert.match(res.stdout, /daemon start/);
  assert.match(res.stdout, /daemon stop/);
  assert.match(res.stdout, /daemon logs/);
});
