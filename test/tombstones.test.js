import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeProject } from "../hub/merge.js";
import { Store, trackerPath } from "../hub/store.js";
import { validateProject } from "../hub/validator.js";
import { validProject } from "./fixtures.js";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-tomb-"));
  for (const sub of ["trackers", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  return ws;
}

test("validator accepts meta.deleted_tasks as string[]", () => {
  const p = validProject();
  p.meta.deleted_tasks = ["t1"];
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("deleteTask tombstones the id in meta.deleted_tasks", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.deleteTask("test-project", "t1");
    assert.equal(res.ok, true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(after.meta.deleted_tasks, ["t1"]);
    assert.equal(after.tasks.find((t) => t.id === "t1"), undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("merge drops incoming task updates that resurrect a tombstoned id", () => {
  const existing = validProject();
  existing.meta.deleted_tasks = ["t1"];
  existing.tasks = existing.tasks.filter((t) => t.id !== "t1");

  const incoming = validProject();
  // Stale LLM writes a full array still including t1
  const { merged, notes } = mergeProject(existing, incoming);

  assert.equal(merged.tasks.find((t) => t.id === "t1"), undefined);
  assert.ok(
    notes.ignored.some((msg) => msg.includes("t1") && msg.includes("refusing to resurrect"))
  );
});

test("merge drops incoming meta.deleted_tasks so LLMs can't clear tombstones", () => {
  const existing = validProject();
  existing.meta.deleted_tasks = ["t1"];
  existing.tasks = existing.tasks.filter((t) => t.id !== "t1");

  const incoming = JSON.parse(JSON.stringify(existing));
  incoming.meta.deleted_tasks = []; // LLM tries to wipe the tombstone list

  const { merged, notes } = mergeProject(existing, incoming);
  assert.deepEqual(merged.meta.deleted_tasks, ["t1"]);
  assert.ok(notes.ignored.some((msg) => msg.includes("deleted_tasks is hub-owned")));
});

test("applyPatch cannot resurrect a tombstoned task via new-id patch", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const deleted = await store.deleteTask("test-project", "t2");
    assert.equal(deleted.ok, true);

    const res = await store.applyPatch("test-project", {
      tasks: {
        t2: {
          id: "t2",
          title: "ressurected task",
          status: "in_progress",
          placement: { swimlaneId: "exec", priorityId: "p0" }
        }
      }
    });
    assert.equal(res.ok, true);
    assert.ok(
      res.notes.ignored.some((msg) => msg.includes("t2") && msg.includes("refusing to resurrect"))
    );

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(after.tasks.find((t) => t.id === "t2"), undefined);
    assert.ok(after.meta.deleted_tasks.includes("t2"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("rollback to a rev before deletion clears the tombstone (undo flow)", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const baseRev = store.get("test-project").rev;
    const del = await store.deleteTask("test-project", "t2");
    assert.equal(del.ok, true);
    const afterDel = store.get("test-project");
    assert.ok(afterDel.data.meta.deleted_tasks.includes("t2"));

    const rb = await store.rollback("test-project", baseRev);
    assert.equal(rb.ok, true);

    const restored = JSON.parse(readFileSync(file, "utf-8"));
    const tomb = restored.meta.deleted_tasks || [];
    assert.ok(!tomb.includes("t2"), "rollback to a pre-delete rev should clear the tombstone");
    assert.ok(restored.tasks.some((t) => t.id === "t2"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
