import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, trackerPath } from "../hub/store.js";
import { loadProjectEntry } from "../hub/project-loader.js";
import { runtimeOverlayPath } from "../hub/runtime-overlay.js";
import { validProject } from "./fixtures.js";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-overlay-"));
  for (const sub of ["trackers", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# overlay test\n");
  return ws;
}

test("linked tracker runtime fields write through to the target file", async () => {
  const workspace = setupWorkspace();
  const repo = mkdtempSync(join(tmpdir(), "llm-tracker-overlay-repo-"));
  const slug = "linked";
  const targetPath = join(repo, "linked.json");
  const targetBody = validProject({
    meta: { ...validProject().meta, slug, scratchpad: "" },
    tasks: validProject().tasks.map((task) => ({ ...task, assignee: null, blocker_reason: null }))
  });
  writeFileSync(targetPath, JSON.stringify(targetBody, null, 2));
  symlinkSync(targetPath, trackerPath(workspace, slug));

  try {
    const store = new Store(workspace);
    const linkPath = trackerPath(workspace, slug);
    store.ingest(linkPath, readFileSync(linkPath, "utf-8"));

    const result = await store.applyPatch(slug, {
      meta: { scratchpad: "runtime banner" },
      tasks: {
        t1: { status: "complete", assignee: "codex", blocker_reason: "waiting on deploy" }
      }
    });

    assert.equal(result.ok, true);
    const entry = store.get(slug);
    assert.equal(entry.data.meta.scratchpad, "runtime banner");
    assert.equal(entry.data.tasks.find((task) => task.id === "t1").status, "complete");
    assert.equal(entry.data.tasks.find((task) => task.id === "t1").assignee, "codex");

    const onDiskTarget = JSON.parse(readFileSync(targetPath, "utf-8"));
    assert.equal(onDiskTarget.meta.scratchpad, "runtime banner");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").status, "complete");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").assignee, "codex");

    const overlayFile = runtimeOverlayPath(workspace, slug);
    assert.equal(existsSync(overlayFile), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("store ingest migrates legacy linked tracker overlays into the target file", async () => {
  const workspace = setupWorkspace();
  const repo = mkdtempSync(join(tmpdir(), "llm-tracker-overlay-loader-"));
  const slug = "linked";
  const targetPath = join(repo, "linked.json");
  const targetBody = validProject({
    meta: { ...validProject().meta, slug, scratchpad: "" },
    tasks: validProject().tasks.map((task) => ({ ...task, assignee: null, blocker_reason: null }))
  });
  writeFileSync(targetPath, JSON.stringify(targetBody, null, 2));
  symlinkSync(targetPath, trackerPath(workspace, slug));

  try {
    const linkPath = trackerPath(workspace, slug);
    const overlayFile = runtimeOverlayPath(workspace, slug);
    mkdirSync(join(workspace, ".runtime", "overlays"), { recursive: true });
    writeFileSync(
      overlayFile,
      JSON.stringify(
        {
          meta: { scratchpad: "runtime banner", rev: 12, updatedAt: "2026-06-16T00:00:00.000Z" },
          tasks: { t1: { status: "complete", assignee: "codex" } }
        },
        null,
        2
      )
    );

    const store = new Store(workspace);
    store.ingest(linkPath, readFileSync(linkPath, "utf-8"));

    const onDiskTarget = JSON.parse(readFileSync(targetPath, "utf-8"));
    assert.equal(onDiskTarget.meta.scratchpad, "runtime banner");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").status, "complete");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").assignee, "codex");
    assert.equal(existsSync(overlayFile), false);

    const loaded = loadProjectEntry(workspace, slug);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.data.meta.scratchpad, "runtime banner");
    assert.equal(loaded.data.tasks.find((task) => task.id === "t1").status, "complete");
    assert.equal(loaded.data.tasks.find((task) => task.id === "t1").assignee, "codex");
    assert.equal(loaded.data.meta.rev, store.get(slug).rev);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
