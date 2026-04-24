import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDependencyGraphModel,
  buildTreeModel,
  Card,
  collectTreeCollapseIds,
  computeDropTargetIndex,
  eventComesFromNestedControl,
} from "../ui/board-views.js";
import { validProject } from "./fixtures.js";

const matrixSource = readFileSync(new URL("../ui/matrix-view.js", import.meta.url), "utf8");
const treeSource = readFileSync(new URL("../ui/tree-view.js", import.meta.url), "utf8");
const graphSource = readFileSync(new URL("../ui/dependency-graph-view.js", import.meta.url), "utf8");

test("buildTreeModel direct export keeps swimlane fallback behavior", () => {
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

test("buildTreeModel direct export keeps explicit parent tree behavior", () => {
  const data = validProject();
  data.tasks.unshift({
    id: "g1",
    title: "Group 1",
    kind: "group",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p0" },
    dependencies: [],
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
  assert.deepEqual(collectTreeCollapseIds(model), ["task:g1"]);
});

test("buildDependencyGraphModel direct export keeps dependency and containment behavior", () => {
  const data = validProject();
  data.tasks[0].kind = "group";
  data.tasks[1].parent_id = "t1";

  const withoutContainment = buildDependencyGraphModel({
    data,
    derived: { blocked: { t2: ["t1"] } },
  });
  const withContainment = buildDependencyGraphModel(
    { data, derived: { blocked: { t2: ["t1"] } } },
    { includeContainment: true }
  );

  assert.deepEqual(
    withoutContainment.nodes.map((node) => node.id),
    ["t1", "t2", "t3"]
  );
  assert.ok(withoutContainment.edges.some((edge) =>
    edge.kind === "dependency" && edge.from === "t1" && edge.to === "t2"
  ));
  assert.ok(withoutContainment.edges.every((edge) => edge.kind === "dependency"));
  assert.ok(withContainment.edges.some((edge) =>
    edge.kind === "containment" && edge.from === "t1" && edge.to === "t2"
  ));
});

test("computeDropTargetIndex maps filtered drops into full destination order", () => {
  const tasks = ["a", "b", "c", "d"].map((id) => ({ id }));

  assert.equal(
    computeDropTargetIndex({ tasks, draggedTaskId: "x", beforeTaskId: "d" }),
    3
  );
  assert.equal(
    computeDropTargetIndex({ tasks, draggedTaskId: "x", afterTaskId: "b" }),
    2
  );
  assert.equal(
    computeDropTargetIndex({ tasks, draggedTaskId: "x", afterTaskId: "d" }),
    4
  );
  assert.equal(
    computeDropTargetIndex({ tasks, draggedTaskId: "b", beforeTaskId: "d" }),
    2
  );
});

test("Card Enter and Space key handlers ignore nested controls", () => {
  const task = {
    id: "t1",
    title: "Task 1",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p0" },
    dependencies: [],
    context: {},
  };
  let toggles = 0;
  const vnode = Card({
    task,
    blockedBy: [],
    onToggleExpand: () => {
      toggles += 1;
    },
  });
  const nestedControl = {};
  const nestedEvent = {
    key: "Enter",
    target: { closest: () => nestedControl },
    currentTarget: { contains: (node) => node === nestedControl },
    preventDefault: () => {
      throw new Error("nested control keydown should not be prevented by Card");
    },
  };

  assert.equal(eventComesFromNestedControl(nestedEvent), true);
  vnode.props.onKeyDown(nestedEvent);
  assert.equal(toggles, 0);

  let prevented = false;
  const cardTarget = {};
  vnode.props.onKeyDown({
    key: " ",
    target: cardTarget,
    currentTarget: cardTarget,
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(toggles, 1);
});

test("drawer mounts carry activeTaskMode and collapsed lane actions stop keydown", () => {
  const boardViewSource = `${matrixSource}\n${treeSource}\n${graphSource}`;
  const initialModeCount = boardViewSource.match(/initialMode=\$\{activeTaskMode \|\| "brief"\}/g)?.length || 0;

  assert.equal(initialModeCount, 4);
  assert.match(matrixSource, /class="lane-row__actions"[\s\S]*onKeyDown=\$\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(matrixSource, /eventComesFromNestedControl\(e\)[\s\S]*onToggleCollapse\(lane\.id, false\)/);
});
