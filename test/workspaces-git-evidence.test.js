import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collect,
  collectGitDiffStat,
  collectGitEvidence,
  collectGitLogSince,
  collectGitStatus,
  createGitRunner,
  gitLogArgs,
  isMissingGitError,
} from "../hub/workspaces/git-evidence.js";

function fakeRunGit(results = {}) {
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args: args.slice(), options: { ...options } });
    const key = args[0] === "diff" ? "diffStat" : args[0];
    const value = results[key];
    if (value instanceof Error) throw value;
    if (typeof value === "function") return value(args, options);
    return value || { exitCode: 0, stdout: `${key} ok\n`, stderr: "", durationMs: 1 };
  };
  runner.calls = calls;
  return runner;
}

test("collectGitEvidence gathers status, diff --stat, and log --since evidence", async () => {
  const runGit = fakeRunGit({
    status: { exitCode: 0, stdout: "## main\n M app.js\n", stderr: "", durationMs: 2 },
    diffStat: { exitCode: 0, stdout: " app.js | 2 +-\n", stderr: "", durationMs: 3 },
    log: { exitCode: 0, stdout: "abc123 work\n", stderr: "", durationMs: 4 },
  });

  const evidence = await collectGitEvidence({
    repoRoot: "/repo",
    since: "2026-05-26T12:00:00.000Z",
    runGit,
    now: () => "2026-05-26T16:00:00.000Z",
  });

  assert.equal(evidence.ok, true);
  assert.equal(evidence.unavailable, false);
  assert.equal(evidence.reason, null);
  assert.equal(evidence.repoRoot, "/repo");
  assert.equal(evidence.since, "2026-05-26T12:00:00.000Z");
  assert.equal(evidence.collectedAt, "2026-05-26T16:00:00.000Z");
  assert.equal(evidence.status.stdout, "## main\n M app.js\n");
  assert.equal(evidence.diffStat.stdout, " app.js | 2 +-\n");
  assert.equal(evidence.log.stdout, "abc123 work\n");
  assert.deepEqual(
    runGit.calls.map((call) => call.args),
    [
      ["status", "--short", "--branch"],
      ["diff", "--stat"],
      ["log", "--since", "2026-05-26T12:00:00.000Z", "--oneline", "--decorate", "--max-count", "50"],
    ],
  );
  assert.deepEqual(
    runGit.calls.map((call) => call.options.cwd),
    ["/repo", "/repo", "/repo"],
  );
});

test("collect alias supports positional repoRoot and since arguments", async () => {
  const runGit = fakeRunGit();
  const evidence = await collect("/repo", "2 hours ago", { runGit });

  assert.equal(evidence.ok, true);
  assert.deepEqual(runGit.calls[2].args, [
    "log",
    "--since",
    "2 hours ago",
    "--oneline",
    "--decorate",
    "--max-count",
    "50",
  ]);
});

test("individual collectors expose the same command contracts", async () => {
  const runGit = fakeRunGit();

  const status = await collectGitStatus({ repoRoot: "/repo", runGit });
  const diffStat = await collectGitDiffStat({ repoRoot: "/repo", runGit });
  const log = await collectGitLogSince({ repoRoot: "/repo", since: "yesterday", logMaxCount: 7, runGit });

  assert.deepEqual(status.args, ["status", "--short", "--branch"]);
  assert.deepEqual(diffStat.args, ["diff", "--stat"]);
  assert.deepEqual(log.args, ["log", "--since", "yesterday", "--oneline", "--decorate", "--max-count", "7"]);
});

test("missing git is reported as unavailable without throwing or repeating commands", async () => {
  const error = new Error("spawn git ENOENT");
  error.code = "ENOENT";
  const runGit = fakeRunGit({ status: error });

  const evidence = await collectGitEvidence({ repoRoot: "/repo", since: "now", runGit });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.unavailable, true);
  assert.equal(evidence.reason, "git_unavailable");
  assert.equal(evidence.status.unavailable, true);
  assert.equal(evidence.status.errorCode, "ENOENT");
  assert.equal(evidence.diffStat.unavailable, true);
  assert.equal(evidence.log.unavailable, true);
  assert.equal(runGit.calls.length, 1);
  assert.equal(isMissingGitError(error), true);
});

test("non-zero git exits are structured command failures, not collector crashes", async () => {
  const runGit = fakeRunGit({
    status: { exitCode: 128, stdout: "", stderr: "not a git repository\n", durationMs: 2 },
    diffStat: { exitCode: 128, stdout: "", stderr: "not a git repository\n", durationMs: 2 },
    log: { exitCode: 128, stdout: "", stderr: "not a git repository\n", durationMs: 2 },
  });

  const evidence = await collectGitEvidence({ repoRoot: "/repo", since: "now", runGit });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.unavailable, false);
  assert.equal(evidence.status.ok, false);
  assert.equal(evidence.status.exitCode, 128);
  assert.match(evidence.status.stderr, /not a git repository/);
  assert.equal(runGit.calls.length, 3);
});

test("createGitRunner captures output, timeout, and truncation with an injected spawn", async () => {
  const listeners = {};
  const stdoutListeners = {};
  const stderrListeners = {};
  const killed = [];
  const fakeChild = {
    stdout: { on: (name, fn) => (stdoutListeners[name] = fn) },
    stderr: { on: (name, fn) => (stderrListeners[name] = fn) },
    on: (name, fn) => (listeners[name] = fn),
    kill: (signal) => killed.push(signal),
  };
  const spawnCalls = [];
  const spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return fakeChild;
  };
  const runGit = createGitRunner({ spawn, timeoutMs: 1000, maxOutputBytes: 5 });
  const promise = runGit(["status", "--short"], { cwd: "/repo" });

  stdoutListeners.data(Buffer.from("abcdef"));
  stderrListeners.data("warn");
  listeners.close(0, null);

  const result = await promise;
  assert.deepEqual(spawnCalls[0], {
    command: "git",
    args: ["status", "--short"],
    options: { cwd: "/repo", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "abcde");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderr, "warn");
  assert.deepEqual(killed, []);
});

test("createGitRunner resolves ENOENT spawn errors as missing git evidence", async () => {
  const error = new Error("spawn git ENOENT");
  error.code = "ENOENT";
  const runGit = createGitRunner({
    spawn() {
      throw error;
    },
  });

  const result = await runGit(["status"], { cwd: "/repo" });
  assert.equal(result.errorCode, "ENOENT");
  assert.equal(isMissingGitError(result), true);
});

test("gitLogArgs trims since and applies a positive max-count fallback", () => {
  assert.deepEqual(gitLogArgs("  yesterday  ", 3), [
    "log",
    "--since",
    "yesterday",
    "--oneline",
    "--decorate",
    "--max-count",
    "3",
  ]);
  assert.deepEqual(gitLogArgs("", 0), [
    "log",
    "--since",
    "24 hours ago",
    "--oneline",
    "--decorate",
    "--max-count",
    "50",
  ]);
});
