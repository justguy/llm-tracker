// test/runtime-startup.test.js — sh-1-07 (TDD v0.5 §5.4)
//
// Coverage for hub/runtime/startup.js#rebuildRuntimeFromDisk:
//   - empty workspace (no snapshots, no JSONL) -> source='empty'
//   - JSONL only (no snapshots) -> source='replay-only', full replay
//   - wrapped snapshots + matching watermark + extra JSONL events ->
//     source='snapshots+replay', only post-watermark events applied
//   - bare snapshot arrays (legacy / forward-compat) -> seeded, full replay
//   - corrupt snapshot (one of three) -> full rebuild + warning
//   - watermark mismatch across the 3 snapshots -> full rebuild + warning
//   - corrupt JSONL line mid-file -> halts at last valid event, surfaces warning
//   - ENOENT JSONL but valid snapshots -> events=0, snapshots seed projection

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makePaths } from "../hub/runtime/paths.js";
import { appendJsonlLine } from "../hub/runtime/snapshots.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import {
  rebuildRuntimeFromDisk,
  wrapSnapshot,
  SNAPSHOT_NAMES,
} from "../hub/runtime/startup.js";

// --- helpers ---------------------------------------------------------------

async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "lt-startup-"));
  const paths = makePaths({ workspaceRoot: root });
  await mkdir(paths.runtimeDir, { recursive: true });
  return { root, paths };
}

let evtCounter = 0;
/**
 * Generate a *stable* evt_ id for tests. We can't use makeRuntimeId() in
 * helpers that need predictable values, but a single helper for the rare
 * test where we need a deterministic id is convenient.
 */
function evtId() {
  return makeRuntimeId("evt");
}

function baseEvent(type, overrides = {}) {
  evtCounter += 1;
  return {
    schemaVersion: 1,
    id: overrides.id || evtId(),
    ts: overrides.ts || `2026-05-23T12:00:${String(evtCounter % 60).padStart(2, "0")}Z`,
    type,
    source: overrides.source || "system",
    workspace: overrides.workspace || "/tmp/test-ws",
    ...overrides,
  };
}

function sessionStartedEvent({ sessionId, name = "S", tier = "codex_app_server", id, ts, source = "ui" } = {}) {
  return baseEvent("session.started", {
    ...(id ? { id } : {}),
    ...(ts ? { ts } : {}),
    source,
    session: { id: sessionId, name, tier },
  });
}

function sessionStatusEvent({ sessionId, status = "active", id, ts } = {}) {
  return baseEvent("session.status", {
    ...(id ? { id } : {}),
    ...(ts ? { ts } : {}),
    source: "adapter",
    sessionId,
    status,
  });
}

async function writeWrappedSnapshot(target, payload, watermark) {
  await writeFile(target, JSON.stringify(wrapSnapshot(payload, watermark)), "utf8");
}

async function writeBareSnapshot(target, payload) {
  await writeFile(target, JSON.stringify(payload), "utf8");
}

// --- tests -----------------------------------------------------------------

test("empty workspace -> source='empty', zero events, no projection state", async () => {
  const { root } = await makeWorkspace();
  try {
    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });
    assert.equal(result.source, "empty");
    assert.equal(result.events, 0);
    assert.equal(result.jsonlOffset, 0);
    assert.ok(Array.isArray(result.warnings));
    assert.ok(result.warnings.some((w) => w.includes("no snapshots present")));
    assert.deepEqual(projection.toSnapshots(), { sessions: [], jobs: [], skillRuns: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSONL only (no snapshots) -> source='replay-only', full replay", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    const s2 = makeRuntimeId("ses");
    const events = [
      sessionStartedEvent({ sessionId: s1, name: "first" }),
      sessionStartedEvent({ sessionId: s2, name: "second" }),
      sessionStatusEvent({ sessionId: s1, status: "active" }),
    ];
    for (const e of events) await appendJsonlLine(paths.runtimeEvents, e);

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "replay-only");
    assert.equal(result.events, 3);
    assert.ok(result.jsonlOffset > 0);
    assert.ok(result.warnings.some((w) => w.includes("no snapshots present")));

    const snap = projection.toSnapshots();
    assert.deepEqual(snap.sessions.map((s) => s.id), [s1, s2]);
    assert.equal(snap.sessions[0].status, "active");
    assert.equal(snap.sessions[1].status, "starting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrapped snapshots + matching watermark + extra JSONL events", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    const s2 = makeRuntimeId("ses");
    const s3 = makeRuntimeId("ses");

    // Two events are "already absorbed" into the snapshot; the third is the
    // watermark boundary; events after the watermark must be replayed.
    const wmEventId = makeRuntimeId("evt");
    const eventsInLog = [
      sessionStartedEvent({ sessionId: s1, name: "old-1" }),
      sessionStartedEvent({ sessionId: s2, name: "old-2" }),
      sessionStartedEvent({ sessionId: s3, name: "boundary", id: wmEventId }),
      // post-watermark:
      sessionStatusEvent({ sessionId: s1, status: "active" }),
      sessionStatusEvent({ sessionId: s2, status: "ended" }),
    ];
    for (const e of eventsInLog) await appendJsonlLine(paths.runtimeEvents, e);

    // The snapshot payloads represent the projection AFTER the boundary event.
    const seededSessions = [
      { id: s1, name: "old-1", tier: "codex_app_server", status: "starting", warnings: [] },
      { id: s2, name: "old-2", tier: "codex_app_server", status: "starting", warnings: [] },
      { id: s3, name: "boundary", tier: "codex_app_server", status: "starting", warnings: [] },
    ];
    const wm = { jsonlOffset: 999, lastEventId: wmEventId, rev: 3 };
    await writeWrappedSnapshot(paths.sessionsSnapshot, seededSessions, wm);
    await writeWrappedSnapshot(paths.jobsSnapshot, [], wm);
    await writeWrappedSnapshot(paths.skillRunsSnapshot, [], wm);

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "snapshots+replay");
    // Only the 2 post-watermark events should have been applied.
    assert.equal(result.events, 2);
    assert.equal(result.warnings.length, 0, `unexpected warnings: ${JSON.stringify(result.warnings)}`);

    const snap = projection.toSnapshots();
    assert.deepEqual(snap.sessions.map((s) => s.id), [s1, s2, s3]);
    // post-watermark updates applied:
    assert.equal(snap.sessions.find((s) => s.id === s1).status, "active");
    assert.equal(snap.sessions.find((s) => s.id === s2).status, "ended");
    // boundary session retains starting status (not changed post-snapshot):
    assert.equal(snap.sessions.find((s) => s.id === s3).status, "starting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bare snapshot arrays (legacy) -> seeded + full JSONL replay (idempotent)", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    const s2 = makeRuntimeId("ses");

    // Bare arrays — no watermark. Snapshot reflects state after two starteds.
    const seeded = [
      { id: s1, name: "from-snap-1", tier: "codex_app_server", status: "starting", warnings: [] },
      { id: s2, name: "from-snap-2", tier: "codex_app_server", status: "starting", warnings: [] },
    ];
    await writeBareSnapshot(paths.sessionsSnapshot, seeded);
    await writeBareSnapshot(paths.jobsSnapshot, []);
    await writeBareSnapshot(paths.skillRunsSnapshot, []);

    // JSONL has the same two events plus a later status update.
    const e1 = sessionStartedEvent({ sessionId: s1, name: "from-snap-1" });
    const e2 = sessionStartedEvent({ sessionId: s2, name: "from-snap-2" });
    const e3 = sessionStatusEvent({ sessionId: s1, status: "active" });
    for (const e of [e1, e2, e3]) await appendJsonlLine(paths.runtimeEvents, e);

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "snapshots+replay");
    // bare snapshots have no lastEventId, so the full log gets replayed:
    assert.equal(result.events, 3);

    const snap = projection.toSnapshots();
    // FIFO order preserved by seedProjection (s1 first, then s2). Re-applied
    // session.started events are upserts that don't push duplicates because
    // !existing guard short-circuits the order push.
    assert.deepEqual(snap.sessions.map((s) => s.id), [s1, s2]);
    assert.equal(snap.sessions[0].status, "active");
    assert.equal(snap.sessions[1].status, "starting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt snapshot file -> full rebuild from JSONL with warning", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    const s2 = makeRuntimeId("ses");
    const events = [
      sessionStartedEvent({ sessionId: s1, name: "first" }),
      sessionStartedEvent({ sessionId: s2, name: "second" }),
    ];
    for (const e of events) await appendJsonlLine(paths.runtimeEvents, e);

    // sessions.snapshot.json is malformed JSON; jobs+skillRuns valid wrapped.
    await writeFile(paths.sessionsSnapshot, "{this is not json", "utf8");
    await writeWrappedSnapshot(paths.jobsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 0 });
    await writeWrappedSnapshot(paths.skillRunsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 0 });

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "replay-only");
    assert.equal(result.events, 2);
    assert.ok(
      result.warnings.some((w) => w.includes("snapshot load failed")),
      `expected snapshot-load-failed warning, got ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings.some((w) => w.includes("not valid JSON")),
      "warning should explain the JSON parse failure",
    );

    const snap = projection.toSnapshots();
    assert.deepEqual(snap.sessions.map((s) => s.id), [s1, s2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot has unexpected shape -> full rebuild with warning", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    // Object that lacks both `payload` and array-shape — should be flagged.
    await writeFile(paths.sessionsSnapshot, JSON.stringify({ random: "garbage" }), "utf8");
    await writeWrappedSnapshot(paths.jobsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 0 });
    await writeWrappedSnapshot(paths.skillRunsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 0 });

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "empty");
    assert.ok(result.warnings.some((w) => w.includes("unexpected shape")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watermark mismatch across the 3 snapshots -> full rebuild + warning", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    await appendJsonlLine(paths.runtimeEvents, sessionStartedEvent({ sessionId: s1, name: "x" }));

    // Three valid wrapped snapshots — but jobs.rev=7 disagrees with the others.
    await writeWrappedSnapshot(paths.sessionsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 1 });
    await writeWrappedSnapshot(paths.jobsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 7 });
    await writeWrappedSnapshot(paths.skillRunsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 1 });

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "replay-only");
    assert.equal(result.events, 1);
    assert.ok(
      result.warnings.some((w) => w.includes("watermarks disagree")),
      `expected watermark-disagree warning, got ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial snapshot set (1 of 3 present) is treated as corrupt -> full rebuild", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    await appendJsonlLine(paths.runtimeEvents, sessionStartedEvent({ sessionId: s1, name: "x" }));

    // Only sessions snapshot present; jobs + skill-runs absent (simulating
    // crash mid 3-file write).
    await writeWrappedSnapshot(paths.sessionsSnapshot, [], { jsonlOffset: 0, lastEventId: null, rev: 1 });

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "replay-only");
    assert.equal(result.events, 1);
    assert.ok(
      result.warnings.some((w) => w.includes("snapshot set is incomplete")),
      `expected incomplete-set warning, got ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt JSONL line mid-file -> halt at last valid event, surface warning", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    const s2 = makeRuntimeId("ses");
    await appendJsonlLine(paths.runtimeEvents, sessionStartedEvent({ sessionId: s1, name: "a" }));
    await appendJsonlLine(paths.runtimeEvents, sessionStartedEvent({ sessionId: s2, name: "b" }));
    // Inject a broken line, then a "valid" line after it (which should be IGNORED
    // because readJsonlLines halts at the first failure per §5.4 step 4).
    await appendFile(paths.runtimeEvents, "{not-json,broken\n", "utf8");
    await appendJsonlLine(paths.runtimeEvents, sessionStartedEvent({ sessionId: makeRuntimeId("ses"), name: "after-break" }));

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "replay-only");
    assert.equal(result.events, 2);
    assert.ok(
      result.warnings.some((w) => w.includes("JSONL corrupt") && w.includes("halted at last valid event")),
      `expected JSONL-corrupt warning, got ${JSON.stringify(result.warnings)}`,
    );

    const snap = projection.toSnapshots();
    assert.deepEqual(snap.sessions.map((s) => s.id), [s1, s2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ENOENT JSONL with valid wrapped snapshots -> seeded, zero replays", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    const seeded = [
      { id: s1, name: "only-from-snap", tier: "codex_app_server", status: "starting", warnings: [] },
    ];
    const wm = { jsonlOffset: 0, lastEventId: null, rev: 1 };
    await writeWrappedSnapshot(paths.sessionsSnapshot, seeded, wm);
    await writeWrappedSnapshot(paths.jobsSnapshot, [], wm);
    await writeWrappedSnapshot(paths.skillRunsSnapshot, [], wm);

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "snapshots+replay");
    assert.equal(result.events, 0);
    assert.equal(result.jsonlOffset, 0);
    assert.equal(result.warnings.length, 0, `unexpected warnings: ${JSON.stringify(result.warnings)}`);

    const snap = projection.toSnapshots();
    assert.deepEqual(snap.sessions.map((s) => s.id), [s1]);
    assert.equal(snap.sessions[0].name, "only-from-snap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watermark lastEventId not found in JSONL -> full replay + warning", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const s1 = makeRuntimeId("ses");
    await appendJsonlLine(paths.runtimeEvents, sessionStartedEvent({ sessionId: s1, name: "x" }));

    // Wrap snapshots with a watermark that references an event id NOT in
    // the log (e.g. log got rotated out from under the snapshot).
    const ghostId = makeRuntimeId("evt");
    const wm = { jsonlOffset: 0, lastEventId: ghostId, rev: 1 };
    await writeWrappedSnapshot(paths.sessionsSnapshot, [], wm);
    await writeWrappedSnapshot(paths.jobsSnapshot, [], wm);
    await writeWrappedSnapshot(paths.skillRunsSnapshot, [], wm);

    const projection = new RuntimeProjection();
    const result = await rebuildRuntimeFromDisk({ workspaceRoot: root, projection });

    assert.equal(result.source, "snapshots+replay");
    // Snapshots are empty; full JSONL gets replayed on top.
    assert.equal(result.events, 1);
    assert.ok(
      result.warnings.some((w) => w.includes("watermark lastEventId") && w.includes("not found")),
      `expected ghost-watermark warning, got ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrapSnapshot rejects non-array payload", () => {
  assert.throws(() => wrapSnapshot({ not: "array" }), /must be an array/);
});

test("SNAPSHOT_NAMES is frozen with the three expected keys", () => {
  assert.deepEqual(Object.keys(SNAPSHOT_NAMES).sort(), ["jobs", "sessions", "skillRuns"]);
  assert.ok(Object.isFrozen(SNAPSHOT_NAMES));
});

test("rebuildRuntimeFromDisk rejects bad arguments", async () => {
  await assert.rejects(
    async () => rebuildRuntimeFromDisk({ workspaceRoot: "", projection: new RuntimeProjection() }),
    /workspaceRoot/,
  );
  await assert.rejects(
    async () => rebuildRuntimeFromDisk({ workspaceRoot: "/tmp/whatever", projection: null }),
    /projection/,
  );
});
