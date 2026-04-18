import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeProject, stableEq } from "../hub/merge.js";
import { validProject } from "./fixtures.js";

test("mergeProject with no existing returns incoming", () => {
  const p = validProject();
  const { merged } = mergeProject(null, p);
  assert.deepEqual(merged, p);
});

test("mergeProject preserves existing array order when LLM reorders", () => {
  const existing = validProject();
  const reordered = JSON.parse(JSON.stringify(existing));
  // LLM reorders [t1, t2, t3] -> [t3, t2, t1]
  reordered.tasks = [reordered.tasks[2], reordered.tasks[1], reordered.tasks[0]];
  const { merged } = mergeProject(existing, reordered);
  assert.deepEqual(
    merged.tasks.map((t) => t.id),
    ["t1", "t2", "t3"]
  );
});

test("mergeProject refuses to delete tasks missing from a full-write", () => {
  const existing = validProject();
  const shrunk = JSON.parse(JSON.stringify(existing));
  shrunk.tasks = shrunk.tasks.filter((t) => t.id !== "t2");
  const { merged, notes } = mergeProject(existing, shrunk);
  assert.equal(merged.tasks.length, 3);
  assert.ok(merged.tasks.some((t) => t.id === "t2"));
  assert.ok(notes.warnings.some((w) => w.includes("t2")));
});

test("mergeProject appends new tasks at the end", () => {
  const existing = validProject();
  const incoming = JSON.parse(JSON.stringify(existing));
  incoming.tasks.push({
    id: "t4",
    title: "Task 4",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p0" }
  });
  const { merged, notes } = mergeProject(existing, incoming);
  assert.equal(merged.tasks[merged.tasks.length - 1].id, "t4");
  assert.ok(notes.appended.includes("t4"));
});

test("mergeProject partial patch (object-keyed tasks) updates only listed tasks", () => {
  const existing = validProject();
  const patch = {
    tasks: {
      t1: { status: "complete", context: { notes: "done" } }
    }
  };
  const { merged } = mergeProject(existing, patch);
  const t1 = merged.tasks.find((t) => t.id === "t1");
  const t2 = merged.tasks.find((t) => t.id === "t2");
  assert.equal(t1.status, "complete");
  assert.equal(t1.context.notes, "done");
  // context merge preserves existing keys
  assert.deepEqual(t1.context.tags, ["alpha"]);
  // Other tasks untouched
  assert.equal(t2.status, "in_progress");
  assert.equal(merged.tasks.length, 3);
});

test("mergeProject preserves human-owned collapsed on swimlane", () => {
  const existing = validProject();
  existing.meta.swimlanes[0].collapsed = true;

  const incoming = JSON.parse(JSON.stringify(existing));
  incoming.meta.swimlanes[0].collapsed = false; // LLM tries to expand

  const { merged, notes } = mergeProject(existing, incoming);
  assert.equal(merged.meta.swimlanes[0].collapsed, true);
  assert.ok(notes.ignored.some((s) => s.includes("collapsed")));
});

test("mergeProject strips collapsed from LLM's new swimlanes (hub-owned)", () => {
  const existing = validProject();
  const incoming = JSON.parse(JSON.stringify(existing));
  incoming.meta.swimlanes[1].collapsed = true; // LLM tries to collapse

  const { merged, notes } = mergeProject(existing, incoming);
  assert.ok(!("collapsed" in merged.meta.swimlanes[1]));
  assert.ok(notes.ignored.some((s) => s.includes("collapsed")));
});

test("mergeProject allows LLM to change placement.priorityId", () => {
  const existing = validProject();
  const patch = {
    tasks: {
      t1: { placement: { priorityId: "p1" } }
    }
  };
  const { merged } = mergeProject(existing, patch);
  const t1 = merged.tasks.find((t) => t.id === "t1");
  assert.equal(t1.placement.priorityId, "p1");
  assert.equal(t1.placement.swimlaneId, "exec"); // preserved
});

test("mergeProject ignores attempted updatedAt / rev writes", () => {
  const existing = validProject();
  const patch = {
    meta: { updatedAt: "2099-01-01T00:00:00Z" },
    tasks: { t1: { rev: 999 } }
  };
  const { merged, notes } = mergeProject(existing, patch);
  assert.notEqual(merged.meta.updatedAt, "2099-01-01T00:00:00Z");
  const t1 = merged.tasks.find((t) => t.id === "t1");
  assert.notEqual(t1.rev, 999);
  assert.ok(notes.ignored.some((s) => s.includes("updatedAt") || s.includes("rev")));
});

test("stableEq reports structural equality", () => {
  const a = { x: 1, y: [1, 2] };
  const b = { x: 1, y: [1, 2] };
  const c = { x: 1, y: [2, 1] };
  assert.equal(stableEq(a, b), true);
  assert.equal(stableEq(a, c), false);
});
