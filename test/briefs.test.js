import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBriefPayload, getBriefPayload } from "../hub/briefs.js";
import { validProject } from "./fixtures.js";

test("buildBriefPayload caps snippets and history within deterministic budgets", () => {
  const project = validProject();
  project.meta.rev = 12;
  project.tasks[0].goal = "Focus the work on one deterministic pack";
  project.tasks[0].related = ["t2"];

  const references = Array.from({ length: 6 }, (_, index) => ({
    value: `src/file${index}.js:1-1`,
    selectedBecause: "explicit task reference"
  }));
  const snippets = references.map((reference, index) => ({
    id: `snippet-${index}`,
    reference: reference.value,
    path: `src/file${index}.js`,
    startLine: 1,
    endLine: 1,
    text: "x".repeat(2000),
    hash: `sha256:${index}`,
    indexedAtRev: 12
  }));
  const history = Array.from({ length: 4 }, (_, index) => ({
    rev: index + 1,
    ts: `2026-04-15T00:0${index}:00.000Z`,
    delta: { tasks: { t1: { comment: `note ${index}` } } },
    summary: [`update ${index}`]
  }));

  const payload = buildBriefPayload({
    slug: "test-project",
    data: project,
    history,
    taskId: "t1",
    references,
    snippets,
    now: "2026-04-15T12:00:00.000Z"
  });

  assert.equal(payload.packType, "brief");
  assert.equal(payload.task.id, "t1");
  assert.equal(payload.relatedTasks[0].id, "t2");
  assert.equal(payload.snippets.length, 4);
  assert.equal(payload.truncation.snippets.applied, true);
  assert.equal(payload.truncation.snippets.byteCapped, true);
  assert.equal(payload.recentHistory.length, 3);
  assert.equal(payload.truncation.history.applied, true);
  assert.equal(payload.snippets[0].selectedBecause, "explicit task reference");
});

test("getBriefPayload falls back to dependency references and writes snippet cache", () => {
  const workspace = mkdtempSync(join(tmpdir(), "llm-tracker-briefs-ws-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "llm-tracker-briefs-repo-"));

  try {
    for (const sub of [".history", ".runtime"]) {
      mkdirSync(join(workspace, sub), { recursive: true });
    }
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(join(repoRoot, ".llm-tracker", "trackers"), { recursive: true });

    const sourcePath = join(repoRoot, "src", "example.js");
    writeFileSync(sourcePath, "alpha\nbeta\ngamma\ndelta\n");

    const project = validProject();
    project.meta.rev = 7;
    project.tasks[0].references = ["src/example.js:2-3"];
    delete project.tasks[1].reference;
    delete project.tasks[1].references;
    project.tasks[1].related = ["t1"];

    const trackerPath = join(repoRoot, ".llm-tracker", "trackers", "test-project.json");
    writeFileSync(trackerPath, JSON.stringify(project, null, 2));
    writeFileSync(
      join(workspace, ".history", "test-project.jsonl"),
      [
        JSON.stringify({
          rev: 5,
          ts: "2026-04-15T00:00:00.000Z",
          delta: { tasks: { t2: { status: "in_progress" } } },
          summary: ["task 2 started"]
        }),
        JSON.stringify({
          rev: 6,
          ts: "2026-04-15T00:01:00.000Z",
          delta: { tasks: { t2: { comment: "Need task 1 context" } } },
          summary: ["task 2 note updated"]
        })
      ].join("\n") + "\n"
    );

    const result = getBriefPayload({
      workspace,
      slug: "test-project",
      entry: { data: project, path: trackerPath, rev: 7 },
      taskId: "t2",
      now: "2026-04-15T12:00:00.000Z"
    });

    assert.equal(result.ok, true);
    assert.equal(result.payload.references[0].selectedBecause, "dependency reference from t1");
    assert.equal(result.payload.snippets[0].text, "beta\ngamma");
    assert.equal(result.payload.recentHistory.length, 2);
    assert.equal(result.payload.relatedTasks[0].id, "t1");
    assert.equal(existsSync(join(workspace, ".runtime", "snippets", "test-project.json")), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
