import { test } from "node:test";
import assert from "node:assert/strict";

import { outsideAllowedPathsRule } from "../hub/attention/rules/outside_allowed_paths.js";
import {
  allowedPathGlobToRegExp,
  annotateRepoChangeWithAllowedPaths,
  createAllowedPathMatcher,
  evaluateAllowedPathForRepoChange,
  isValidAllowedPathPattern,
  normalizeAllowedPathPatterns,
  pathMatchesAllowedPath,
  repoRelativeChangedPath,
} from "../hub/workspaces/allowed-paths.js";

function task(overrides = {}) {
  return {
    id: "task-1",
    repos: {
      primary: { root: "/repo", allowed_paths: ["src/**", "test/*.test.js", "README.md"] },
    },
    ...overrides,
  };
}

function repoChange(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "evt_1",
    ts: "2026-05-26T16:00:00.000Z",
    type: "repo.change",
    source: "watcher",
    workspace: "/workspace",
    projectSlug: "demo",
    repoRoot: "/repo",
    path: "src/app.js",
    event: "change",
    activeSessionIds: ["ses_1"],
    possibleSessionIds: ["ses_1"],
    attribution: "single_active_session",
    relatedTaskIds: ["task-1"],
    ...overrides,
  };
}

test("repoRelativeChangedPath normalizes absolute and relative paths under repo root", () => {
  assert.equal(repoRelativeChangedPath("/repo", "/repo/src/app.js"), "src/app.js");
  assert.equal(repoRelativeChangedPath("/repo", "./src/app.js"), "src/app.js");
  assert.equal(repoRelativeChangedPath("/repo", "/other/app.js"), null);
});

test("pathMatchesAllowedPath shares preflight glob semantics", () => {
  assert.equal(pathMatchesAllowedPath("src/app.js", "src/**"), true);
  assert.equal(pathMatchesAllowedPath("src/deep/app.js", "src/**"), true);
  assert.equal(pathMatchesAllowedPath("test/unit.test.js", "test/*.test.js"), true);
  assert.equal(pathMatchesAllowedPath("test/deep/unit.test.js", "test/*.test.js"), false);
  assert.equal(pathMatchesAllowedPath("docs/readme.md", "docs/*.md"), true);
  assert.equal(pathMatchesAllowedPath("docs/deep/readme.md", "docs/*.md"), false);
  assert.equal(pathMatchesAllowedPath("docs/a.md", "docs/?.md"), true);
  assert.equal(pathMatchesAllowedPath("docs/ab.md", "docs/?.md"), false);
  assert.equal(pathMatchesAllowedPath("README.md", "README.md"), true);
  assert.equal(pathMatchesAllowedPath("README.md/child", "README.md"), true);
  assert.equal(pathMatchesAllowedPath("any/depth/file.js", "*"), true);
  assert.equal(allowedPathGlobToRegExp("**/*.js").test("src/app.js"), true);
});

test("invalid allowed_path patterns are not matchable and are filtered", () => {
  for (const pattern of [
    "/abs/file.js",
    "../outside.js",
    "src/../outside.js",
    "src\\app.js",
    "C:/Users/me/secrets",
    "C:Users/me/secrets",
    "https://example.com/src/**",
    `bad\0path`,
  ]) {
    assert.equal(isValidAllowedPathPattern(pattern), false, pattern);
    assert.equal(pathMatchesAllowedPath("src/app.js", pattern), false, pattern);
  }
  assert.deepEqual(normalizeAllowedPathPatterns(["src/**", "src/**", "/abs", "docs/*.md"]), [
    "src/**",
    "docs/*.md",
  ]);
  assert.throws(() => allowedPathGlobToRegExp("/abs"), /valid repo-relative glob/);
});

test("evaluateAllowedPathForRepoChange reports matched changes inside allowed_paths", () => {
  const result = evaluateAllowedPathForRepoChange({
    task: task(),
    repoRoot: "/repo",
    path: "/repo/src/app.js",
  });

  assert.equal(result.changedPath, "src/app.js");
  assert.equal(result.hasAllowedPaths, true);
  assert.equal(result.matched, true);
  assert.equal(result.outsideAllowedPaths, false);
  assert.equal(result.reason, "allowed_path_matched");
});

test("absent allowed_paths never creates an outside_allowed_paths warning", () => {
  const result = evaluateAllowedPathForRepoChange({
    task: task({ repos: { primary: { root: "/repo" } } }),
    repoRoot: "/repo",
    path: "src/app.js",
  });
  const applied = annotateRepoChangeWithAllowedPaths(repoChange(), task({ repos: { primary: { root: "/repo" } } }));

  assert.equal(result.hasAllowedPaths, false);
  assert.equal(result.outsideAllowedPaths, false);
  assert.equal(result.reason, "allowed_paths_absent");
  assert.equal(applied.event.outsideAllowedPaths, undefined);
  assert.equal(applied.conflict, null);
});

test("legacy task allowed_paths are fallback when repo refs omit allowed_paths", () => {
  const legacyFallback = evaluateAllowedPathForRepoChange({
    task: task({
      allowed_paths: ["legacy/**"],
      repos: { primary: { root: "/repo" } },
    }),
    repoRoot: "/repo",
    path: "legacy/file.js",
  });
  assert.equal(legacyFallback.hasAllowedPaths, true);
  assert.equal(legacyFallback.matched, true);
  assert.deepEqual(legacyFallback.patterns, ["legacy/**"]);

  const repoRefWins = evaluateAllowedPathForRepoChange({
    task: task({
      allowed_paths: ["legacy/**"],
      repos: { primary: { root: "/repo", allowed_paths: ["src/**"] } },
    }),
    repoRoot: "/repo",
    path: "legacy/file.js",
  });
  assert.equal(repoRefWins.hasAllowedPaths, true);
  assert.equal(repoRefWins.matched, false);
  assert.deepEqual(repoRefWins.patterns, ["src/**"]);
});

test("present allowed_paths with no match annotates RepoChangeEvent and builds conflict evidence", () => {
  const event = repoChange({ id: "evt_2", path: "scripts/deploy.sh" });
  const applied = annotateRepoChangeWithAllowedPaths(event, task());

  assert.equal(applied.result.outsideAllowedPaths, true);
  assert.equal(applied.event.outsideAllowedPaths, true);
  assert.deepEqual(applied.conflict, {
    id: "evt_2:outside_allowed_paths",
    kind: "outside_allowed_paths",
    projectSlug: "demo",
    taskId: "task-1",
    paths: ["scripts/deploy.sh"],
    path: "scripts/deploy.sh",
    eventId: "evt_2",
    evidenceRef: "evt_2",
    repoRoot: "/repo",
    allowedPaths: ["src/**", "test/*.test.js", "README.md"],
  });
});

test("outside_allowed_paths conflict can feed the attention rule", () => {
  const { conflict } = annotateRepoChangeWithAllowedPaths(
    repoChange({ id: "evt_3", path: "scripts/deploy.sh" }),
    task(),
  );
  const items = outsideAllowedPathsRule({
    conflicts: [conflict],
    now: new Date("2026-05-26T16:00:00.000Z"),
    makeId: () => "att_1",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "outside_allowed_paths");
  assert.equal(items[0].severity, "critical");
  assert.equal(items[0].source, "watcher_git");
  assert.equal(items[0].evidenceRef, "evt_3:outside_allowed_paths");
});

test("matcher treats missing allowed_paths as unconstrained and present empty as constrained", () => {
  const absent = createAllowedPathMatcher(undefined);
  assert.equal(absent.hasAllowedPaths, false);
  assert.equal(absent.matches("anything.js"), true);

  const empty = createAllowedPathMatcher([]);
  assert.equal(empty.hasAllowedPaths, true);
  assert.equal(empty.matches("anything.js"), false);
});
