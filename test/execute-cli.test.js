import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validProject } from "./fixtures.js";
import { startDaemonAndWait } from "./daemon-start-helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-execute-cli-"));
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

test("llm-tracker execute renders the deterministic execution pack from the hub", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  project.tasks[0].reference = "docs/guide.md:1-2";
  project.tasks[0].definition_of_done = ["Guide text reviewed"];
  project.tasks[0].constraints = ["Keep wording stable"];
  project.tasks[0].expected_changes = ["docs/guide.md"];
  project.tasks[0].allowed_paths = ["docs/guide.md"];
  writeFileSync(join(workspace, "docs", "guide.md"), "line one\nline two\n");
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(project, null, 2));

  try {
    await startDaemonAndWait(runCli, { workspace, port, projectSlug: "test-project" });

    const execute = runCli(["execute", "test-project", "t1", "--path", workspace]);
    assert.equal(execute.status, 0, execute.stderr || execute.stdout);
    assert.match(execute.stdout, /EXECUTION PLAN/);
    assert.match(execute.stdout, /DONE WHEN/);
    assert.match(execute.stdout, /EXPECTED CHANGES/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
