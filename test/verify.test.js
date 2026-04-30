import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerifyPayload } from "../hub/verify.js";
import { validProject } from "./fixtures.js";

test("buildVerifyPayload derives evidence sources and deterministic checks", () => {
  const project = validProject();
  project.meta.rev = 18;
  project.tasks[0].status = "complete";
  project.tasks[0].references = ["hub/verify.js:1-40"];
  project.tasks[0].definition_of_done = ["Payload includes real evidence sources"];
  project.tasks[0].expected_changes = ["hub/verify.js"];
  project.tasks[0].allowed_paths = ["hub/verify.js"];
  project.tasks[0].context = {
    ...project.tasks[0].context,
    architecture_truth_doc: "Verification architecture",
    architecture_reference: "ARCHITECTURE.md:300-330"
  };

  const payload = buildVerifyPayload({
    slug: "test-project",
    data: project,
    history: [{ rev: 17, delta: { tasks: { t1: { status: "complete" } } }, summary: ["task 1 completed"] }],
    taskId: "t1",
    references: [{ value: "hub/verify.js:1-40", selectedBecause: "explicit task reference" }],
    snippets: [
      {
        id: "verify_1_40",
        reference: "hub/verify.js:1-40",
        path: "hub/verify.js",
        startLine: 1,
        endLine: 40,
        text: "export function buildVerifyPayload() {}",
        hash: "sha256:test",
        indexedAtRev: 18
      }
    ],
    now: "2026-04-16T00:00:00.000Z"
  });

  assert.equal(payload.packType, "verify");
  assert.equal(payload.evidenceSources.taskState.actionability, "parked");
  assert.equal(payload.evidenceSources.taskState.selectedBecause, "current task state");
  assert.equal(payload.evidenceSources.traceability.architecture.title, "Verification architecture");
  assert.equal(payload.evidenceSources.traceability.architecture.reference, "ARCHITECTURE.md:300-330");
  assert.equal(payload.evidenceSources.references[0].selectedBecause, "explicit task reference");
  assert.ok(payload.checks.some((check) => check.kind === "definition_of_done"));
  assert.ok(payload.checks.some((check) => check.kind === "expected_change"));
});
