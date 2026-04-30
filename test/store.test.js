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

test("ingest valid no-op reload clears a prior parse error", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));

    const initial = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(initial.ok, true);

    const validRaw = readFileSync(file, "utf-8");
    writeFileSync(file, "{ not json");
    const broken = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(broken.ok, false);
    assert.equal(store.get("test-project").error.kind, "parse");
    assert.equal(existsSync(errorPath(ws, "test-project")), true);

    writeFileSync(file, validRaw);
    const recovered = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(recovered.ok, true);
    assert.equal(recovered.noop, true);
    assert.equal(store.get("test-project").error, null);
    assert.equal(existsSync(errorPath(ws, "test-project")), false);
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

test("applyPatch: expectedRev accepts writes against the current rev", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));
    const currentRev = store.get("test-project").rev;

    const res = await store.applyPatch("test-project", {
      expectedRev: currentRev,
      tasks: { t1: { status: "complete" } }
    });

    assert.equal(res.ok, true);
    assert.equal(res.noop, false);
    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(after.tasks.find((task) => task.id === "t1").status, "complete");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: expectedRev rejects stale writes without changing the file", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));
    const before = readFileSync(file, "utf-8");
    const currentRev = store.get("test-project").rev;

    const res = await store.applyPatch("test-project", {
      expectedRev: currentRev - 1,
      tasks: { t1: { status: "complete" } }
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.type, "conflict");
    assert.equal(res.expectedRev, currentRev - 1);
    assert.equal(res.currentRev, currentRev);
    assert.match(res.message, /stale write rejected/);
    assert.equal(readFileSync(file, "utf-8"), before);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: expectedRev must be a non-negative integer", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      expectedRev: "1",
      tasks: { t1: { status: "complete" } }
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.type, "schema");
    assert.match(res.message, /expectedRev/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: swimlaneOps add, update, move, and remove lanes structurally", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      swimlaneOps: [
        { op: "add", lane: { id: "qa", label: "QA", collapsed: true }, index: 1 },
        { op: "update", id: "ops", patch: { label: "Operations", collapsed: true } },
        { op: "move", id: "qa", direction: "down" },
        { op: "remove", id: "ops", reassignTo: "qa" }
      ]
    });

    assert.equal(res.ok, true);
    assert.equal(res.noop, false);
    assert.ok(res.notes.appended.includes("swimlane:qa"));
    assert.ok(res.notes.updated.includes("swimlane:ops"));
    assert.ok(
      res.notes.ignored.some((message) => message.includes("meta.swimlanes[ops].collapsed"))
    );

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(
      after.meta.swimlanes.map((lane) => lane.id),
      ["exec", "qa"]
    );
    assert.equal(after.meta.swimlanes.find((lane) => lane.id === "qa").collapsed, undefined);
    assert.deepEqual(after.tasks.find((task) => task.id === "t3").placement, {
      swimlaneId: "qa",
      priorityId: "p1"
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: taskOps move, archive, split, and merge tasks structurally", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      taskOps: [
        { op: "move", id: "t2", swimlaneId: "ops", priorityId: "p1", targetIndex: 0 },
        { op: "archive", id: "t3", reason: "Folded into follow-up work" },
        {
          op: "split",
          sourceId: "t1",
          newTask: {
            id: "t1a",
            title: "Task 1 follow-up",
            status: "not_started"
          }
        },
        { op: "merge", sourceId: "t1a", targetId: "t2" }
      ]
    });

    assert.equal(res.ok, true);
    assert.equal(res.noop, false);
    assert.ok(res.notes.updated.includes("t2"));
    assert.ok(res.notes.updated.includes("t3"));
    assert.ok(res.notes.appended.includes("t1a"));

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(
      after.tasks.map((task) => task.id),
      ["t1", "t1a", "t2", "t3"]
    );
    assert.deepEqual(after.tasks.find((task) => task.id === "t2").placement, {
      swimlaneId: "ops",
      priorityId: "p1"
    });
    assert.equal(after.tasks.find((task) => task.id === "t3").status, "deferred");
    assert.equal(after.tasks.find((task) => task.id === "t3").blocker_reason, "Folded into follow-up work");
    assert.equal(after.tasks.find((task) => task.id === "t1a").status, "deferred");
    assert.equal(after.tasks.find((task) => task.id === "t1a").context.merged_into, "t2");
    assert.deepEqual(after.tasks.find((task) => task.id === "t2").context.merged_from, ["t1a"]);
    assert.deepEqual(after.tasks.find((task) => task.id === "t2").related, ["t1a"]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: structural ops reject ambiguous or stale mixed payloads", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const malformed = await store.applyPatch("test-project", {
      taskOps: { op: "move", id: "t1" }
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.status, 400);
    assert.match(malformed.message, /taskOps must be an array/);

    const mixedLanePayload = await store.applyPatch("test-project", {
      swimlaneOps: [{ op: "remove", id: "ops", reassignTo: "exec" }],
      meta: { swimlanes: validProject().meta.swimlanes }
    });
    assert.equal(mixedLanePayload.ok, false);
    assert.match(mixedLanePayload.message, /do not mix swimlaneOps/);

    const mixedPlacementPayload = await store.applyPatch("test-project", {
      taskOps: [{ op: "move", id: "t1", swimlaneId: "ops", priorityId: "p1" }],
      tasks: { t1: { placement: { swimlaneId: "exec", priorityId: "p0" } } }
    });
    assert.equal(mixedPlacementPayload.ok, false);
    assert.match(mixedPlacementPayload.message, /do not mix taskOps.move/);

    const badIndex = await store.applyPatch("test-project", {
      taskOps: [{ op: "move", id: "t1", swimlaneId: "ops", priorityId: "p1", targetIndex: -1 }]
    });
    assert.equal(badIndex.ok, false);
    assert.match(badIndex.message, /targetIndex/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: swimlaneOps remove returns repair shape when tasks need reassignment", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      swimlaneOps: [{ op: "remove", id: "ops" }]
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.type, "schema");
    assert.match(res.message, /provide reassignTo/);
    assert.match(res.hint, /repair payload/);
    assert.deepEqual(res.repair, {
      type: "swimlane_reassign_required",
      affectedTaskIds: ["t3"],
      validSwimlaneIds: ["exec"],
      moveTasksTo: "exec",
      swimlaneOps: [{ op: "remove", id: "ops", reassignTo: "exec" }]
    });

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(
      after.meta.swimlanes.map((lane) => lane.id),
      ["exec", "ops"]
    );
    assert.deepEqual(after.tasks.find((task) => task.id === "t3").placement, {
      swimlaneId: "ops",
      priorityId: "p1"
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: taskOps split refuses deleted task ids", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const project = validProject();
    project.meta.deleted_tasks = ["t-deleted"];
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(project));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      taskOps: [
        {
          op: "split",
          sourceId: "t1",
          newTask: {
            id: "t-deleted",
            title: "Resurrected task",
            status: "not_started"
          }
        }
      ]
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.match(res.message, /deleted by a human/);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(after.tasks.some((task) => task.id === "t-deleted"), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: normalizes legacy partial status to in_progress", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      tasks: { t1: { status: "partial" } }
    });
    assert.equal(res.ok, true);
    assert.ok(res.notes.warnings.some((warning) => warning.includes('"partial" -> "in_progress"')));

    const after = JSON.parse(readFileSync(file, "utf-8"));
    const t1 = after.tasks.find((task) => task.id === "t1");
    assert.equal(t1.status, "in_progress");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: noop explains rejected structural swimlane removal", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const project = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(project));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      meta: {
        swimlanes: [project.meta.swimlanes[0]]
      }
    });

    assert.equal(res.ok, true);
    assert.equal(res.noop, true);
    assert.equal(res.rev, 1);
    assert.match(res.noopReason.reason, /did not change/);
    assert.ok(
      res.noopReason.rejected.some(
        (message) => message.includes("meta.swimlanes[ops]") && message.includes("swimlaneOps.remove")
      )
    );
    assert.match(res.noopReason.retryShape, /Swimlane removal is structural/);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(
      after.meta.swimlanes.map((lane) => lane.id),
      ["exec", "ops"]
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch: noop explains already-current patch values", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      tasks: { t1: { status: "not_started" } }
    });

    assert.equal(res.ok, true);
    assert.equal(res.noop, true);
    assert.deepEqual(res.noopReason.rejected, []);
    assert.match(res.noopReason.reason, /already matched/);
    assert.match(res.noopReason.retryShape, /Skip the write/);
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

test("applyPatch: rejects brand-new patch tasks that start complete or deferred", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.applyPatch("test-project", {
      tasks: {
        t4: {
          title: "Historical packaging row",
          status: "complete",
          placement: { swimlaneId: "ops", priorityId: "p1" }
        }
      }
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.type, "schema");
    assert.match(res.message, /new tasks added through patch mode/);
    assert.match(res.hint, /not_started/);
    assert.match(res.hint, /in_progress/);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(after.tasks.some((task) => task.id === "t4"), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("pickTask auto-selects the top ready task and updates status atomically", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.pickTask("test-project", { assignee: "codex" });
    assert.equal(res.ok, true);
    assert.equal(res.payload.pickedTaskId, "t1");
    assert.equal(res.payload.autoSelected, true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    const t1 = after.tasks.find((task) => task.id === "t1");
    assert.equal(t1.status, "in_progress");
    assert.equal(t1.assignee, "codex");
    assert.equal(t1.blocker_reason ?? null, null);
    assert.ok(after.meta.rev >= 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("startTask starts an explicit task and updates scratchpad atomically", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.startTask("test-project", {
      taskId: "t1",
      assignee: "codex",
      scratchpad: "codex started t1"
    });

    assert.equal(res.ok, true);
    assert.equal(res.noop, false);
    assert.equal(res.payload.startedTaskId, "t1");
    assert.equal(res.payload.action, "start");

    const after = JSON.parse(readFileSync(file, "utf-8"));
    const t1 = after.tasks.find((task) => task.id === "t1");
    assert.equal(t1.status, "in_progress");
    assert.equal(t1.assignee, "codex");
    assert.equal(after.meta.scratchpad, "codex started t1");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("startTask requires an explicit task id", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.startTask("test-project", { assignee: "codex" });

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.match(res.message, /taskId/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("startTask requires an assignee", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.startTask("test-project", { taskId: "t1" });

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.match(res.message, /assignee/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("pickTask rejects blocked tasks without force", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.pickTask("test-project", { taskId: "t2", assignee: "claude" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("pickTask refuses to steal an in-progress task without force", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const project = validProject();
    project.tasks[1].dependencies = [];
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(project));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.pickTask("test-project", { taskId: "t2", assignee: "codex" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);

    const forced = await store.pickTask("test-project", {
      taskId: "t2",
      assignee: "codex",
      force: true
    });
    assert.equal(forced.ok, true);
    assert.equal(forced.payload.task.assignee, "codex");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("pickTask is a no-op when the same assignee re-claims the same task", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const project = validProject();
    project.tasks[1].dependencies = [];
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(project));
    store.ingest(file, readFileSync(file, "utf-8"));

    const res = await store.pickTask("test-project", { taskId: "t2", assignee: "claude" });
    assert.equal(res.ok, true);
    assert.equal(res.noop, true);
    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(after.meta.rev, 1);
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

test("ingest: silent-rewrite return surfaces re-added context keys from a direct file edit", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    const data = validProject();
    // Seed with junk context keys on t1.
    data.tasks[0].context = { tags: ["alpha"], "0": "h", "1": "i" };
    writeFileSync(file, JSON.stringify(data));
    store.ingest(file, readFileSync(file, "utf-8"));

    // Agent edits the file directly to remove the "0"/"1" keys.
    const cleaned = JSON.parse(JSON.stringify(data));
    cleaned.tasks[0].context = { tags: ["alpha"] };
    writeFileSync(file, JSON.stringify(cleaned));
    const res = store.ingest(file, readFileSync(file, "utf-8"));

    assert.equal(res.ok, true);
    assert.equal(res.noop, true);
    assert.ok(res.silentRewrite, "silentRewrite summary is returned");
    const field = res.silentRewrite.fields.find((f) => f.path === "tasks[t1].context");
    assert.ok(field, "t1 context divergence captured");
    assert.deepEqual(field.reAddedByMerge.sort(), ["0", "1"]);

    // The hub rewrote the file to match its merged view — the junk keys are
    // back on disk, which is exactly the confusion this summary surfaces.
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    const t1 = onDisk.tasks.find((t) => t.id === "t1");
    assert.ok("0" in t1.context);
    assert.ok("1" in t1.context);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ingest: normalizes legacy partial status from tracker file", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    const project = validProject();
    project.tasks[0].status = "partial";
    writeFileSync(file, JSON.stringify(project));

    const res = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(res.ok, true);

    const entry = store.get("test-project");
    assert.equal(entry.data.tasks[0].status, "in_progress");
    assert.ok(entry.notes.warnings.some((warning) => warning.includes('"partial" -> "in_progress"')));

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(after.tasks[0].status, "in_progress");
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

test("createOrReplace accepts legacy partial status and writes canonical status", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const project = validProject();
    project.tasks[0].status = "partial";

    const res = await store.createOrReplace("test-project", project);
    assert.equal(res.ok, true);

    const after = JSON.parse(readFileSync(trackerPath(ws, "test-project"), "utf-8"));
    assert.equal(after.tasks[0].status, "in_progress");
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
