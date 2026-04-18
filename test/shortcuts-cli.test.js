import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    ...options
  });
}

test("shortcuts prints a zero-token shell wrapper", () => {
  const res = runCli(["shortcuts"]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /eval "\$\(npx llm-tracker shortcuts\)"/);
  assert.match(res.stdout, /__llm_tracker_cli\(\)/);
  assert.match(res.stdout, /lt\(\)/);
  assert.match(res.stdout, /lt next <slug>/);
});

test("shortcuts accepts a custom shell alias name", () => {
  const res = runCli(["shortcuts", "--alias", "tracker"]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /tracker\(\)/);
  assert.doesNotMatch(res.stdout, /lt\(\)/);
});

test("shortcuts rejects an invalid shell alias name", () => {
  const res = runCli(["shortcuts", "--alias", "bad-name"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Invalid alias "bad-name"/);
});
