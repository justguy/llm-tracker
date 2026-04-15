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
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-why-cli-"));
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

test("llm-tracker why and decisions render deterministic retrieval packs", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  project.meta.rev = 4;
  project.tasks[0].comment = "Needed before task 2 can finish";
  project.tasks[0].reference = "hub/store.js:1-20";
  project.tasks[1].comment = "Wait for task 1 to clear";
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(project, null, 2));
  writeFileSync(
    join(workspace, ".history", "test-project.jsonl"),
    JSON.stringify({
      rev: 3,
      ts: "2026-04-15T00:01:00.000Z",
      delta: { tasks: { t1: { comment: "Needed before task 2 can finish" } } },
      summary: ["task 1 note updated"]
    }) + "\n"
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    await waitForProject(port, "test-project");

    const why = runCli(["why", "test-project", "t1", "--path", workspace]);
    assert.equal(why.status, 0, why.stderr || why.stdout);
    assert.match(why.stdout, /WHY/);
    assert.match(why.stdout, /Unblocks t2/);

    const decisions = runCli(["decisions", "test-project", "--path", workspace]);
    assert.equal(decisions.status, 0, decisions.stderr || decisions.stdout);
    assert.match(decisions.stdout, /decisions 2/);
    assert.match(decisions.stdout, /Needed before task 2 can finish/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
