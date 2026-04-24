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

function setupWorkspace(prefix = "llm-tracker-reload-cli-") {
  const ws = mkdtempSync(join(tmpdir(), prefix));
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

async function waitForProject(port, slug) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${slug}`);
      if (res.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for project ${slug}`);
}

test("llm-tracker link eagerly loads a symlinked tracker without waiting for watcher add", async () => {
  const workspace = setupWorkspace("llm-tracker-link-cli-");
  const externalRoot = setupWorkspace("llm-tracker-link-target-");
  const port = await findFreePort();

  try {
    const external = validProject({
      meta: {
        ...validProject().meta,
        name: "External Project",
        slug: "external-project"
      }
    });
    writeFileSync(join(externalRoot, "external-project.json"), JSON.stringify(external, null, 2));

    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const linked = runCli([
      "link",
      "external-project",
      join(externalRoot, "external-project.json"),
      "--path",
      workspace
    ]);
    assert.equal(linked.status, 0, linked.stderr || linked.stdout);
    assert.match(linked.stdout, /loaded: yes/);

    const project = await fetch(`http://127.0.0.1:${port}/api/projects/external-project`);
    assert.equal(project.status, 200);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("slug routes auto-reload a tracker from disk before polling catches up", async () => {
  const workspace = setupWorkspace("llm-tracker-auto-slug-");
  const port = await findFreePort();

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const project = validProject({
      meta: {
        ...validProject().meta,
        name: "Lazy Loaded",
        slug: "lazy-loaded"
      }
    });
    writeFileSync(join(workspace, "trackers", "lazy-loaded.json"), JSON.stringify(project, null, 2));

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/lazy-loaded`);
    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(json.slug, "lazy-loaded");
    assert.equal(json.data.meta.name, "Lazy Loaded");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("project list refreshes from disk before returning projects", async () => {
  const workspace = setupWorkspace("llm-tracker-auto-list-");
  const port = await findFreePort();

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const project = validProject({
      meta: {
        ...validProject().meta,
        name: "List Reloaded",
        slug: "list-reloaded"
      }
    });
    writeFileSync(join(workspace, "trackers", "list-reloaded.json"), JSON.stringify(project, null, 2));

    const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(json.projects.some((item) => item.slug === "list-reloaded"), true);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("llm-tracker reload reloads a tracker from disk on demand", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  const trackerFile = join(workspace, "trackers", "test-project.json");
  writeFileSync(trackerFile, JSON.stringify(project, null, 2));

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    await waitForProject(port, "test-project");

    project.tasks[0].comment = "Reloaded from disk";
    writeFileSync(trackerFile, JSON.stringify(project, null, 2));

    const reloaded = runCli(["reload", "test-project", "--path", workspace]);
    assert.equal(reloaded.status, 0, reloaded.stderr || reloaded.stdout);
    assert.match(reloaded.stdout, /Reloaded test-project/);

    const body = await fetch(`http://127.0.0.1:${port}/api/projects/test-project`);
    const json = await body.json();
    assert.equal(json.data.tasks[0].comment, "Reloaded from disk");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
