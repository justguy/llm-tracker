import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNextPayload } from "../hub/next.js";
import { validProject } from "./fixtures.js";

function projectWithPriorities() {
  const project = validProject();
  project.meta.priorities = [
    { id: "p0", label: "P0 / Now" },
    { id: "p1", label: "P1 / Next" },
    { id: "p2", label: "P2 / Soon" },
    { id: "p3", label: "P3 / Later" }
  ];
  project.meta.rev = 12;
  return project;
}

test("buildNextPayload ranks ready tasks before blocked tasks and normalizes legacy reference", () => {
  const project = projectWithPriorities();
  project.tasks[0].comment = "Highest-priority ready task";
  project.tasks[0].reference = "hub/store.js:1-20";
  project.tasks[0].effort = "s";
  project.tasks[1].comment = "Blocked until task 1 completes";
  project.tasks[1].references = ["hub/server.js:1-40"];
  project.tasks.push({
    id: "t4",
    title: "Task 4",
    status: "not_started",
    placement: { swimlaneId: "ops", priorityId: "p1" },
    dependencies: [],
    effort: "m"
  });

  const payload = buildNextPayload({
    slug: "test-project",
    data: project,
    history: [
      { rev: 10, delta: { tasks: { t1: { status: "in_progress" } } } },
      { rev: 11, delta: { tasks: { t2: { comment: "blocked" } } } }
    ]
  });

  assert.equal(payload.recommendedTaskId, "t1");
  assert.deepEqual(
    payload.next.map((task) => task.id),
    ["t1", "t4", "t2"]
  );
  assert.deepEqual(payload.next[0].references, ["hub/store.js:1-20"]);
  assert.equal(payload.next[0].ready, true);
  assert.equal(payload.next[0].lastTouchedRev, 10);
  assert.equal(payload.next[2].ready, false);
  assert.equal(payload.next[2].blocked_kind, "deps");
  assert.deepEqual(payload.next[2].blocking_on, ["t1"]);
});

test("buildNextPayload uses effort and approval to break ties among ready tasks", () => {
  const project = projectWithPriorities();
  project.tasks = [
    {
      id: "t1",
      title: "Fast task",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: [],
      effort: "xs"
    },
    {
      id: "t2",
      title: "Slow task",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: [],
      effort: "xl",
      approval_required_for: ["new dependencies"]
    }
  ];

  const payload = buildNextPayload({
    slug: "test-project",
    data: project
  });

  assert.deepEqual(
    payload.next.map((task) => task.id),
    ["t1", "t2"]
  );
  assert.ok(payload.next[1].reason.some((reason) => reason.includes("requires approval")));
});
