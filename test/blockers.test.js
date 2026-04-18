import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBlockersPayload } from "../hub/blockers.js";
import { validProject } from "./fixtures.js";

test("buildBlockersPayload returns blocked tasks and reverse blocking detail", () => {
  const project = validProject();
  project.tasks[1].comment = "Waiting on task 1";
  project.tasks[1].blocker_reason = "Need task 1 complete first";

  const payload = buildBlockersPayload({
    slug: "test-project",
    data: project,
    history: [{ rev: 3, delta: { tasks: { t2: { blocker_reason: "Need task 1 complete first" } } } }]
  });

  assert.equal(payload.blocked.length, 1);
  assert.equal(payload.blocked[0].id, "t2");
  assert.deepEqual(payload.blocked[0].blocking_on, ["t1"]);
  assert.equal(payload.blocked[0].blocking_task_details[0].id, "t1");

  assert.equal(payload.blocking.length, 1);
  assert.equal(payload.blocking[0].id, "t1");
  assert.equal(payload.blocking[0].blockedCount, 1);
  assert.deepEqual(payload.blocking[0].blocks.map((task) => task.id), ["t2"]);
});

test("buildBlockersPayload ignores complete and deferred tasks", () => {
  const project = validProject();
  project.tasks[1].status = "complete";
  project.tasks.push({
    id: "t4",
    title: "Deferred blocked task",
    status: "deferred",
    placement: { swimlaneId: "ops", priorityId: "p1" },
    dependencies: ["t1"]
  });

  const payload = buildBlockersPayload({
    slug: "test-project",
    data: project
  });

  assert.deepEqual(payload.blocked, []);
  assert.deepEqual(payload.blocking, []);
});
