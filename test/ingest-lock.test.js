import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, trackerPath } from "../hub/store.js";
import { validProject } from "./fixtures.js";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-lock-"));
  for (const sub of ["trackers", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  return ws;
}

test("ingestLocked and applyPatch serialize through the same per-slug lock", async () => {
  const ws = setupWorkspace();
  try {
    const store = new Store(ws);
    const p = validProject();
    const file = trackerPath(ws, "test-project");
    writeFileSync(file, JSON.stringify(p));
    store.ingest(file, readFileSync(file, "utf-8"));

    const ingestPromise = store.ingestLocked(file, JSON.stringify({
      ...p,
      meta: { ...p.meta, scratchpad: "from-ingest" }
    }));
    const patchPromise = store.applyPatch("test-project", {
      meta: { scratchpad: "from-patch" }
    });

    const [ingestResult, patchResult] = await Promise.all([ingestPromise, patchPromise]);
    assert.equal(ingestResult.ok, true);
    assert.equal(patchResult.ok, true);

    const finalState = JSON.parse(readFileSync(file, "utf-8"));
    // Final scratchpad must be from whichever of the two ran last — we don't
    // care which, only that both ran cleanly without clobbering rev or tasks.
    assert.ok(["from-ingest", "from-patch"].includes(finalState.meta.scratchpad));
    assert.ok(Number.isInteger(finalState.meta.rev));
    assert.equal(finalState.tasks.length, p.tasks.length);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
