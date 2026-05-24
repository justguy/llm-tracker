import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
import { registerWorkspaceConfigRoutes } from "../hub/api/workspace-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "lt-ws-config-api-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# api test\n");
  return ws;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startMiniApp(workspace) {
  const app = express();
  registerWorkspaceConfigRoutes(app, { workspace });
  const port = await findFreePort();
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

test("GET /api/workspace/config/session-hub returns 200 with defaults when no file exists", async () => {
  const ws = setupWorkspace();
  const { port, close } = await startMiniApp(ws);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspace/config/session-hub`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.ok(body.resolved);
    assert.equal(body.resolved.activity.heartbeatEveryMinutes, 5);
    assert.equal(body.resolved.completionGates.uiCompleteMode, "block_required_missing");
    assert.deepEqual(body.sources, [{ kind: "defaults" }]);
  } finally {
    await close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("GET /api/workspace/config/session-hub reflects an on-disk override", async () => {
  const ws = setupWorkspace();
  writeFileSync(
    join(ws, "llm-tracker.config.yaml"),
    "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 42\n"
  );
  const { port, close } = await startMiniApp(ws);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspace/config/session-hub`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resolved.activity.heartbeatEveryMinutes, 42);
    // sibling defaults still present
    assert.equal(body.resolved.activity.missingHeartbeatAfterMinutes, 12);
    const fileSource = body.sources.find((s) => s.kind === "file");
    assert.ok(fileSource);
    assert.ok(fileSource.path.endsWith("llm-tracker.config.yaml"));
  } finally {
    await close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("GET /api/workspace/config/session-hub returns 500 with line anchor on malformed YAML", async () => {
  const ws = setupWorkspace();
  writeFileSync(
    join(ws, "llm-tracker.config.yaml"),
    "sessionHub:\n\tactivity:\n\t\theartbeatEveryMinutes: 5\n"
  );
  const { port, close } = await startMiniApp(ws);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspace/config/session-hub`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(body.type, "WORKSPACE_CONFIG_PARSE_ERROR");
    assert.ok(body.file && body.file.endsWith("llm-tracker.config.yaml"));
    assert.equal(typeof body.line, "number");
  } finally {
    await close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI: llm-tracker config session-hub prints JSON defaults from an empty workspace", () => {
  const ws = setupWorkspace();
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, "config", "session-hub", "--path", ws],
      { encoding: "utf-8", timeout: 15000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.resolved.activity.heartbeatEveryMinutes, 5);
    assert.deepEqual(body.sources, [{ kind: "defaults" }]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI: --format yaml emits YAML", () => {
  const ws = setupWorkspace();
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, "config", "session-hub", "--path", ws, "--format", "yaml"],
      { encoding: "utf-8", timeout: 15000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^resolved:/m);
    assert.match(result.stdout, /heartbeatEveryMinutes: 5/);
    assert.match(result.stdout, /^sources:/m);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI: --config flag takes precedence on the config surface", () => {
  const ws = setupWorkspace();
  const override = join(ws, "override.yaml");
  writeFileSync(
    join(ws, "llm-tracker.config.yaml"),
    "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 42\n"
  );
  writeFileSync(
    override,
    "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 7\n"
  );
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, "config", "session-hub", "--path", ws, "--config", override],
      { encoding: "utf-8", timeout: 15000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.resolved.activity.heartbeatEveryMinutes, 7);
    assert.equal(body.sources.at(-1).kind, "flag");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI: missing subcommand prints usage and exits non-zero", () => {
  const ws = setupWorkspace();
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, "config", "--path", ws],
      { encoding: "utf-8", timeout: 15000 }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Hub startup fails fast on malformed workspace config", async () => {
  const ws = setupWorkspace();
  const port = await findFreePort();
  writeFileSync(
    join(ws, "llm-tracker.config.yaml"),
    "sessionHub:\n\tactivity:\n\t\theartbeatEveryMinutes: 5\n"
  );
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, "--path", ws, "--port", String(port)],
      { encoding: "utf-8", timeout: 15000 }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /workspace config: malformed YAML/);
    assert.match(result.stderr, /line \d+/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI: unknown subcommand exits non-zero", () => {
  const ws = setupWorkspace();
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, "config", "totally-bogus", "--path", ws],
      { encoding: "utf-8", timeout: 15000 }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown subcommand/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI: malformed YAML produces a line-anchored error and non-zero exit", () => {
  const ws = setupWorkspace();
  writeFileSync(
    join(ws, "llm-tracker.config.yaml"),
    "sessionHub:\n\tactivity:\n\t\theartbeatEveryMinutes: 5\n"
  );
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, "config", "session-hub", "--path", ws],
      { encoding: "utf-8", timeout: 15000 }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to load workspace config/);
    assert.match(result.stderr, /line \d+/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
