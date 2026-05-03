import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store, trackerPath } from "../hub/store.js";
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

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${file}`);
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

test("oversized scratchpad in start request is rejected at the route layer", async () => {
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
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "t1", assignee: "codex", scratchpad: big })
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

test("HTTP start endpoint starts an explicit task atomically", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/tasks/t1/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee: "codex", scratchpad: "codex started t1" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.startedTaskId, "t1");
    assert.equal(body.action, "start");
    assert.equal(body.task.status, "in_progress");
    assert.equal(body.task.assignee, "codex");

    const after = JSON.parse(readFileSync(join(workspace, "trackers", "test-project.json"), "utf-8"));
    assert.equal(after.meta.scratchpad, "codex started t1");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("HTTP start endpoint requires an assignee", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "t1" })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /assignee/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale expectedRev in HTTP patch is rejected with 409", async () => {
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
        expectedRev: 0,
        tasks: { t1: { status: "complete" } }
      })
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.type, "conflict");
    assert.equal(body.expectedRev, 0);
    assert.equal(body.currentRev, 1);
    assert.match(body.error, /stale write rejected/);

    const after = JSON.parse(readFileSync(join(workspace, "trackers", "test-project.json"), "utf-8"));
    assert.equal(after.tasks.find((task) => task.id === "t1").status, "not_started");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("array patch body is rejected with an actionable schema hint", async () => {
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
      body: JSON.stringify([])
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.type, "schema");
    assert.match(body.error, /patch body must be a JSON object/);
    assert.match(body.hint, /swimlaneOps/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("structural HTTP patch returns repair payload for stranded swimlane tasks", async () => {
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
        swimlaneOps: [{ op: "remove", id: "ops" }]
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.type, "schema");
    assert.equal(body.repair.moveTasksTo, "exec");
    assert.deepEqual(body.repair.affectedTaskIds, ["t3"]);
    assert.deepEqual(body.repair.swimlaneOps, [
      { op: "remove", id: "ops", reassignTo: "exec" }
    ]);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale expectedRev in file patch writes structured conflict errors", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const trackerFile = join(workspace, "trackers", "test-project.json");
  writeFileSync(trackerFile, JSON.stringify(validProject(), null, 2));

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const patchFile = join(workspace, "patches", "test-project.stale.json");
    const errorFile = join(workspace, "patches", "test-project.stale.errors.json");
    writeFileSync(
      patchFile,
      JSON.stringify({
        expectedRev: 0,
        tasks: { t1: { status: "complete" } }
      })
    );

    await waitForFile(errorFile);
    const error = JSON.parse(readFileSync(errorFile, "utf-8"));
    assert.equal(error.type, "conflict");
    assert.equal(error.kind, "conflict");
    assert.equal(error.expectedRev, 0);
    assert.equal(error.currentRev, 1);
    assert.match(error.hint, /Refresh/);

    const after = JSON.parse(readFileSync(trackerFile, "utf-8"));
    assert.equal(after.tasks.find((task) => task.id === "t1").status, "not_started");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reload surfaces direct-file schema warnings for oversized task comments", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const trackerFile = join(workspace, "trackers", "test-project.json");
  writeFileSync(trackerFile, JSON.stringify(validProject(), null, 2));

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const bad = validProject();
    bad.tasks[0].comment = "c".repeat(501);
    writeFileSync(trackerFile, JSON.stringify(bad, null, 2));

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/reload`, {
      method: "POST"
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.notes.warnings[0], /task\.comment is too long/);

    const list = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(list.status, 200);
    const payload = await list.json();
    const project = payload.projects.find((item) => item.slug === "test-project");
    assert.equal(project.error, null);
    assert.match(project.warnings[0], /task\.comment/);
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

test("oversized task.blocker_reason in patch is rejected at the route layer", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const big = "b".repeat(2100);
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: { "t1": { blocker_reason: big } } })
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.type, "field.too.large");
    assert.match(body.field, /tasks\[t1\]\.blocker_reason/);
    assert.equal(body.max, 2000);
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

test("oversized blocker_reason in store validation warns so direct repair is never blocked", async () => {
  const workspace = setupWorkspace();
  try {
    const store = new Store(workspace);
    const file = trackerPath(workspace, "test-project");
    writeFileSync(file, JSON.stringify(validProject(), null, 2));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      tasks: {
        t1: { blocker_reason: "b".repeat(2100) }
      }
    });
    assert.equal(res.ok, true);
    assert.match(res.notes.warnings[0], /blocker_reason/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
