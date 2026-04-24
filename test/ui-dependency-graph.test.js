import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDependencyGraphModel,
  layoutDependencyGraph
} from "../ui/app.js";
import { validProject } from "./fixtures.js";

test("buildDependencyGraphModel derives dependency edges from dependencies only", () => {
  const project = { data: validProject(), derived: { blocked: { t2: ["t1"] } } };
  const graph = buildDependencyGraphModel(project);

  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["t1", "t2", "t3"]
  );
  assert.ok(graph.edges.some((edge) => edge.kind === "dependency" && edge.from === "t1" && edge.to === "t2"));
  assert.ok(graph.nodes.some((node) => node.id === "t3"));
});

test("buildDependencyGraphModel ignores missing dependency ids defensively", () => {
  const data = validProject();
  data.tasks[0].dependencies = ["missing-task"];

  const graph = buildDependencyGraphModel({ data, derived: { blocked: {} } });

  assert.equal(graph.edges.some((edge) => edge.from === "missing-task"), false);
});

test("buildDependencyGraphModel filters nodes and removes hidden edges", () => {
  const project = { data: validProject(), derived: { blocked: { t2: ["t1"] } } };
  const graph = buildDependencyGraphModel(project, {
    statusFilters: new Set(["complete"])
  });

  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["t3"]
  );
  assert.deepEqual(graph.edges, []);
});

test("buildDependencyGraphModel keeps containment separate from dependencies", () => {
  const data = validProject();
  data.tasks[0].kind = "group";
  data.tasks[1].parent_id = "t1";

  const withoutContainment = buildDependencyGraphModel({ data, derived: { blocked: { t2: ["t1"] } } });
  const withContainment = buildDependencyGraphModel(
    { data, derived: { blocked: { t2: ["t1"] } } },
    { includeContainment: true }
  );

  assert.ok(withoutContainment.edges.every((edge) => edge.kind === "dependency"));
  assert.ok(withContainment.edges.some((edge) => edge.kind === "containment" && edge.from === "t1" && edge.to === "t2"));
});

test("layoutDependencyGraph returns numeric dagre positions", () => {
  const graph = buildDependencyGraphModel({
    data: validProject(),
    derived: { blocked: { t2: ["t1"] } }
  });
  const layout = layoutDependencyGraph(graph);

  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
  assert.equal(layout.nodes.length, 3);
  for (const node of layout.nodes) {
    assert.equal(Number.isFinite(node.x), true);
    assert.equal(Number.isFinite(node.y), true);
  }
  assert.ok(layout.edges.some((edge) => edge.points.length > 0));
});
