import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";
import { startDaemonAndWait } from "./daemon-start-helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");
const FAKE_EMBEDDER = join(__dirname, "helpers", "fake-embedder.mjs");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-search-cli-"));
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

test("llm-tracker search and fuzzy render matches from the hub", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject({
    tasks: [
      {
        id: "t-017",
        title: "Parallel execution branch/variant route-flow proof",
        status: "in_progress",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: [],
        context: { tags: ["parallel-execution"] }
      },
      {
        id: "t-018",
        title: "Investor demo cost surface",
        status: "not_started",
        placement: { swimlaneId: "ops", priorityId: "p1" },
        dependencies: [],
        context: { tags: ["investor-demo", "cost"] }
      }
    ]
  });
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(project, null, 2));

  try {
    await startDaemonAndWait(runCli, {
      workspace,
      port,
      projectSlug: "test-project",
      options: { env: { ...process.env, LLM_TRACKER_EMBEDDER_MODULE: FAKE_EMBEDDER } }
    });
    assert.equal(existsSync(join(workspace, ".runtime", "daemon.json")), true);

    const semantic = runCli(["search", "test-project", "route flow proof", "--path", workspace], {
      env: { ...process.env, LLM_TRACKER_EMBEDDER_MODULE: FAKE_EMBEDDER }
    });
    assert.equal(semantic.status, 0, semantic.stderr || semantic.stdout);
    assert.match(semantic.stdout, /semantic search/);
    assert.match(semantic.stdout, /t-017/);

    const fuzzy = runCli(["fuzzy", "test-project", "paralel route", "--path", workspace], {
      env: { ...process.env, LLM_TRACKER_EMBEDDER_MODULE: FAKE_EMBEDDER }
    });
    assert.equal(fuzzy.status, 0, fuzzy.stderr || fuzzy.stdout);
    assert.match(fuzzy.stdout, /fuzzy search/);
    assert.match(fuzzy.stdout, /t-017/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
