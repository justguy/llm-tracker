// SH-0-07 strict workspace-config schema tests.
//
// Covers:
//   1. Defaults round-trip cleanly through the strict schema (compatibility).
//   2. neverAutoApproveTerminalPrompts is non-overridable; flipping it
//      to false is rejected with a clear, dedicated error message.
//   3. Unknown keys under sessionHub.completionGates are rejected.
//   4. Enum violations (completionGates.uiCompleteMode, crossProjectQueue.scope)
//      are rejected.
//   5. trustedLocalMode per-flag defaults (§23.2 #20):
//        - background-automation flags all false
//        - user-action flags all true
//        - requireConfirmationForCrossProjectLaunch: true
//        - enabled: false, neverAutoApproveTerminalPrompts: true
//   6. Lint rule: a regex grep over the repo asserts NO source file flips
//      neverAutoApproveTerminalPrompts to false. The TDD/PRD/TASKS docs
//      that legitimately quote the truth (`= true`) are allowed; only
//      `= false`-style assignments anywhere fail this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkspaceConfig } from "../hub/config/validator.js";
import { WORKSPACE_CONFIG_DEFAULTS, cloneDefaults } from "../hub/config/defaults.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");

test("strict schema: built-in §25 defaults validate cleanly", () => {
  const { ok, errors } = validateWorkspaceConfig(WORKSPACE_CONFIG_DEFAULTS);
  assert.equal(ok, true, `defaults must validate; got errors: ${JSON.stringify(errors)}`);
  assert.deepEqual(errors, []);
});

test("strict schema: empty config (no overrides) validates", () => {
  const { ok, errors } = validateWorkspaceConfig({});
  assert.equal(ok, true, `errors: ${JSON.stringify(errors)}`);
});

test("strict schema: neverAutoApproveTerminalPrompts=false is REJECTED with a non-overridable message", () => {
  const cfg = cloneDefaults();
  cfg.sessionHub.trustedLocalMode.neverAutoApproveTerminalPrompts = false;
  const { ok, errors } = validateWorkspaceConfig(cfg);
  assert.equal(ok, false, "schema must reject neverAutoApproveTerminalPrompts: false");
  const joined = errors.join("\n");
  assert.match(joined, /neverAutoApproveTerminalPrompts/);
  assert.match(joined, /non-overridable/i, `expected a 'non-overridable' message; got: ${joined}`);
});

test("strict schema: unknown key under sessionHub.completionGates is rejected", () => {
  const cfg = {
    sessionHub: {
      completionGates: { uiCompleteMode: "block_required_missing", futureKey: true }
    }
  };
  const { ok, errors } = validateWorkspaceConfig(cfg);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("futureKey")), `errors: ${JSON.stringify(errors)}`);
});

test("strict schema: completionGates.uiCompleteMode rejects invalid enum value", () => {
  const cfg = {
    sessionHub: { completionGates: { uiCompleteMode: "invalid_mode" } }
  };
  const { ok, errors } = validateWorkspaceConfig(cfg);
  assert.equal(ok, false);
  const joined = errors.join("\n");
  assert.match(joined, /uiCompleteMode/);
  assert.match(joined, /block_required_missing/);
});

test("strict schema: crossProjectQueue.scope rejects 'global' (workspace-only)", () => {
  const cfg = {
    sessionHub: { crossProjectQueue: { scope: "global" } }
  };
  const { ok, errors } = validateWorkspaceConfig(cfg);
  assert.equal(ok, false);
  const joined = errors.join("\n");
  assert.match(joined, /scope/);
  assert.match(joined, /workspace/);
});

test("strict schema: notifications.humanApprovalStyle enum is enforced", () => {
  const ok1 = validateWorkspaceConfig({
    sessionHub: { notifications: { humanApprovalStyle: "attention_item" } }
  }).ok;
  const ok2 = validateWorkspaceConfig({
    sessionHub: { notifications: { humanApprovalStyle: "popover" } }
  }).ok;
  assert.equal(ok1, true);
  assert.equal(ok2, false);
});

test("strict schema: providers.<name> enforces kind enum, command types, and forbids unknown keys", () => {
  // Unknown kind → reject.
  const badKind = validateWorkspaceConfig({
    sessionHub: { providers: { foo: { kind: "weird_kind", command: ["foo"] } } }
  });
  assert.equal(badKind.ok, false);
  const joined = badKind.errors.join("\n");
  assert.match(joined, /kind/);

  // command must be array of strings, not a scalar.
  const badCmd = validateWorkspaceConfig({
    sessionHub: { providers: { foo: { kind: "generic_pty", command: "single-string" } } }
  });
  assert.equal(badCmd.ok, false);
  assert.ok(badCmd.errors.some((e) => e.includes("/sessionHub/providers/foo/command")));

  // Unknown per-provider key → reject (typo guard).
  const typo = validateWorkspaceConfig({
    sessionHub: { providers: { foo: { kind: "generic_pty", command: ["x"], commad: ["typo"] } } }
  });
  assert.equal(typo.ok, false);
  assert.ok(typo.errors.some((e) => e.includes("commad")));

  // Happy path: full new provider.
  const okCfg = validateWorkspaceConfig({
    sessionHub: { providers: { custom: { kind: "generic_pty", command: ["x"] } } }
  });
  assert.equal(okCfg.ok, true, `errors: ${JSON.stringify(okCfg.errors)}`);

  // Partial override of an existing provider must validate — the loader
  // merges this over the default block, which already supplies kind+command.
  const partial = validateWorkspaceConfig({
    sessionHub: { providers: { codex_cli: { command: ["custom-codex"] } } }
  });
  assert.equal(partial.ok, true, `errors: ${JSON.stringify(partial.errors)}`);
});

test("strict schema: top-level unknown key still rejected", () => {
  const { ok, errors } = validateWorkspaceConfig({ sessionHub: {}, extra: 1 });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("extra")));
});

test("§23.2 #20: trustedLocalMode background-automation flags all default false", () => {
  const tlm = WORKSPACE_CONFIG_DEFAULTS.sessionHub.trustedLocalMode;
  const backgroundFlags = [
    "autoCreateWorktreeOnLaunch",
    "autoRolloverOnContextHigh",
    "autoRunVerifyCommands",
    "autoApproveProviderRequests",
    "autoLaunchCrossProjectQueue",
    "autoArchiveStoppedSessions",
    "stdioCaptureToDiskDefault"
  ];
  for (const flag of backgroundFlags) {
    assert.equal(tlm[flag], false, `trustedLocalMode.${flag} must default to false`);
  }
});

test("§23.2 #20: trustedLocalMode user-action flags all default true", () => {
  const tlm = WORKSPACE_CONFIG_DEFAULTS.sessionHub.trustedLocalMode;
  const userActionFlags = [
    "allowDirectContextInjectionOnUserLaunch",
    "allowStdinInjectionOnUserAction",
    "allowSessionRestartOnUserAction",
    "allowVerifyCommandRunOnUserAction",
    "allowWorktreeCreationFromUI",
    "allowProviderReviewFromUI"
  ];
  for (const flag of userActionFlags) {
    assert.equal(tlm[flag], true, `trustedLocalMode.${flag} must default to true`);
  }
});

test("§23.2 #20: trustedLocalMode top-level defaults (enabled, neverAutoApprove..., requireConfirmationForCrossProjectLaunch)", () => {
  const tlm = WORKSPACE_CONFIG_DEFAULTS.sessionHub.trustedLocalMode;
  assert.equal(tlm.enabled, false);
  assert.equal(tlm.neverAutoApproveTerminalPrompts, true);
  assert.equal(tlm.requireConfirmationForCrossProjectLaunch, true);
});

// --- Lint-rule grep ------------------------------------------------------
//
// The non-overridable safety flag must NEVER be assigned `false` in any
// code or config file in the source tree. We scan JS, JSON, YAML, and YML
// only — markdown is documentation (the TASKS docs legitimately describe
// the negative-case test using the literal `neverAutoApproveTerminalPrompts: false`
// inside backticks, which is intentional and should not trip the lint).
// Skipped dirs: node_modules, .git, .runtime, dist, build, coverage,
// vendor, .cache, .next, .snapshots, .history, target, .tmp, .hoplon.

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".runtime",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".cache",
  ".next",
  ".snapshots",
  ".history",
  "target",
  ".tmp",
  ".hoplon"
]);

const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".yaml", ".yml"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && SCAN_SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      yield* walk(abs);
    } else if (entry.isFile()) {
      yield abs;
    }
  }
}

test("lint rule: no source file sets neverAutoApproveTerminalPrompts to false", () => {
  const offenders = [];
  // The regex matches `neverAutoApproveTerminalPrompts` followed (on the same
  // line, after `:` or `=`) by `false`. Quoted "false" also counts.
  const re = /neverAutoApproveTerminalPrompts\s*[:=]\s*["']?false["']?/;
  // Allow this very test file to mention the literal in a comment without
  // tripping; this file itself flips it via JS assignment to test rejection.
  const selfPath = __filename;
  for (const file of walk(REPO_ROOT)) {
    if (file === selfPath) continue;
    const ext = file.slice(file.lastIndexOf("."));
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.size > 5 * 1024 * 1024) continue; // skip huge files
    let txt;
    try {
      txt = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `Found neverAutoApproveTerminalPrompts=false assignments — this safety flag is non-overridable:\n${offenders.join("\n")}`
  );
});
