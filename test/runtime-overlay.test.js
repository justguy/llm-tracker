import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
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

test("linked tracker runtime fields persist through the workspace overlay without rewriting the target file", async () => {
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
    assert.equal(onDiskTarget.meta.scratchpad, "");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").status, "not_started");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").assignee, null);

    const overlayFile = runtimeOverlayPath(workspace, slug);
    assert.equal(existsSync(overlayFile), true);
    const overlay = JSON.parse(readFileSync(overlayFile, "utf-8"));
    assert.equal(overlay.meta.scratchpad, "runtime banner");
    assert.equal(overlay.tasks.t1.status, "complete");
    assert.equal(overlay.tasks.t1.assignee, "codex");
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("project-loader reapplies the linked tracker runtime overlay on fresh reads", async () => {
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
    const store = new Store(workspace);
    const linkPath = trackerPath(workspace, slug);
    store.ingest(linkPath, readFileSync(linkPath, "utf-8"));
    await store.applyPatch(slug, {
      meta: { scratchpad: "runtime banner" },
      tasks: { t1: { status: "complete", assignee: "codex" } }
    });

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
