import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPickedPayload, resolvePickSelection } from "../hub/pick.js";
import { validProject } from "./fixtures.js";

test("resolvePickSelection auto-selects the top ready task", () => {
  const project = validProject();
  project.meta.rev = 7;

  const result = resolvePickSelection({
    slug: "test-project",
    data: project,
    history: []
  });

  assert.equal(result.ok, true);
  assert.equal(result.autoSelected, true);
  assert.equal(result.taskId, "t1");
});

test("resolvePickSelection rejects blocked tasks unless forced", () => {
  const project = validProject();

  const blocked = resolvePickSelection({
    slug: "test-project",
    data: project,
    taskId: "t2"
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);

  const forced = resolvePickSelection({
    slug: "test-project",
    data: project,
    taskId: "t2",
    force: true
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.taskId, "t2");
});

test("resolvePickSelection skips container rows when auto-selecting", () => {
  const project = validProject();
  project.tasks = [
    {
      id: "g1",
      kind: "group",
      title: "Container group",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: []
    },
    {
      id: "parent",
      title: "Parent row",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: []
    },
    {
      id: "child",
      title: "Executable child",
      status: "not_started",
      parent_id: "parent",
      placement: { swimlaneId: "exec", priorityId: "p1" },
      dependencies: []
    }
  ];

  const result = resolvePickSelection({
    slug: "test-project",
    data: project
  });

  assert.equal(result.ok, true);
  assert.equal(result.taskId, "child");

  const group = resolvePickSelection({
    slug: "test-project",
    data: project,
    taskId: "g1"
  });
  assert.equal(group.ok, false);
  assert.equal(group.status, 409);
});

test("resolvePickSelection refuses in-progress tasks owned by another assignee", () => {
  const project = validProject();

  const conflict = resolvePickSelection({
    slug: "test-project",
    data: project,
    taskId: "t2",
    assignee: "codex",
    force: true
  });
  assert.equal(conflict.ok, true);

  const noAssignee = resolvePickSelection({
    slug: "test-project",
    data: project,
    taskId: "t2"
  });
  assert.equal(noAssignee.ok, false);
  assert.equal(noAssignee.status, 409);
});

test("buildPickedPayload returns normalized task state", () => {
  const project = validProject();
  project.meta.rev = 8;
  project.tasks[0].status = "in_progress";
  project.tasks[0].assignee = "codex";
  project.tasks[0].reference = "hub/store.js:1-20";

  const payload = buildPickedPayload({
    slug: "test-project",
    data: project,
    history: [{ rev: 8, delta: { tasks: { t1: { status: "in_progress", assignee: "codex" } } } }],
    taskId: "t1",
    autoSelected: true,
    selectedBecause: "top ready task from next ranking"
  });

  assert.equal(payload.pickedTaskId, "t1");
  assert.equal(payload.task.assignee, "codex");
  assert.deepEqual(payload.task.references, ["hub/store.js:1-20"]);
});
