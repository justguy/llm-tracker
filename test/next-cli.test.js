import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-next-cli-"));
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

test("llm-tracker next renders ranked tasks from the hub", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  project.tasks[0].reference = "hub/store.js:1-20";
  project.tasks[0].comment = "Top ready task";
  project.tasks[0].context = {
    ...project.tasks[0].context,
    roadmap_section: "Next CLI roadmap"
  };
  project.tasks.push({
    id: "t4",
    title: "Decision gated task",
    status: "not_started",
    placement: { swimlaneId: "ops", priorityId: "p0" },
    dependencies: [],
    approval_required_for: ["product"]
  });
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(project, null, 2));

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.equal(existsSync(join(workspace, ".runtime", "daemon.json")), true);

    await waitForProject(port, "test-project");

    const next = runCli(["next", "test-project", "--path", workspace]);
    assert.equal(next.status, 0, next.stderr || next.stdout);
    assert.match(next.stdout, /test-project/);
    assert.match(next.stdout, /t1/);
    assert.match(next.stdout, /executable/);
    assert.match(next.stdout, /explicit references available/);
    assert.match(next.stdout, /Roadmap: Next CLI roadmap/);
    assert.doesNotMatch(next.stdout, /t4/);

    const includeGated = runCli(["next", "test-project", "--path", workspace, "--include-gated"]);
    assert.equal(includeGated.status, 0, includeGated.stderr || includeGated.stdout);
    assert.match(includeGated.stdout, /t4/);
    assert.match(includeGated.stdout, /decision_gated/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
