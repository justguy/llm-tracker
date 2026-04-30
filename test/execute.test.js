import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutePayload } from "../hub/execute.js";
import { validProject } from "./fixtures.js";

test("buildExecutePayload augments brief context with execution contract and plan", () => {
  const project = validProject();
  project.meta.rev = 15;
  project.tasks[0].goal = "Ship execution packs";
  project.tasks[0].comment = "Use deterministic execution data";
  project.tasks[0].references = ["hub/briefs.js:1-40"];
  project.tasks[0].definition_of_done = ["CLI and HTTP output match"];
  project.tasks[0].constraints = ["Do not break legacy trackers"];
  project.tasks[0].expected_changes = ["hub/execute.js", "bin/commands/execute.js"];
  project.tasks[0].allowed_paths = ["hub/execute.js", "bin/commands/execute.js"];
  project.tasks[0].approval_required_for = ["new dependencies"];

  const payload = buildExecutePayload({
    slug: "test-project",
    data: project,
    history: [{ rev: 14, delta: { tasks: { t1: { comment: "Use deterministic execution data" } } }, summary: ["task 1 note"] }],
    taskId: "t1",
    references: [{ value: "hub/briefs.js:1-40", selectedBecause: "explicit task reference" }],
    snippets: [
      {
        id: "briefs_1_40",
        reference: "hub/briefs.js:1-40",
        path: "hub/briefs.js",
        startLine: 1,
        endLine: 40,
        text: "export function buildBriefPayload() {}",
        hash: "sha256:test",
        indexedAtRev: 15
      }
    ],
    now: "2026-04-16T00:00:00.000Z"
  });

  assert.equal(payload.packType, "execute");
  assert.equal(payload.readiness.actionability, "decision_gated");
  assert.deepEqual(payload.readiness.decision_required, ["new dependencies"]);
  assert.equal(payload.executionContract.definition_of_done[0], "CLI and HTTP output match");
  assert.ok(payload.executionPlan.some((item) => item.kind === "decision_required"));
  assert.ok(payload.executionPlan.some((item) => item.kind === "expected_change"));
  assert.ok(payload.executionPlan.some((item) => item.kind === "approval"));
  assert.equal(payload.references[0].selectedBecause, "explicit task reference");
});
