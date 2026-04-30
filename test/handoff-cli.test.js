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
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-handoff-cli-"));
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

test("llm-tracker handoff renders a deterministic prompt with from/to labels", async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  const project = validProject();
  project.meta.rev = 5;
  project.tasks[0].definition_of_done = ["Tests pass"];
  project.tasks[0].comment = "Decision: keep schema flat";
  writeFileSync(join(workspace, "trackers", "test-project.json"), JSON.stringify(project, null, 2));

  try {
    const started = runCli(["--path", workspace, "--port", String(port), "--daemon"]);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    await waitForProject(port, "test-project");

    const handoff = runCli([
      "handoff",
      "test-project",
      "t1",
      "--from",
      "claude",
      "--to",
      "codex",
      "--path",
      workspace
    ]);
    assert.equal(handoff.status, 0, handoff.stderr || handoff.stdout);
    assert.match(handoff.stdout, /from=claude/);
    assert.match(handoff.stdout, /to=codex/);
    assert.match(handoff.stdout, /# Handoff: test-project\/t1/);
    assert.match(handoff.stdout, /Definition of done/);
    assert.match(handoff.stdout, /Tests pass/);
    assert.match(handoff.stdout, /tracker_execute/);

    const promptOnly = runCli([
      "handoff",
      "test-project",
      "t1",
      "--from",
      "claude",
      "--to",
      "codex",
      "--prompt-only",
      "--path",
      workspace
    ]);
    assert.equal(promptOnly.status, 0, promptOnly.stderr || promptOnly.stdout);
    // --prompt-only should not include the header summary line
    assert.doesNotMatch(promptOnly.stdout, /from=claude/);
    assert.match(promptOnly.stdout, /# Handoff: test-project\/t1/);

    const json = runCli(["handoff", "test-project", "t1", "--json", "--path", workspace]);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.packType, "handoff");
    assert.equal(payload.taskId, "t1");
    assert.match(payload.handoffPrompt, /# Handoff: test-project\/t1/);
  } finally {
    stopDaemon(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
});
