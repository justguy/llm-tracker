import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { registerWorktreeRoutes } from "../hub/api/worktrees.js";
import { WorktreeService } from "../hub/worktrees/worktree-service.js";

const TEST_TIMEOUT = 8000;

async function startMiniApp({ trusted = true, runGit } = {}) {
  const calls = [];
  const worktreeService = new WorktreeService({
    now: () => "2026-05-31T08:00:00.000Z",
    makeId: () => "wt_attention",
    runGit: runGit || (async (args, options = {}) => {
      calls.push({ args: args.slice(), cwd: options.cwd });
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }),
  });
  const app = express();
  app.use(express.json({ strict: false }));
  registerWorktreeRoutes(app, {
    worktreeService,
    config: {
      trustedLocalMode: { allowWorktreeCreationFromUI: trusted },
      worktrees: { defaultNamingPattern: "{projectSlug}/{taskId}-{shortTitle}" },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    worktreeService,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/worktrees/create-from-attention creates a worktree at a safe default path", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const res = await postJson(env.base, "/api/worktrees/create-from-attention", {
      attentionItemId: "att_01h00000000000000000000000",
      dedupeKey: "conflict|worktree",
      projectSlug: "llm-tracker",
      taskId: "sh-7-09",
      jobId: "job_01h00000000000000000000000",
      sessionIds: ["ses_01h00000000000000000000000", "ses_01h00000000000000000000001"],
      sourceWorktreePath: "/repo/main",
      reason: "split shared worktree",
      title: "Worktree recommendation / create action",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    const expectedPath = "/repo/.worktrees/llm-tracker/sh-7-09-worktree-recommendation-create-action";
    assert.equal(body.ok, true);
    assert.equal(body.mode, "worktree_created_from_attention");
    assert.equal(body.defaultedPath, true);
    assert.equal(body.targetPath, expectedPath);
    assert.equal(body.worktree.path, expectedPath);
    assert.equal(body.worktree.sessionId, "ses_01h00000000000000000000000");
    assert.deepEqual(env.calls, [
      {
        args: ["worktree", "add", expectedPath],
        cwd: "/repo/main",
      },
    ]);
  } finally {
    await env.close();
  }
});

test("POST /api/worktrees/create-from-attention refuses when trusted UI creation is disabled", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp({ trusted: false });
  try {
    const res = await postJson(env.base, "/api/worktrees/create-from-attention", {
      projectSlug: "llm-tracker",
      sourceWorktreePath: "/repo/main",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, "WORKTREE_CREATION_DISABLED");
    assert.equal(env.calls.length, 0);
  } finally {
    await env.close();
  }
});

test("POST /api/worktrees/create-from-attention rejects raw git args and unsafe relative targets", { timeout: TEST_TIMEOUT }, async () => {
  const env = await startMiniApp();
  try {
    const raw = await postJson(env.base, "/api/worktrees/create-from-attention", {
      projectSlug: "llm-tracker",
      sourceWorktreePath: "/repo/main",
      args: ["worktree", "add", "/tmp/nope"],
    });
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error.code, "RAW_GIT_ARGS_REFUSED");

    const unsafe = await postJson(env.base, "/api/worktrees/create-from-attention", {
      projectSlug: "llm-tracker",
      sourceWorktreePath: "/repo/main",
      targetPath: "../escape",
    });
    assert.equal(unsafe.status, 400);
    assert.match((await unsafe.json()).error.message, /must not contain/);
    assert.equal(env.calls.length, 0);
  } finally {
    await env.close();
  }
});
