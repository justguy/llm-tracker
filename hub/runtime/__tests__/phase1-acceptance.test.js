// hub/runtime/__tests__/phase1-acceptance.test.js
//
// SH-1-10: TDD v0.5 §20.1 acceptance scenarios. Wires the full Phase 1
// runtime pipeline (RuntimeStore + projection + snapshots + JSONL append +
// startup rebuild) and asserts the 5 §20.1 invariants on the integrated
// system rather than per-module.
//
// One test per §20.1 scenario:
//   1. concurrent append calls preserve all events
//   2. snapshot rebuild from JSONL
//   3. corrupt snapshot rebuilds from event log
//   4. corrupt JSONL line reports recovery warning
//   5. atomic snapshot write does not leave partial JSON
//
// These tests intentionally avoid stubbing the production modules. The full
// pipeline is exercised end-to-end on a real tmpdir workspace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RuntimeStore } from "../store.js";
import { RuntimeProjection } from "../projection.js";
import { atomicWriteJson } from "../atomic.js";
import { readJsonlLines, appendJsonlLine } from "../snapshots.js";
import { makePaths } from "../paths.js";
import { makeRuntimeId } from "../ids.js";
import { rebuildRuntimeFromDisk, wrapSnapshot } from "../startup.js";

async function setupWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "lt-phase1-"));
}

// Build a normalized session.started event that satisfies the runtime-events
// schema. Reused by every scenario.
function makeSessionStartedEvent({ workspace, sessionId, name }) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: new Date().toISOString(),
    type: "session.started",
    source: "system",
    workspace,
    session: { id: sessionId, name, tier: "dumb_terminal" },
  };
}

test("§20.1: concurrent append calls preserve all events", { timeout: 8000 }, async () => {
  const workspaceRoot = await setupWorkspace();
  const projection = new RuntimeProjection();
  const paths = makePaths({ workspaceRoot });
  const writeSnapshots = async () => {
    const s = projection.toSnapshots();
    await Promise.all([
      atomicWriteJson(paths.sessionsSnapshot, wrapSnapshot(s.sessions, { rev: projection.rev })),
      atomicWriteJson(paths.jobsSnapshot, wrapSnapshot(s.jobs, { rev: projection.rev })),
      atomicWriteJson(paths.skillRunsSnapshot, wrapSnapshot(s.skillRuns, { rev: projection.rev })),
    ]);
  };
  const onAppend = async (event) => {
    await appendJsonlLine(paths.runtimeEvents, event);
    projection.apply(event);
  };
  const store = new RuntimeStore({
    workspaceRoot,
    onAppend,
    writeSnapshots,
    allowClientIds: true, // we pre-stamp evt_ ids inside makeSessionStartedEvent
  });
  const N = 50;
  const sessionIds = Array.from({ length: N }, () => makeRuntimeId("ses"));
  const results = await Promise.all(
    sessionIds.map((sid, i) =>
      store.append(makeSessionStartedEvent({ workspace: workspaceRoot, sessionId: sid, name: `s-${i}` })),
    ),
  );
  await store.shutdown();
  assert.equal(results.length, N);
  // Unique evt_ ids — no collisions from concurrent appends.
  assert.equal(new Set(results.map((r) => r.eventId)).size, N);
  // The queue serialized all appends, so revs form the contiguous 1..N range.
  assert.deepEqual(
    results.map((r) => r.rev).sort((a, b) => a - b),
    Array.from({ length: N }, (_, i) => i + 1),
  );
  // All events persisted to JSONL in arrival order (queue serialization).
  const jsonl = await readJsonlLines(paths.runtimeEvents);
  assert.equal(jsonl.events.length, N);
  assert.equal(jsonl.corruptedAt, null);
  // Projection reflects them.
  assert.equal(projection.toSnapshots().sessions.length, N);
});

test("§20.1: snapshot rebuild from JSONL", { timeout: 8000 }, async () => {
  const workspaceRoot = await setupWorkspace();
  const projection = new RuntimeProjection();
  const paths = makePaths({ workspaceRoot });
  const onAppend = async (event) => {
    await appendJsonlLine(paths.runtimeEvents, event);
    projection.apply(event);
  };
  const store = new RuntimeStore({ workspaceRoot, onAppend, allowClientIds: true });
  for (let i = 0; i < 10; i++) {
    await store.append(
      makeSessionStartedEvent({
        workspace: workspaceRoot,
        sessionId: makeRuntimeId("ses"),
        name: `s-${i}`,
      }),
    );
  }
  // Fresh process: rebuild from disk into a fresh projection.
  const reborn = new RuntimeProjection();
  const result = await rebuildRuntimeFromDisk({ workspaceRoot, projection: reborn });
  assert.equal(result.events, 10);
  assert.equal(result.source, "replay-only");
  assert.deepEqual(
    reborn.toSnapshots().sessions.map((s) => s.id).sort(),
    projection.toSnapshots().sessions.map((s) => s.id).sort(),
  );
});

test("§20.1: corrupt snapshot rebuilds from event log", { timeout: 8000 }, async () => {
  const workspaceRoot = await setupWorkspace();
  const projection = new RuntimeProjection();
  const paths = makePaths({ workspaceRoot });
  const onAppend = async (event) => {
    await appendJsonlLine(paths.runtimeEvents, event);
    projection.apply(event);
  };
  const store = new RuntimeStore({ workspaceRoot, onAppend, allowClientIds: true });
  for (let i = 0; i < 3; i++) {
    await store.append(
      makeSessionStartedEvent({
        workspace: workspaceRoot,
        sessionId: makeRuntimeId("ses"),
        name: `s-${i}`,
      }),
    );
  }
  // Write a CORRUPT snapshot for one of the 3 files. Partial-set (1/3) is
  // already treated as corrupt by startup.js; this confirms the rebuild path
  // is exercised AND that the JSONL log is the source of truth.
  await mkdir(path.dirname(paths.sessionsSnapshot), { recursive: true });
  await writeFile(paths.sessionsSnapshot, "{not json", "utf8");
  const reborn = new RuntimeProjection();
  const result = await rebuildRuntimeFromDisk({ workspaceRoot, projection: reborn });
  assert.ok(
    result.warnings.some((w) => /snapshot/i.test(w)),
    `expected snapshot warning, got: ${JSON.stringify(result.warnings)}`,
  );
  assert.equal(result.source, "replay-only");
  assert.equal(reborn.toSnapshots().sessions.length, 3);
});

test("§20.1: corrupt JSONL line reports recovery warning", { timeout: 8000 }, async () => {
  const workspaceRoot = await setupWorkspace();
  const projection = new RuntimeProjection();
  const paths = makePaths({ workspaceRoot });
  const onAppend = async (event) => {
    await appendJsonlLine(paths.runtimeEvents, event);
    projection.apply(event);
  };
  const store = new RuntimeStore({ workspaceRoot, onAppend, allowClientIds: true });
  for (let i = 0; i < 2; i++) {
    await store.append(
      makeSessionStartedEvent({
        workspace: workspaceRoot,
        sessionId: makeRuntimeId("ses"),
        name: `s-${i}`,
      }),
    );
  }
  // Append a corrupt line directly to the JSONL log. The startup reader must
  // halt at the last valid event and surface a recovery warning.
  await appendFile(paths.runtimeEvents, "{broken line\n", "utf8");
  const reborn = new RuntimeProjection();
  const result = await rebuildRuntimeFromDisk({ workspaceRoot, projection: reborn });
  assert.equal(result.events, 2);
  assert.ok(
    result.warnings.some((w) => /jsonl|corrupt|halt|last valid/i.test(w)),
    `expected JSONL recovery warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test("§20.1: atomic snapshot write does not leave partial JSON", { timeout: 8000 }, async () => {
  const workspaceRoot = await setupWorkspace();
  const paths = makePaths({ workspaceRoot });
  // Write a large payload concurrently with multiple racing writers; the
  // final file must always JSON.parse cleanly (never a torn write).
  const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, name: `item-${i}`.repeat(10) })) };
  await mkdir(path.dirname(paths.sessionsSnapshot), { recursive: true });
  // Race: 5 concurrent atomic writes to the same target.
  await Promise.all(Array.from({ length: 5 }, () => atomicWriteJson(paths.sessionsSnapshot, big)));
  // After dust settles, file is valid JSON with the expected shape.
  const raw = await readFile(paths.sessionsSnapshot, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.items.length, 5000);
  // No stray .tmp files leaked in the snapshot dir.
  const entries = await readdir(path.dirname(paths.sessionsSnapshot));
  const tmps = entries.filter((e) => e.endsWith(".tmp"));
  assert.equal(tmps.length, 0, `expected no leftover .tmp files; found: ${tmps.join(",")}`);
});
