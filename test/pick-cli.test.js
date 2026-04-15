import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-pick-cli-"));
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
      const res = await fetch(`http://localhost:${port}/api/projects/${slug}`);
      if (res.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for project ${slug}`);
}

test("llm-tracker pick claims the top ready task atomically", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(validProject(), null, 2));

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    await waitForProject(port, "test-project");

    const picked = runCli(["pick", "test-project", "--path", workspace, "--assignee", "codex"]);
    assert.equal(picked.status, 0, picked.stderr || picked.stdout);
    assert.match(picked.stdout, /picked t1/);
    assert.match(picked.stdout, /assignee=codex/);

    const after = JSON.parse(readFileSync(join(workspace, "trackers", "test-project.json"), "utf-8"));
    const t1 = after.tasks.find((task) => task.id === "t1");
    assert.equal(t1.status, "in_progress");
    assert.equal(t1.assignee, "codex");
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
