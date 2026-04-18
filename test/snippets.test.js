import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inferProjectRoot, loadReferenceSnippets, snippetCachePath } from "../hub/snippets.js";

function setupWorkspace(prefix) {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(workspace, ".runtime"), { recursive: true });
  return workspace;
}

test("loadReferenceSnippets resolves repo-linked trackers and refreshes cache when files change", () => {
  const workspace = setupWorkspace("llm-tracker-snippets-ws-");
  const repoRoot = mkdtempSync(join(tmpdir(), "llm-tracker-snippets-repo-"));

  try {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(join(repoRoot, ".llm-tracker", "trackers"), { recursive: true });

    const trackerPath = join(repoRoot, ".llm-tracker", "trackers", "test-project.json");
    const sourcePath = join(repoRoot, "src", "example.js");

    writeFileSync(trackerPath, "{}\n");
    writeFileSync(sourcePath, "one\ntwo\nthree\n");

    assert.equal(inferProjectRoot(workspace, trackerPath), realpathSync(repoRoot));

    const first = loadReferenceSnippets({
      workspace,
      slug: "test-project",
      trackerPath,
      references: ["src/example.js:2-3"],
      indexedAtRev: 7
    });

    assert.equal(first.snippets.length, 1);
    assert.equal(first.snippets[0].text, "two\nthree");
    assert.equal(first.snippets[0].indexedAtRev, 7);
    assert.match(first.snippets[0].hash, /^sha256:/);
    assert.equal(existsSync(snippetCachePath(workspace, "test-project")), true);

    const firstHash = first.snippets[0].hash;
    writeFileSync(sourcePath, "one\ntwo changed\nthree\n");

    const second = loadReferenceSnippets({
      workspace,
      slug: "test-project",
      trackerPath,
      references: ["src/example.js:2-3"],
      indexedAtRev: 8
    });

    assert.equal(second.snippets[0].text, "two changed\nthree");
    assert.equal(second.snippets[0].indexedAtRev, 8);
    assert.notEqual(second.snippets[0].hash, firstHash);

    const cache = JSON.parse(readFileSync(snippetCachePath(workspace, "test-project"), "utf-8"));
    assert.equal(cache.projectRoot, realpathSync(repoRoot));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadReferenceSnippets resolves repo-relative references for linked hidden tracker directories", () => {
  const workspace = setupWorkspace("llm-tracker-snippets-hidden-ws-");
  const repoRoot = mkdtempSync(join(tmpdir(), "llm-tracker-snippets-hidden-repo-"));

  try {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    mkdirSync(join(repoRoot, ".phalanx"), { recursive: true });

    const trackerPath = join(repoRoot, ".phalanx", "project-phalanx.json");
    const docsPath = join(repoRoot, "docs", "PHALANX_ROADMAP.md");

    writeFileSync(trackerPath, "{}\n");
    writeFileSync(docsPath, "alpha\nbeta\ngamma\n");

    assert.equal(inferProjectRoot(workspace, trackerPath), realpathSync(repoRoot));

    const result = loadReferenceSnippets({
      workspace,
      slug: "project-phalanx",
      trackerPath,
      references: ["docs/PHALANX_ROADMAP.md:2-3"],
      indexedAtRev: 11
    });

    assert.equal(result.snippets.length, 1);
    assert.equal(result.projectRoot, realpathSync(repoRoot));
    assert.equal(result.snippets[0].text, "beta\ngamma");
    assert.equal(result.snippets[0].indexedAtRev, 11);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadReferenceSnippets returns graceful errors for stale references", () => {
  const workspace = setupWorkspace("llm-tracker-snippets-stale-ws-");
  const repoRoot = mkdtempSync(join(tmpdir(), "llm-tracker-snippets-stale-repo-"));

  try {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(join(repoRoot, ".llm-tracker", "trackers"), { recursive: true });

    const trackerPath = join(repoRoot, ".llm-tracker", "trackers", "test-project.json");
    writeFileSync(trackerPath, "{}\n");
    writeFileSync(join(repoRoot, "src", "tiny.js"), "alpha\n");

    const result = loadReferenceSnippets({
      workspace,
      slug: "test-project",
      trackerPath,
      references: ["src/tiny.js:5-6"],
      indexedAtRev: 3
    });

    assert.equal(result.snippets.length, 1);
    assert.equal(result.snippets[0].text, "");
    assert.match(result.snippets[0].error, /stale reference/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
