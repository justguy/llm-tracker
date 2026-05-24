import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkspaceConfig,
  WORKSPACE_CONFIG_ENV_VAR
} from "../hub/config/loader.js";
import { WORKSPACE_CONFIG_DEFAULTS } from "../hub/config/defaults.js";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "lt-ws-config-"));
  return ws;
}

function cleanup(ws) {
  rmSync(ws, { recursive: true, force: true });
}

test("returns built-in §25 defaults when no config file is present", async () => {
  const ws = setupWorkspace();
  try {
    const result = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    assert.equal(result.sources.length, 1);
    assert.deepEqual(result.sources, [{ kind: "defaults" }]);
    // Sanity: a few well-known §25 default values must round-trip.
    assert.equal(result.resolved.sessionHub.activity.heartbeatEveryMinutes, 5);
    assert.equal(result.resolved.sessionHub.completionGates.uiCompleteMode, "block_required_missing");
    assert.equal(result.resolved.sessionHub.trustedLocalMode.enabled, false);
    assert.equal(result.resolved.sessionHub.trustedLocalMode.neverAutoApproveTerminalPrompts, true);
    assert.equal(result.resolved.sessionHub.providers.codex_app_server.kind, "structured_provider");
    assert.deepEqual(
      result.resolved.sessionHub.providers.codex_app_server.transportPreference,
      ["stdio", "unix"]
    );
  } finally {
    cleanup(ws);
  }
});

test("defaults are immutable across loads (deep-frozen source, deep-cloned per call)", async () => {
  const ws = setupWorkspace();
  try {
    const a = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    a.resolved.sessionHub.activity.heartbeatEveryMinutes = 999;
    const b = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    assert.equal(b.resolved.sessionHub.activity.heartbeatEveryMinutes, 5);
    // And the exported frozen master is untouched.
    assert.equal(
      WORKSPACE_CONFIG_DEFAULTS.sessionHub.activity.heartbeatEveryMinutes,
      5
    );
  } finally {
    cleanup(ws);
  }
});

test("loads <workspace>/llm-tracker.config.yaml and deep-merges over defaults", async () => {
  const ws = setupWorkspace();
  try {
    writeFileSync(
      join(ws, "llm-tracker.config.yaml"),
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 10\n"
    );
    const result = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    // Overridden key wins.
    assert.equal(result.resolved.sessionHub.activity.heartbeatEveryMinutes, 10);
    // Sibling keys in the same block keep defaults.
    assert.equal(result.resolved.sessionHub.activity.missingHeartbeatAfterMinutes, 12);
    // Unrelated block keeps defaults.
    assert.equal(result.resolved.sessionHub.completionGates.uiCompleteMode, "block_required_missing");
    // sources reports the file with appliedKeys.
    assert.equal(result.sources[0].kind, "defaults");
    assert.equal(result.sources[1].kind, "file");
    assert.ok(result.sources[1].path.endsWith("llm-tracker.config.yaml"));
    assert.deepEqual(result.sources[1].appliedKeys, [
      "sessionHub.activity.heartbeatEveryMinutes"
    ]);
  } finally {
    cleanup(ws);
  }
});

test("loads <workspace>/.llm-tracker/config.yaml when no top-level file exists", async () => {
  const ws = setupWorkspace();
  try {
    mkdirSync(join(ws, ".llm-tracker"), { recursive: true });
    writeFileSync(
      join(ws, ".llm-tracker", "config.yaml"),
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 7\n"
    );
    const result = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    assert.equal(result.resolved.sessionHub.activity.heartbeatEveryMinutes, 7);
    assert.ok(result.sources[1].path.endsWith(join(".llm-tracker", "config.yaml")));
  } finally {
    cleanup(ws);
  }
});

test("top-level config wins over .llm-tracker/config.yaml; sibling keys cascade", async () => {
  const ws = setupWorkspace();
  try {
    mkdirSync(join(ws, ".llm-tracker"), { recursive: true });
    writeFileSync(
      join(ws, ".llm-tracker", "config.yaml"),
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 7\n    missingHeartbeatAfterMinutes: 99\n"
    );
    writeFileSync(
      join(ws, "llm-tracker.config.yaml"),
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 11\n"
    );
    const result = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    // Top-level wins for the overridden key.
    assert.equal(result.resolved.sessionHub.activity.heartbeatEveryMinutes, 11);
    // Hidden .llm-tracker file fills in the key the top-level omitted.
    assert.equal(result.resolved.sessionHub.activity.missingHeartbeatAfterMinutes, 99);
  } finally {
    cleanup(ws);
  }
});

test("LLM_TRACKER_CONFIG env wins over both workspace files", async () => {
  const ws = setupWorkspace();
  try {
    writeFileSync(
      join(ws, "llm-tracker.config.yaml"),
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 11\n"
    );
    const envFile = join(ws, "env.yaml");
    writeFileSync(
      envFile,
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 33\n"
    );
    const result = await loadWorkspaceConfig({
      workspaceRoot: ws,
      env: { [WORKSPACE_CONFIG_ENV_VAR]: envFile }
    });
    assert.equal(result.resolved.sessionHub.activity.heartbeatEveryMinutes, 33);
    const envSource = result.sources.find((s) => s.kind === "env");
    assert.ok(envSource);
    assert.equal(envSource.path, envFile);
  } finally {
    cleanup(ws);
  }
});

test("--config flag wins over env, workspace yaml, and .llm-tracker", async () => {
  const ws = setupWorkspace();
  try {
    writeFileSync(
      join(ws, "llm-tracker.config.yaml"),
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 11\n"
    );
    const envFile = join(ws, "env.yaml");
    writeFileSync(envFile, "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 33\n");
    const flagFile = join(ws, "flag.yaml");
    writeFileSync(flagFile, "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 77\n");

    const result = await loadWorkspaceConfig({
      workspaceRoot: ws,
      configFlag: flagFile,
      env: { [WORKSPACE_CONFIG_ENV_VAR]: envFile }
    });
    assert.equal(result.resolved.sessionHub.activity.heartbeatEveryMinutes, 77);
    const kinds = result.sources.map((s) => s.kind);
    assert.deepEqual(kinds, ["defaults", "file", "env", "flag"]);
  } finally {
    cleanup(ws);
  }
});

test("deep merge: nested override leaves sibling subkeys intact", async () => {
  const ws = setupWorkspace();
  try {
    writeFileSync(
      join(ws, "llm-tracker.config.yaml"),
      "sessionHub:\n  trustedLocalMode:\n    enabled: true\n"
    );
    const result = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    assert.equal(result.resolved.sessionHub.trustedLocalMode.enabled, true);
    // The "non-overridable" sibling stays as the default.
    assert.equal(
      result.resolved.sessionHub.trustedLocalMode.neverAutoApproveTerminalPrompts,
      true
    );
    // And the "user-initiated powerful actions" sibling block stays intact.
    assert.equal(
      result.resolved.sessionHub.trustedLocalMode.allowDirectContextInjectionOnUserLaunch,
      true
    );
  } finally {
    cleanup(ws);
  }
});

test("arrays replace wholesale (not concat) so users can shrink watcher.ignore", async () => {
  const ws = setupWorkspace();
  try {
    writeFileSync(
      join(ws, "llm-tracker.config.yaml"),
      "sessionHub:\n  watcher:\n    ignore:\n      - 'only-this/**'\n"
    );
    const result = await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    assert.deepEqual(result.resolved.sessionHub.watcher.ignore, ["only-this/**"]);
    // Sibling fields keep their defaults.
    assert.equal(result.resolved.sessionHub.watcher.backend, "chokidar");
  } finally {
    cleanup(ws);
  }
});

test("malformed YAML throws with file path and line/col anchors", async () => {
  const ws = setupWorkspace();
  try {
    const bad = join(ws, "llm-tracker.config.yaml");
    // Tab indentation under a mapping key — YAML parsers reject tabs as indent.
    writeFileSync(bad, "sessionHub:\n\tactivity:\n\t\theartbeatEveryMinutes: 5\n");
    let err;
    try {
      await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected loader to throw on malformed YAML");
    assert.equal(err.code, "WORKSPACE_CONFIG_PARSE_ERROR");
    assert.ok(err.message.includes(bad));
    assert.ok(/line \d+/.test(err.message), `message should anchor line: ${err.message}`);
    assert.equal(typeof err.line, "number");
  } finally {
    cleanup(ws);
  }
});

test("rejects unknown top-level keys (additionalProperties: false at root)", async () => {
  const ws = setupWorkspace();
  try {
    writeFileSync(
      join(ws, "llm-tracker.config.yaml"),
      "sessionHub:\n  activity:\n    heartbeatEveryMinutes: 5\nrandomExtra:\n  whatever: true\n"
    );
    let err;
    try {
      await loadWorkspaceConfig({ workspaceRoot: ws, env: {} });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected schema violation");
    assert.equal(err.code, "WORKSPACE_CONFIG_SCHEMA_ERROR");
    assert.ok(err.message.includes("randomExtra"));
  } finally {
    cleanup(ws);
  }
});

test("strict schema (sh-0-07): rejects unknown keys under sessionHub blocks but accepts new providers by patternProperty", async () => {
  // sh-0-07 tightened the schema: unknown keys inside a declared block are
  // now rejected (additionalProperties: false), but the providers map still
  // accepts any [A-Za-z0-9_]+ key so users can register custom providers.
  const wsBad = setupWorkspace();
  try {
    writeFileSync(
      join(wsBad, "llm-tracker.config.yaml"),
      "sessionHub:\n  completionGates:\n    futureSh07Key: 'opaque-value'\n"
    );
    let err;
    try {
      await loadWorkspaceConfig({ workspaceRoot: wsBad, env: {} });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected schema violation for unknown completionGates key");
    assert.equal(err.code, "WORKSPACE_CONFIG_SCHEMA_ERROR");
    assert.ok(err.message.includes("futureSh07Key"));
  } finally {
    cleanup(wsBad);
  }

  const wsGood = setupWorkspace();
  try {
    writeFileSync(
      join(wsGood, "llm-tracker.config.yaml"),
      "sessionHub:\n  providers:\n    custom_provider:\n      kind: generic_pty\n      command: ['foo']\n"
    );
    const result = await loadWorkspaceConfig({ workspaceRoot: wsGood, env: {} });
    assert.deepEqual(
      result.resolved.sessionHub.providers.custom_provider.command,
      ["foo"]
    );
    // §25 default providers still present.
    assert.equal(result.resolved.sessionHub.providers.codex_cli.kind, "generic_pty");
  } finally {
    cleanup(wsGood);
  }
});

test("throws when --config flag points at a non-existent file", async () => {
  const ws = setupWorkspace();
  try {
    let err;
    try {
      await loadWorkspaceConfig({
        workspaceRoot: ws,
        configFlag: join(ws, "nope.yaml"),
        env: {}
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.ok(err.message.includes("does not exist"));
  } finally {
    cleanup(ws);
  }
});

test("throws when LLM_TRACKER_CONFIG points at a non-existent file", async () => {
  const ws = setupWorkspace();
  try {
    let err;
    try {
      await loadWorkspaceConfig({
        workspaceRoot: ws,
        env: { [WORKSPACE_CONFIG_ENV_VAR]: join(ws, "missing.yaml") }
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.ok(err.message.includes("missing.yaml"));
  } finally {
    cleanup(ws);
  }
});

test("requires workspaceRoot", async () => {
  let err;
  try {
    await loadWorkspaceConfig({});
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.ok(err.message.toLowerCase().includes("workspaceroot"));
});
