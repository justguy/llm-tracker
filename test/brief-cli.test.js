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
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-brief-cli-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", "docs"]) {
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

test("llm-tracker brief renders a focused task pack from the hub", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  project.meta.rev = 3;
  project.tasks[0].reference = "docs/guide.md:1-2";
  project.tasks[0].comment = "Read the brief pack instead of the repo";
  writeFileSync(join(workspace, "docs", "guide.md"), "line one\nline two\nline three\n");
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(project, null, 2));
  writeFileSync(
    join(workspace, ".history", "test-project.jsonl"),
    JSON.stringify({
      rev: 2,
      ts: "2026-04-15T00:01:00.000Z",
      delta: { tasks: { t1: { comment: "Read the brief pack instead of the repo" } } },
      summary: ["task 1 note updated"]
    }) + "\n"
  );

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    await waitForProject(port, "test-project");

    const brief = runCli(["brief", "test-project", "t1", "--path", workspace]);
    assert.equal(brief.status, 0, brief.stderr || brief.stdout);
    assert.match(brief.stdout, /SNIPPETS/);
    assert.match(brief.stdout, /docs\/guide\.md:1-2/);
    assert.match(brief.stdout, /line one/);
    assert.match(brief.stdout, /HISTORY/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
