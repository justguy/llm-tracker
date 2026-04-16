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
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-limits-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# limits test\n");
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

test("oversized meta.scratchpad in patch is rejected at the route layer", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const big = "x".repeat(6000);
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta: { scratchpad: big } })
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.type, "field.too.large");
    assert.equal(body.field, "meta.scratchpad");
    assert.equal(body.max, 5000);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("oversized task.comment in patch is rejected at the route layer", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const big = "c".repeat(600);
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: { "t1": { comment: big } } })
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.type, "field.too.large");
    assert.match(body.field, /tasks\[t1\]\.comment/);
    assert.equal(body.max, 500);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("JSON body limit is enforced with machine-readable response", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli([
      "--path",
      workspace,
      "--port",
      String(port),
      "--daemon"
    ], {
      env: { ...process.env, LLM_TRACKER_BODY_LIMIT: "4kb" }
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const payload = JSON.stringify({ meta: { scratchpad: "y".repeat(5000) } });
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.match(body.error || "", /too large|body/i);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
