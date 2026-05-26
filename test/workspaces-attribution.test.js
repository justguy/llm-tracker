import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeSessionIdsForRepo,
  classifyRepoChangeAttribution,
  isActiveSession,
  repoChangeAbsolutePath,
  runtimeAttributionForStrength,
} from "../hub/workspaces/attribution.js";

function session(overrides = {}) {
  return {
    id: "ses_default",
    projectSlug: "demo",
    status: "active",
    repoRoot: "/repo",
    ...overrides,
  };
}

test("classifyRepoChangeAttribution returns strong/worktree for a unique matching worktree", () => {
  const result = classifyRepoChangeAttribution({
    repoRoot: "/worktrees/demo-a",
    path: "src/app.js",
    projectSlug: "demo",
    sessions: [
      session({ id: "ses_a", repoRoot: "/repo", worktreePath: "/worktrees/demo-a" }),
      session({ id: "ses_b", repoRoot: "/repo", worktreePath: "/worktrees/demo-b" }),
    ],
  });

  assert.deepEqual(result, {
    strength: "strong",
    runtimeAttribution: "worktree",
    sessionIds: ["ses_a"],
    activeSessionIds: ["ses_a"],
    possibleSessionIds: ["ses_a"],
    reason: "unique_session_worktree_matches_path",
  });
});

test("classifyRepoChangeAttribution returns likely/single_active_session for one repo-bound session", () => {
  const result = classifyRepoChangeAttribution({
    repoRoot: "/repo",
    path: "src/app.js",
    projectSlug: "demo",
    sessions: [session({ id: "ses_repo" })],
  });

  assert.equal(result.strength, "likely");
  assert.equal(result.runtimeAttribution, "single_active_session");
  assert.deepEqual(result.activeSessionIds, ["ses_repo"]);
});

test("classifyRepoChangeAttribution returns ambiguous for shared repo or worktree matches", () => {
  const sharedRepo = classifyRepoChangeAttribution({
    repoRoot: "/repo",
    path: "src/app.js",
    sessions: [session({ id: "ses_a" }), session({ id: "ses_b" })],
  });
  assert.equal(sharedRepo.strength, "ambiguous");
  assert.equal(sharedRepo.runtimeAttribution, "ambiguous");
  assert.deepEqual(sharedRepo.activeSessionIds, ["ses_a", "ses_b"]);

  const sharedWorktree = classifyRepoChangeAttribution({
    repoRoot: "/worktrees/shared",
    path: "src/app.js",
    sessions: [
      session({ id: "ses_a", worktreePath: "/worktrees/shared" }),
      session({ id: "ses_b", worktreePath: "/worktrees/shared" }),
    ],
  });
  assert.equal(sharedWorktree.strength, "ambiguous");
  assert.deepEqual(sharedWorktree.activeSessionIds, ["ses_a", "ses_b"]);
});

test("classifyRepoChangeAttribution returns unknown when no active session matches", () => {
  const result = classifyRepoChangeAttribution({
    repoRoot: "/repo",
    path: "src/app.js",
    sessions: [
      session({ id: "ses_other_project", projectSlug: "other" }),
      session({ id: "ses_done", status: "complete" }),
      session({ id: "ses_other_repo", repoRoot: "/other" }),
    ],
    projectSlug: "demo",
  });

  assert.equal(result.strength, "unknown");
  assert.equal(result.runtimeAttribution, "unknown");
  assert.deepEqual(result.activeSessionIds, []);
});

test("cwd and worktree aliases participate in matching", () => {
  const cwdOnly = classifyRepoChangeAttribution({
    repoRoot: "/tmp/run",
    path: "src/app.js",
    sessions: [session({ id: "ses_cwd", repoRoot: null, cwd: "/tmp/run" })],
  });
  assert.equal(cwdOnly.strength, "likely");
  assert.deepEqual(cwdOnly.activeSessionIds, ["ses_cwd"]);

  const worktreeAlias = classifyRepoChangeAttribution({
    repoRoot: "/tmp/wt",
    path: "src/app.js",
    sessions: [session({ id: "ses_wt", worktree: "/tmp/wt" })],
  });
  assert.equal(worktreeAlias.strength, "strong");
  assert.equal(worktreeAlias.runtimeAttribution, "worktree");
});

test("runtimeAttributionForStrength maps TDD strengths to the current runtime enum", () => {
  assert.equal(runtimeAttributionForStrength("strong"), "worktree");
  assert.equal(runtimeAttributionForStrength("likely"), "single_active_session");
  assert.equal(runtimeAttributionForStrength("ambiguous"), "ambiguous");
  assert.equal(runtimeAttributionForStrength("unknown"), "unknown");
  assert.throws(() => runtimeAttributionForStrength("maybe"), /unknown attribution strength/);
});

test("helpers expose repo absolute path, active ids, active status, and validation", () => {
  assert.equal(repoChangeAbsolutePath("/repo", "src/app.js"), "/repo/src/app.js");
  assert.deepEqual(
    activeSessionIdsForRepo({
      repoRoot: "/repo",
      sessions: [session({ id: "ses_active" }), session({ id: "ses_stopped", status: "stopped" })],
    }),
    ["ses_active"],
  );
  assert.equal(isActiveSession(session({ status: "running" })), true);
  assert.equal(isActiveSession(session({ status: "archived" })), false);
  assert.throws(() => classifyRepoChangeAttribution({ path: "x" }), /repoRoot is required/);
  assert.throws(() => classifyRepoChangeAttribution({ repoRoot: "/repo" }), /path is required/);
  assert.throws(
    () => classifyRepoChangeAttribution({ repoRoot: "/repo", path: "x", sessions: {} }),
    /sessions must be an array/,
  );
});
