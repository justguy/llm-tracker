import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, trackerPath, errorPath } from "../hub/store.js";
import { validProject } from "./fixtures.js";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-test-"));
  for (const sub of ["trackers", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  return ws;
}

test("ingest valid project populates store and clears errors", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    const res = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(res.ok, true);
    assert.equal(res.event, "UPDATE");
    const entry = store.get("test-project");
    assert.equal(entry.data.meta.slug, "test-project");
    assert.equal(entry.derived.total, 3);
    assert.equal(existsSync(errorPath(ws, "test-project")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ingest invalid JSON writes error file", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "broken");
    writeFileSync(file, "{ not json");
    const res = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(res.ok, false);
    assert.equal(res.event, "ERROR");
    assert.ok(existsSync(errorPath(ws, "broken")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyMove: cross-cell preserves other tasks' placements", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyMove("test-project", {
      taskId: "t1",
      swimlaneId: "ops",
      priorityId: "p1",
      targetIndex: 0
    });
    assert.equal(res.ok, true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    const t1 = after.tasks.find((t) => t.id === "t1");
    const t2 = after.tasks.find((t) => t.id === "t2");
    const t3 = after.tasks.find((t) => t.id === "t3");
    assert.deepEqual(t1.placement, { swimlaneId: "ops", priorityId: "p1" });
    assert.deepEqual(t2.placement, { swimlaneId: "exec", priorityId: "p0" });
    assert.deepEqual(t3.placement, { swimlaneId: "ops", priorityId: "p1" });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyMove: within-cell reorder puts task at targetIndex", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    p.tasks.push({
      id: "t4",
      title: "Task 4",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" }
    });
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    // Move t4 to index 0 within the exec/p0 cell (should come before t1 and t2).
    const res = await store.applyMove("test-project", {
      taskId: "t4",
      swimlaneId: "exec",
      priorityId: "p0",
      targetIndex: 0
    });
    assert.equal(res.ok, true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    const execP0 = after.tasks.filter(
      (t) => t.placement.swimlaneId === "exec" && t.placement.priorityId === "p0"
    );
    assert.deepEqual(
      execP0.map((t) => t.id),
      ["t4", "t1", "t2"]
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyMove rejects unknown swimlane", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyMove("test-project", {
      taskId: "t1",
      swimlaneId: "ghost",
      priorityId: "p0",
      targetIndex: 0
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: updates only the fields the patch mentions", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      tasks: { t1: { status: "complete", context: { notes: "shipped" } } }
    });
    assert.equal(res.ok, true);
    const after = JSON.parse(readFileSync(file, "utf-8"));
    const t1 = after.tasks.find((t) => t.id === "t1");
    assert.equal(t1.status, "complete");
    assert.equal(t1.context.notes, "shipped");
    // tags preserved (context shallow-merged)
    assert.deepEqual(t1.context.tags, ["alpha"]);
    // t2 untouched
    const t2 = after.tasks.find((t) => t.id === "t2");
    assert.equal(t2.status, "in_progress");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: 404 when project doesn't exist", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const res = await store.applyPatch("nonexistent", { tasks: { t1: { status: "complete" } } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ingest: direct-file-edit that reorders is corrected back to existing order", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    const data = validProject();
    writeFileSync(file, JSON.stringify(data));
    store.ingest(file, readFileSync(file, "utf-8"));

    const reordered = JSON.parse(JSON.stringify(data));
    reordered.tasks = [reordered.tasks[2], reordered.tasks[0], reordered.tasks[1]];
    writeFileSync(file, JSON.stringify(reordered));
    store.ingest(file, readFileSync(file, "utf-8"));

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(onDisk.tasks.map((t) => t.id), ["t1", "t2", "t3"]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyCollapse: flips swimlane collapsed flag", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const r1 = await store.applyCollapse("test-project", { swimlaneId: "exec", collapsed: true });
    assert.equal(r1.ok, true);
    const after1 = JSON.parse(readFileSync(file, "utf-8"));
    const exec1 = after1.meta.swimlanes.find((s) => s.id === "exec");
    assert.equal(exec1.collapsed, true);
    const ops1 = after1.meta.swimlanes.find((s) => s.id === "ops");
    assert.equal(ops1.collapsed, undefined);

    const r2 = await store.applyCollapse("test-project", { swimlaneId: "exec", collapsed: false });
    assert.equal(r2.ok, true);
    const after2 = JSON.parse(readFileSync(file, "utf-8"));
    const exec2 = after2.meta.swimlanes.find((s) => s.id === "exec");
    assert.equal(exec2.collapsed, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyCollapse: rejects unknown swimlane", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const r = await store.applyCollapse("test-project", { swimlaneId: "ghost", collapsed: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("deleteTask removes the task and scrubs incoming dependencies", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const r = await store.deleteTask("test-project", "t1");
    assert.equal(r.ok, true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(after.tasks.some((t) => t.id === "t1"), false);
    const t2 = after.tasks.find((t) => t.id === "t2");
    assert.deepEqual(t2.dependencies, []);
    assert.ok(after.meta.rev >= 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("deleteTask 404s for unknown task", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const r = await store.deleteTask("test-project", "ghost");
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createOrReplace validates slug parity + schema", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const mismatched = validProject({ meta: { ...validProject().meta, slug: "other-slug" } });
    const r = await store.createOrReplace("test-project", mismatched);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.ok(r.message.includes("must match"));

    const ok = await store.createOrReplace("test-project", validProject());
    assert.equal(ok.ok, true);
    assert.equal(existsSync(trackerPath(ws, "test-project")), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("deleteProject removes tracker file", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const r = await store.deleteProject("test-project");
    assert.equal(r.ok, true);
    assert.equal(existsSync(file), false);

    const missing = await store.deleteProject("test-project");
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("re-ingest of valid file clears previous error", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, "{ not json");
    store.ingest(file, readFileSync(file, "utf-8"));
    assert.ok(existsSync(errorPath(ws, "test-project")));

    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(existsSync(errorPath(ws, "test-project")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
