import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Store, trackerPath } from "../hub/store.js";
import { makeWorkspace, validProject } from "./fixtures.js";

test("applySwimlaneMove reorders swimlanes in memory and on disk", async () => {
  const ws = makeWorkspace("llm-tracker-swimlane-");
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const moved = await store.applySwimlaneMove("test-project", {
      swimlaneId: "ops",
      direction: "up"
    });
    assert.equal(moved.ok, true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(
      after.meta.swimlanes.map((lane) => lane.id),
      ["ops", "exec"]
    );
    assert.deepEqual(
      store.get("test-project").data.meta.swimlanes.map((lane) => lane.id),
      ["ops", "exec"]
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("applySwimlaneMove no-ops at the boundary", async () => {
  const ws = makeWorkspace("llm-tracker-swimlane-");
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const moved = await store.applySwimlaneMove("test-project", {
      swimlaneId: "exec",
      direction: "up"
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.noop, true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(
      after.meta.swimlanes.map((lane) => lane.id),
      ["exec", "ops"]
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
