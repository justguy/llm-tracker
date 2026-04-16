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
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-restore-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# restore test\n");
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

test("restoreProject rehydrates the latest snapshot after delete", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const deleted = await store.deleteProject("test-project");
    assert.equal(deleted.ok, true);
    assert.equal(existsSync(file), false);

    const restored = await store.restoreProject("test-project");
    assert.equal(restored.ok, true);
    assert.ok(restored.restoredFromRev >= 1);
    assert.equal(existsSync(file), true);

    const reloaded = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(reloaded.meta.slug, "test-project");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("restoreProject refuses when project still exists", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.restoreProject("test-project");
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.match(res.message, /already registered/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("restoreProject errors when no snapshots exist", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const res = await store.restoreProject("never-seen");
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.match(res.message, /no snapshots/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("restoreProject honors an explicit rev from snapshots", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    await store.applyPatch("test-project", { meta: { scratchpad: "after" } });
    const afterRev = store.get("test-project").rev;
    assert.ok(afterRev >= 1);

    const deleted = await store.deleteProject("test-project");
    assert.equal(deleted.ok, true);

    const restored = await store.restoreProject("test-project", { rev: 1 });
    assert.equal(restored.ok, true);
    assert.equal(restored.restoredFromRev, 1);

    const rehydrated = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(rehydrated.meta.rev, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("restoreProject rejects unknown rev", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const deleted = await store.deleteProject("test-project");
    assert.equal(deleted.ok, true);

    const res = await store.restoreProject("test-project", { rev: 999 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("restore endpoint + CLI round-trip through the running hub", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const del = await fetch(`http://127.0.0.1:${port}/api/projects/test-project`, {
      method: "DELETE"
    });
    assert.equal(del.status, 200);
    assert.equal(existsSync(join(workspace, "trackers", "test-project.json")), false);

    const restore = runCli(["restore", "test-project", "--path", workspace, "--port", String(port)]);
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
    assert.match(restore.stdout, /Restored test-project/);
    assert.equal(existsSync(join(workspace, "trackers", "test-project.json")), true);

    const read = await fetch(`http://127.0.0.1:${port}/api/projects/test-project`);
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.equal(body.data.meta.slug, "test-project");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
