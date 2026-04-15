import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecisionsPayload } from "../hub/decisions.js";
import { validProject } from "./fixtures.js";

test("buildDecisionsPayload returns recent decision notes with references and truncation", () => {
  const project = validProject();
  project.meta.rev = 11;
  project.tasks[0].comment = "Keep the endpoint deterministic";
  project.tasks[0].references = ["hub/next.js:1-40"];
  project.tasks[1].comment = "Handle linked trackers before semantic search";
  project.tasks[1].references = ["hub/store.js:1-20"];
  project.tasks.push({
    id: "t4",
    title: "Task 4",
    status: "not_started",
    placement: { swimlaneId: "ops", priorityId: "p1" },
    comment: "Do not break old patch files"
  });

  const history = [
    { rev: 7, delta: { tasks: { t1: { comment: "Keep the endpoint deterministic" } } } },
    { rev: 8, delta: { tasks: { t2: { comment: "Handle linked trackers before semantic search" } } } },
    { rev: 9, delta: { tasks: { t4: { comment: "Do not break old patch files" } } } }
  ];

  const payload = buildDecisionsPayload({
    slug: "test-project",
    data: project,
    history,
    limit: 2,
    now: "2026-04-15T12:00:00.000Z"
  });

  assert.equal(payload.packType, "decisions");
  assert.equal(payload.decisions.length, 2);
  assert.equal(payload.decisions[0].id, "t4");
  assert.equal(payload.decisions[0].selectedBecause, "task comment present");
  assert.equal(payload.decisions[1].references[0].selectedBecause, "task reference attached to the decision");
  assert.equal(payload.truncation.decisions.applied, true);
  assert.equal(payload.truncation.decisions.totalAvailable, 3);
});
