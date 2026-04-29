import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-wscope-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# watcher scope\n");
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

async function waitForUpdate(url, matcher, { attempts = 30, interval = 250 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    if (res.ok) {
      const body = await res.json();
      if (matcher(body)) return body;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for ${url}`);
}

test("symlink target edits propagate through the dedicated polling watcher", async () => {
  const workspace = setupWorkspace();
  const repo = mkdtempSync(join(tmpdir(), "llm-tracker-repo-"));
  const port = await findFreePort();
  const targetPath = join(repo, "linked.json");
  writeFileSync(targetPath, JSON.stringify({ ...validProject(), meta: { ...validProject().meta, slug: "linked" } }, null, 2));

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const link = runCli(["link", "linked", targetPath, "--path", workspace, "--port", String(port)]);
    assert.equal(link.status, 0, link.stderr || link.stdout);

    const initial = await fetch(`http://127.0.0.1:${port}/api/projects/linked`);
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.file, realpathSync(targetPath));
    assert.equal(initialBody.workspace, workspace);
    assert.equal(initialBody.port, port);
    assert.equal(initialBody.topology, "repo-linked");
    assert.equal(initialBody.target.registrationFile, join(workspace, "trackers", "linked.json"));
    assert.equal(initialBody.target.file, realpathSync(targetPath));

    // Edit the symlink target directly (not the workspace symlink) — the
    // polling watcher for the linked target must pick this up.
    const body = JSON.parse(JSON.stringify({ ...validProject(), meta: { ...validProject().meta, slug: "linked", scratchpad: "edited-via-target" } }));
    writeFileSync(targetPath, JSON.stringify(body, null, 2));

    const updated = await waitForUpdate(
      `http://127.0.0.1:${port}/api/projects/linked`,
      (payload) => payload?.data?.meta?.scratchpad === "edited-via-target"
    );
    assert.equal(updated.data.meta.scratchpad, "edited-via-target");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
