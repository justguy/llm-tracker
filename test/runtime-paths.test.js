// test/runtime-paths.test.js — sh-1-01 (TDD v0.5 §5.1, §23.2 #11, #13)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makePaths } from "../hub/runtime/paths.js";

const ROOT = process.platform === "win32" ? "C:\\workspace\\my-proj" : "/workspace/my-proj";

test("makePaths derives all §5.1 file paths from workspaceRoot", () => {
  const p = makePaths({ workspaceRoot: ROOT });
  assert.equal(p.runtimeDir, path.join(ROOT, ".runtime"));
  assert.equal(p.runtimeEvents, path.join(ROOT, ".runtime", "runtime-events.jsonl"));
  assert.equal(p.repoEvents, path.join(ROOT, ".runtime", "repo-events.jsonl"));
  assert.equal(p.sessionsSnapshot, path.join(ROOT, ".runtime", "sessions.snapshot.json"));
  assert.equal(p.jobsSnapshot, path.join(ROOT, ".runtime", "jobs.snapshot.json"));
  assert.equal(p.skillRunsSnapshot, path.join(ROOT, ".runtime", "skill-runs.snapshot.json"));
  assert.equal(p.sessionStdioDir, path.join(ROOT, ".runtime", "session-stdio"));
  assert.equal(p.layoutsDir, path.join(ROOT, ".runtime", "layouts"));
  assert.equal(p.sessionHubLayout, path.join(ROOT, ".runtime", "layouts", "session-hub.json"));
});

test("every returned path is absolute", () => {
  const p = makePaths({ workspaceRoot: ROOT });
  for (const [key, value] of Object.entries(p)) {
    assert.ok(path.isAbsolute(value), `${key} should be absolute, got ${value}`);
  }
});

test("returned object is frozen — paths are immutable", () => {
  const p = makePaths({ workspaceRoot: ROOT });
  assert.ok(Object.isFrozen(p));
  assert.throws(() => {
    p.runtimeDir = "/tmp/other";
  });
});

test("paths use the platform separator", () => {
  const p = makePaths({ workspaceRoot: ROOT });
  // Sanity: every produced path should contain the platform separator
  // somewhere after the root (no naïve string concatenation with `/`).
  for (const value of Object.values(p)) {
    if (value === p.runtimeDir) continue; // single segment is fine
    assert.ok(
      value.includes(path.sep),
      `${value} should use the platform separator ${JSON.stringify(path.sep)}`,
    );
  }
});

test("makePaths rejects missing or non-absolute workspaceRoot", () => {
  assert.throws(() => makePaths({}), /workspaceRoot/);
  assert.throws(() => makePaths({ workspaceRoot: "" }), /workspaceRoot/);
  assert.throws(() => makePaths({ workspaceRoot: 42 }), /workspaceRoot/);
  assert.throws(() => makePaths({ workspaceRoot: "relative/path" }), /absolute/);
});

test("sessionHubLayout lives under layoutsDir (§23.2 #13)", () => {
  const p = makePaths({ workspaceRoot: ROOT });
  assert.equal(path.dirname(p.sessionHubLayout), p.layoutsDir);
});

test("snapshot/event paths live directly under runtimeDir", () => {
  const p = makePaths({ workspaceRoot: ROOT });
  for (const key of [
    "runtimeEvents",
    "repoEvents",
    "sessionsSnapshot",
    "jobsSnapshot",
    "skillRunsSnapshot",
    "sessionStdioDir",
    "layoutsDir",
  ]) {
    assert.equal(path.dirname(p[key]), p.runtimeDir, `${key} parent`);
  }
});
