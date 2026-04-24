import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTreeModel, collectTreeCollapseIds } from "../ui/app.js";
import { validProject } from "./fixtures.js";

test("buildTreeModel falls back to swimlanes when no explicit groups exist", () => {
  const data = validProject();
  const model = buildTreeModel({ data });

  assert.equal(model.mode, "swimlane");
  assert.deepEqual(
    model.roots.map((root) => root.id),
    ["swimlane:exec", "swimlane:ops"]
  );
  assert.deepEqual(
    model.roots.find((root) => root.lane.id === "exec").tasks.map((task) => task.id),
    ["t1", "t2"]
  );
  assert.deepEqual(collectTreeCollapseIds(model), ["swimlane:exec", "swimlane:ops"]);
});

test("buildTreeModel uses kind group and parent_id for explicit task trees", () => {
  const data = validProject();
  data.tasks.unshift({
    id: "g1",
    title: "Group 1",
    kind: "group",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p0" },
    dependencies: []
  });
  data.tasks.find((task) => task.id === "t1").parent_id = "g1";
  data.tasks.find((task) => task.id === "t2").parent_id = "g1";

  const model = buildTreeModel({ data });

  assert.equal(model.mode, "explicit");
  assert.ok(model.roots.some((task) => task.id === "g1"));
  assert.deepEqual(
    model.childrenByParent.get("g1").map((task) => task.id),
    ["t1", "t2"]
  );
});

test("collectTreeCollapseIds includes nested explicit groups", () => {
  const data = validProject();
  data.tasks.unshift(
    {
      id: "g1",
      title: "Group 1",
      kind: "group",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: []
    },
    {
      id: "g2",
      title: "Nested Group 2",
      kind: "group",
      parent_id: "g1",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: []
    }
  );
  data.tasks.find((task) => task.id === "t1").parent_id = "g2";
  data.tasks.find((task) => task.id === "t2").parent_id = "g1";

  const model = buildTreeModel({ data });

  assert.equal(model.mode, "explicit");
  assert.deepEqual(collectTreeCollapseIds(model), ["task:g1", "task:g2"]);
});
