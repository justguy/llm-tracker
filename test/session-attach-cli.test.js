import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  runSessionAttachCommand,
} from "../hub/cli/session-attach.js";

function createStreams() {
  let stdout = "";
  let stderr = "";
  let exitCode = null;
  return {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    exit: (code) => {
      exitCode = code;
      return code;
    },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
    get exitCode() { return exitCode; },
  };
}

test("session attach discovers cwd/repoRoot, creates a manual session, and prints token contract", async () => {
  const io = createStreams();
  let posted;
  await runSessionAttachCommand({
    args: {
      _: ["session", "attach"],
      flags: { project: "demo", task: "t1", agent: "codex" },
    },
    resolveWorkspace: () => "/workspace",
    cwd: "/repo",
    execFileSync: () => "/repo\n",
    httpRequest: async (_workspace, _port, method, path, body) => {
      posted = { method, path, body };
      return {
        status: 201,
        port: 4400,
        body: {
          session: { id: "ses_attach", ...body },
          token: { token: "cleartext-token" },
          rev: 1,
          eventId: "evt_attach",
        },
      };
    },
    ...io,
  });

  assert.equal(io.exitCode, 0);
  assert.equal(posted.method, "POST");
  assert.equal(posted.path, "/api/sessions");
  assert.deepEqual(posted.body, {
    name: "codex:demo/t1",
    tier: "manual",
    projectSlug: "demo",
    taskId: "t1",
    agent: "codex",
    cwd: "/repo",
    repoRoot: "/repo",
  });
  assert.match(io.stdoutText, /LT_SESSION_ID='ses_attach'/);
  assert.match(io.stdoutText, /LT_SESSION_TOKEN='cleartext-token'/);
  assert.match(io.stdoutText, /LT_MCP_URL='stdio:\/\/llm-tracker-mcp'/);
  assert.match(io.stdoutText, /LT_MCP_COMMAND='llm-tracker mcp --path '\\''\/workspace'\\'' --port '\\''4400'\\'''/);
  assert.match(io.stdoutText, /token=cleartext-token/);
});

test("session attach honors explicit cwd/repoRoot/worktree flags", async () => {
  const io = createStreams();
  let posted;
  await runSessionAttachCommand({
    args: {
      _: ["session", "attach"],
      flags: {
        project: "demo",
        task: "t2",
        agent: "codex",
        cwd: "/cwd",
        "repo-root": "/repo",
        worktree: "/repo-wt",
      },
    },
    resolveWorkspace: () => "/workspace",
    execFileSync: () => {
      throw new Error("should not discover when explicit repo root is supplied");
    },
    httpRequest: async (_workspace, _port, _method, _path, body) => {
      posted = body;
      return {
        status: 201,
        port: 4400,
        body: {
          session: { id: "ses_flags", ...body },
          token: { token: "tok" },
        },
      };
    },
    ...io,
  });
  assert.equal(io.exitCode, 0);
  assert.equal(posted.cwd, "/cwd");
  assert.equal(posted.repoRoot, "/repo");
  assert.equal(posted.worktreePath, "/repo-wt");
  assert.match(io.stdoutText, /worktreePath=\/repo-wt/);
});

test("session attach still creates session when git repo discovery fails", async () => {
  const io = createStreams();
  let posted;
  await runSessionAttachCommand({
    args: {
      _: ["session", "attach"],
      flags: { project: "demo", task: "t3", agent: "codex" },
    },
    resolveWorkspace: () => "/workspace",
    cwd: "/not-a-repo",
    execFileSync: () => {
      throw new Error("not a git repository");
    },
    httpRequest: async (_workspace, _port, _method, _path, body) => {
      posted = body;
      return {
        status: 201,
        port: 4400,
        body: {
          session: { id: "ses_unknown", ...body },
          token: { token: "tok" },
        },
      };
    },
    ...io,
  });
  assert.equal(io.exitCode, 0);
  assert.equal(posted.cwd, "/not-a-repo");
  assert.equal("repoRoot" in posted, false);
  assert.match(io.stdoutText, /repo unknown/);
});

test("top-level CLI dispatch exposes the session command", () => {
  const bin = readFileSync(new URL("../bin/llm-tracker.js", import.meta.url), "utf8");
  assert.match(bin, /cmdSession/);
  assert.match(bin, /cmd === "session"/);
  assert.match(bin, /llm-tracker session attach --project/);
});
