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
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-hygiene-cli-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
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

test("llm-tracker hygiene renders empty lanes, orphaned priorities, stale tasks, and unexplained blocks", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  project.meta.rev = 30;
  project.meta.swimlanes.push({ id: "review", label: "Review" });
  project.meta.priorities.push({ id: "p3", label: "P3 / Backlog" });
  project.tasks[1].rev = 1; // t2 in_progress, ancient
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(project, null, 2));
  writeFileSync(
    join(workspace, ".history", "test-project.jsonl"),
    JSON.stringify({
      rev: 1,
      ts: "2026-01-01T00:00:00.000Z",
      delta: { tasks: { t2: { status: "in_progress" } } }
    }) + "\n"
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    await waitForProject(port, "test-project");

    const hygiene = runCli(["hygiene", "test-project", "--path", workspace]);
    assert.equal(hygiene.status, 0, hygiene.stderr || hygiene.stdout);
    assert.match(hygiene.stdout, /EMPTY SWIMLANES/);
    assert.match(hygiene.stdout, /review/);
    assert.match(hygiene.stdout, /ORPHANED PRIORITIES/);
    assert.match(hygiene.stdout, /p3/);
    assert.match(hygiene.stdout, /STALE IN_PROGRESS/);
    assert.match(hygiene.stdout, /t2/);
    assert.match(hygiene.stdout, /BLOCKED WITHOUT REASON/);
    assert.match(hygiene.stdout, /threshold=10/);

    const json = runCli(["hygiene", "test-project", "--json", "--path", workspace]);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.packType, "hygiene");
    assert.equal(payload.project, "test-project");
    assert.ok(payload.counts.emptySwimlanes >= 1);
    assert.ok(payload.counts.orphanedPriorities >= 1);
    assert.ok(payload.counts.staleInProgress >= 1);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
