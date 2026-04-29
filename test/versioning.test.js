import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, trackerPath } from "../hub/store.js";
import { readSnapshot, listRevs, historySince } from "../hub/snapshots.js";
import { computeDelta, hasChanges, summarize } from "../hub/versioning.js";
import { validProject } from "./fixtures.js";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-vers-"));
  for (const sub of ["trackers", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  return ws;
}

test("computeDelta detects changed task fields", () => {
  const prev = validProject();
  const curr = JSON.parse(JSON.stringify(prev));
  curr.tasks[0].status = "complete";
  curr.meta.scratchpad = "done";

  const d = computeDelta(prev, curr);
  assert.ok(hasChanges(d));
  assert.equal(d.tasks.t1.status, "complete");
  assert.equal(d.meta.scratchpad, "done");
});

test("computeDelta detects added + removed tasks", () => {
  const prev = validProject();
  const curr = JSON.parse(JSON.stringify(prev));
  curr.tasks.push({
    id: "t4",
    title: "new",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p0" }
  });
  curr.tasks = curr.tasks.filter((t) => t.id !== "t3");

  const d = computeDelta(prev, curr);
  assert.ok(d.tasks.t4.__added__);
  assert.ok(d.tasks.t3.__removed__);
});

test("hasChanges is false for identical states", () => {
  const p = validProject();
  const d = computeDelta(p, p);
  assert.equal(hasChanges(d), false);
});

test("summarize produces human-readable entries", () => {
  const prev = validProject();
  const curr = JSON.parse(JSON.stringify(prev));
  curr.tasks[0].status = "complete";
  curr.meta.scratchpad = "done";
  const sum = summarize(computeDelta(prev, curr));
  assert.ok(sum.some((s) => s.kind === "meta" && s.key === "scratchpad"));
  assert.ok(sum.some((s) => s.kind === "status" && s.id === "t1" && s.to === "complete"));
});

test("ingest stamps meta.rev and writes a snapshot", () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    const res = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(res.ok, true);

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(onDisk.meta.rev, 1);
    assert.ok(onDisk.meta.updatedAt);

    const snap = readSnapshot(ws, "test-project", 1);
    assert.ok(snap);
    assert.equal(snap.meta.rev, 1);

    assert.deepEqual(listRevs(ws, "test-project"), [1]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applyPatch bumps rev and writes history", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    const patch = await store.applyPatch("test-project", { tasks: { t1: { status: "complete" } } });
    assert.equal(patch.ok, true);

    const entry = store.get("test-project");
    assert.ok(entry.rev >= 2);
    assert.equal(patch.rev, entry.rev);

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(onDisk.meta.rev, entry.rev);
    assert.equal(onDisk.tasks.find((t) => t.id === "t1").status, "complete");

    const sinceZero = store.getSince("test-project", 0);
    assert.ok(sinceZero.events.length >= 1);
    assert.equal(sinceZero.currentRev, entry.rev);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("structural applyPatch ops bump rev, stamp updatedAt, snapshot, and write history", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));
    const rev1 = store.get("test-project").rev;

    const patch = await store.applyPatch("test-project", {
      swimlaneOps: [{ op: "add", lane: { id: "qa", label: "QA" } }],
      taskOps: [{ op: "move", id: "t1", swimlaneId: "qa", priorityId: "p1", targetIndex: 0 }]
    });

    assert.equal(patch.ok, true);
    assert.equal(patch.noop, false);
    assert.equal(patch.rev, rev1 + 1);

    const entry = store.get("test-project");
    assert.equal(entry.rev, rev1 + 1);

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(onDisk.meta.rev, rev1 + 1);
    assert.ok(onDisk.meta.updatedAt);
    assert.ok(Date.parse(onDisk.meta.updatedAt));
    assert.ok(onDisk.meta.swimlanes.some((lane) => lane.id === "qa"));
    assert.deepEqual(onDisk.tasks.find((task) => task.id === "t1").placement, {
      swimlaneId: "qa",
      priorityId: "p1"
    });

    const snap = readSnapshot(ws, "test-project", rev1 + 1);
    assert.ok(snap);
    assert.ok(snap.meta.swimlanes.some((lane) => lane.id === "qa"));

    const sinceRev1 = store.getSince("test-project", rev1);
    assert.equal(sinceRev1.currentRev, rev1 + 1);
    assert.ok(sinceRev1.events.some((event) => event.rev === rev1 + 1));
    assert.ok(
      sinceRev1.events
        .find((event) => event.rev === rev1 + 1)
        .summary.some((item) => item.id === "t1" || item.key === "swimlanes")
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("rollback replays a prior snapshot as a new rev", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));
    const rev1 = store.get("test-project").rev;

    await store.applyPatch("test-project", { tasks: { t1: { status: "complete" } } });
    const rev2 = store.get("test-project").rev;
    assert.ok(rev2 > rev1);
    assert.equal(
      JSON.parse(readFileSync(file, "utf-8")).tasks.find((t) => t.id === "t1").status,
      "complete"
    );

    const r = await store.rollback("test-project", rev1);
    assert.equal(r.ok, true);
    assert.equal(r.to, rev1);
    assert.equal(r.newRev, rev2 + 1);

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(onDisk.meta.rev, rev2 + 1);
    assert.equal(onDisk.tasks.find((t) => t.id === "t1").status, "not_started");

    const sinceRev2 = store.getSince("test-project", rev2);
    assert.ok(
      sinceRev2.events.some((e) => e.rolledBackTo === rev1),
      "rollback event recorded in history"
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("rollback 404s for missing snapshot", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));
    const r = await store.rollback("test-project", 999);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("undo restores the previous effective state and redo reapplies the undone state", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    await store.applyPatch("test-project", { tasks: { t1: { status: "in_progress" } } });
    const rev2 = store.get("test-project").rev;

    await store.applyPatch("test-project", { tasks: { t1: { status: "complete" } } });
    const rev3 = store.get("test-project").rev;
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).tasks.find((t) => t.id === "t1").status, "complete");

    const undo = await store.undo("test-project");
    assert.equal(undo.ok, true);
    assert.equal(undo.to, rev2);
    assert.equal(undo.newRev, rev3 + 1);
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).tasks.find((t) => t.id === "t1").status, "in_progress");

    const redo = await store.redo("test-project");
    assert.equal(redo.ok, true);
    assert.equal(redo.to, rev3);
    assert.equal(redo.newRev, undo.newRev + 1);
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).tasks.find((t) => t.id === "t1").status, "complete");

    const revisions = store.revisions("test-project");
    assert.ok(revisions.some((entry) => entry.action === "undo"));
    assert.ok(revisions.some((entry) => entry.action === "redo"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("redo requires the latest history event to be an undo", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    await store.applyPatch("test-project", { tasks: { t1: { status: "complete" } } });

    const redo = await store.redo("test-project");
    assert.equal(redo.ok, false);
    assert.equal(redo.status, 409);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("getSince returns only events after fromRev", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    await store.applyPatch("test-project", { tasks: { t1: { status: "in_progress" } } });

    await store.applyPatch("test-project", { tasks: { t1: { status: "complete" } } });

    const currentRev = store.get("test-project").rev;
    const sinceRev1 = store.getSince("test-project", 1);
    assert.equal(sinceRev1.currentRev, currentRev);
    assert.ok(sinceRev1.events.every((e) => e.rev > 1));
    assert.ok(sinceRev1.events.length >= 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("revisions lists every recorded rev", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));
    await store.applyPatch("test-project", { tasks: { t1: { status: "complete" } } });

    const revs = store.revisions("test-project");
    assert.ok(revs.length >= 2);
    assert.deepEqual(
      revs.map((r) => r.rev).sort((a, b) => a - b),
      Array.from(new Set(revs.map((r) => r.rev))).sort((a, b) => a - b)
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("history returns recent events with truncation metadata", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(validProject()));
    store.ingest(file, readFileSync(file, "utf-8"));

    await store.applyPatch("test-project", { tasks: { t1: { status: "in_progress" } } });
    await store.applyPatch("test-project", { tasks: { t1: { status: "complete" } } });

    const history = store.history("test-project", { limit: 2 });
    assert.equal(history.events.length, 2);
    assert.equal(history.truncation.returned, 2);
    assert.ok(history.truncation.totalAvailable >= 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ingest cold-start resume: matching snapshot does not bump rev", () => {
  const ws = setupWorkspace();
  try {
    // Simulate a prior run: write snapshot 3 + tracker file with rev 3
    const p = validProject();
    p.meta.rev = 3;
    p.meta.updatedAt = "2026-04-13T00:00:00.000Z";
    mkdirSync(join(ws, ".snapshots", "test-project"), { recursive: true });
    writeFileSync(
      join(ws, ".snapshots", "test-project", "000003.json"),
      JSON.stringify(p, null, 2)
    );
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));

    // Fresh store (simulates hub restart)
    const store = new Store(ws);
    const res = store.ingest(file, readFileSync(file, "utf-8"));
    assert.equal(res.ok, true);
    assert.equal(res.resumed, true);
    assert.equal(store.get("test-project").rev, 3);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
