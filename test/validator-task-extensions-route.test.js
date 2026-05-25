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

async function startDaemon(workspace, port) {
  const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
  if (started.status === 0) return;
  try {
    await waitForHub(port, 2000);
    return;
  } catch {}
  assert.equal(started.status, 0, started.stderr || started.stdout);
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

async function waitForProject(port, slug, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${slug}`);
      if (res.status === 200) return;
    } catch {}
    await delay(50);
  }
  assert.fail(`timed out waiting for project ${slug}`);
}

async function waitForHub(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/help`);
      if (res.status === 200) return;
    } catch {}
    await delay(50);
  }
  assert.fail("timed out waiting for hub");
}

test("POST /api/projects/:slug/patch rejects invalid task.verify (sh-5-17 wiring)", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    await startDaemon(workspace, port);
    await waitForProject(port, "test-project");

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
    assert.equal(body.type, "schema");
    assert.ok(
      typeof body.error === "string" &&
        body.error.includes("/tasks/0/verify/items/1/id") &&
        body.error.includes('duplicate verify-item id "dup"'),
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
    await startDaemon(workspace, port);
    await waitForHub(port);

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
    await startDaemon(workspace, port);
    await waitForProject(port, "test-project");

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
    assert.equal(body.type, "schema");
    assert.equal(body.kind, "schema");
    assert.equal(body.path, patchPath);
    assert.ok(
      typeof body.error === "string" && body.error.includes("Windows-drive"),
      `expected Windows-drive validator error, got: ${JSON.stringify(body)}`
    );
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("patch-file ingestion writes parse errors for malformed JSON", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    await startDaemon(workspace, port);
    await waitForProject(port, "test-project");

    const patchPath = join(workspace, "patches", "test-project.bad-json.json");
    const errPath = join(workspace, "patches", "test-project.bad-json.errors.json");
    writeFileSync(patchPath, "{ not json");

    await waitForFile(errPath);
    const body = JSON.parse(readFileSync(errPath, "utf8"));
    assert.equal(body.type, "parse");
    assert.equal(body.kind, "parse");
    assert.equal(body.path, patchPath);
    assert.match(body.error, /JSON|Expected|position/i);
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
    await startDaemon(workspace, port);
    await waitForProject(port, "test-project");

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
    assert.equal(body.type, "schema");
    assert.ok(
      typeof body.error === "string" &&
        body.error.includes("/tasks/0/repos/primary/allowed_paths/0") &&
        body.error.includes("repo-relative"),
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
    await startDaemon(workspace, port);
    await waitForProject(port, "test-project");

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
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status} body=${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(body.noop, false);

    const persisted = await fetch(`http://127.0.0.1:${port}/api/projects/test-project`);
    assert.equal(persisted.status, 200);
    const projectBody = await persisted.json();
    assert.deepEqual(projectBody.data.tasks[0].repos.primary.allowed_paths, ["src/**"]);
    assert.equal(projectBody.data.tasks[0].verify.items[0].id, "lt.test");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
