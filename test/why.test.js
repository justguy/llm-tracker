import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWhyPayload } from "../hub/why.js";
import { validProject } from "./fixtures.js";

test("buildWhyPayload explains why a task matters, what it unblocks, and recent history", () => {
  const project = validProject();
  project.meta.rev = 9;
  project.tasks[0].goal = "Ship the first live task pack";
  project.tasks[0].comment = "Needed before downstream automation can run";
  project.tasks[0].reference = "hub/store.js:1-20";
  project.tasks.push({
    id: "t4",
    title: "Task 4",
    status: "not_started",
    placement: { swimlaneId: "ops", priorityId: "p1" },
    dependencies: ["t1"]
  });

  const history = [
    { rev: 5, ts: "2026-04-15T00:00:00.000Z", delta: { tasks: { t1: { comment: "first note" } } }, summary: ["task 1 note"] },
    { rev: 6, ts: "2026-04-15T00:01:00.000Z", delta: { tasks: { t1: { status: "in_progress" } } }, summary: ["task 1 started"] },
    { rev: 7, ts: "2026-04-15T00:02:00.000Z", delta: { tasks: { t1: { status: "not_started" } } }, summary: ["task 1 reset"] },
    { rev: 8, ts: "2026-04-15T00:03:00.000Z", delta: { tasks: { t1: { comment: "Needed before downstream automation can run" } } }, summary: ["task 1 note updated"] }
  ];

  const payload = buildWhyPayload({
    slug: "test-project",
    data: project,
    history,
    taskId: "t1",
    now: "2026-04-15T12:00:00.000Z"
  });

  assert.equal(payload.packType, "why");
  assert.equal(payload.task.id, "t1");
  assert.equal(payload.task.actionability, "executable");
  assert.ok(payload.why.some((reason) => reason.kind === "decision_note"));
  assert.ok(payload.why.some((reason) => reason.kind === "unblocks" && reason.text.includes("t2")));
  assert.ok(payload.why.some((reason) => reason.kind === "unblocks" && reason.text.includes("t4")));
  assert.equal(payload.references[0].selectedBecause, "explicit task reference");
  assert.equal(payload.unblocks.length, 2);
  assert.equal(payload.recentHistory.length, 3);
  assert.equal(payload.truncation.history.applied, true);
});
