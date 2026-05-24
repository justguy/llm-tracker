import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "lt-validator-route-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# validator route test\n");
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

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(50);
  }
  assert.fail(`timed out waiting for ${path}`);
}

test("POST /api/projects/:slug/patch rejects invalid task.verify (sh-5-17 wiring)", async () => {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [
          {
            id: "t1",
            verify: {
              items: [
                { kind: "command", id: "dup", required: true, cmd: "a" },
                { kind: "lint", id: "dup", required: false, tool: "eslint" }
              ]
            }
          }
        ]
      })
    });
    assert.equal(res.status, 400, `expected 400 from validator, got ${res.status}`);
    const body = await res.json();
    assert.ok(
      typeof body.error === "string" && body.error.includes('duplicate verify-item id "dup"'),
      `expected duplicate-id validator error, got: ${JSON.stringify(body)}`
    );
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("PUT /api/projects/:slug rejects invalid task.verify through full-write validation", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  project.tasks[0].verify = {
    items: [{ kind: "command", id: "BadID", required: true, cmd: "true" }]
  };

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project)
    });
    assert.equal(res.status, 400, `expected 400 from validator, got ${res.status}`);
    const body = await res.json();
    assert.ok(
      typeof body.error === "string" && body.error.includes("pattern"),
      `expected verify-item pattern validator error, got: ${JSON.stringify(body)}`
    );
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("patch-file ingestion writes errors for invalid task.repos", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const patchPath = join(workspace, "patches", "test-project.invalid-repos.json");
    const errPath = join(workspace, "patches", "test-project.invalid-repos.errors.json");
    writeFileSync(
      patchPath,
      JSON.stringify({
        tasks: {
          t1: {
            repos: { primary: { root: "r", allowed_paths: ["C:\\Users\\me\\secrets"] } }
          }
        }
      })
    );

    await waitForFile(errPath);
    const body = JSON.parse(readFileSync(errPath, "utf8"));
    assert.ok(
      typeof body.error === "string" && body.error.includes("Windows-drive"),
      `expected Windows-drive validator error, got: ${JSON.stringify(body)}`
    );
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("POST /api/projects/:slug/patch rejects task.repos with absolute allowed_paths", async () => {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [
          {
            id: "t1",
            repos: { primary: { root: "r", allowed_paths: ["/etc/passwd"] } }
          }
        ]
      })
    });
    assert.equal(res.status, 400, `expected 400 from validator, got ${res.status}`);
    const body = await res.json();
    assert.ok(
      typeof body.error === "string" && body.error.includes("repo-relative"),
      `expected repo-relative validator error, got: ${JSON.stringify(body)}`
    );
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("POST /api/projects/:slug/patch accepts valid task.repos + task.verify", async () => {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [
          {
            id: "t1",
            repos: { primary: { root: "/abs/repo", allowed_paths: ["src/**"] } },
            verify: {
              items: [
                { kind: "command", id: "lt.test", required: true, cmd: "npm test" }
              ]
            }
          }
        ]
      })
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status} body=${await res.text()}`);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
