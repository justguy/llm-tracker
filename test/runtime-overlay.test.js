import { spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store, trackerPath } from "../hub/store.js";
import { loadProjectEntry } from "../hub/project-loader.js";
import { runtimeOverlayPath } from "../hub/runtime-overlay.js";
import { validProject } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, "..", "bin", "llm-tracker.js");

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-overlay-"));
  for (const sub of ["trackers", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# overlay test\n");
  return ws;
}

test("linked tracker patches write the repo-local target as the only truth", async () => {
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
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").blocker_reason, "waiting on deploy");

    const overlayFile = runtimeOverlayPath(workspace, slug);
    assert.equal(existsSync(overlayFile), false);
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("project-loader reads linked tracker state from the repo-local target", async () => {
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

test("project-loader ignores legacy overlays for linked repo-local truth", async () => {
  const workspace = setupWorkspace();
  const repo = mkdtempSync(join(tmpdir(), "llm-tracker-overlay-legacy-"));
  const slug = "linked";
  const targetPath = join(repo, "linked.json");
  const targetBody = validProject({
    meta: { ...validProject().meta, slug, scratchpad: "" },
    tasks: validProject().tasks.map((task) => ({ ...task, assignee: null, blocker_reason: null }))
  });
  writeFileSync(targetPath, JSON.stringify(targetBody, null, 2));
  symlinkSync(targetPath, trackerPath(workspace, slug));
  mkdirSync(join(workspace, ".runtime", "overlays"), { recursive: true });
  writeFileSync(
    runtimeOverlayPath(workspace, slug),
    JSON.stringify(
      {
        meta: { scratchpad: "legacy banner", rev: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
        tasks: { t1: { status: "complete", assignee: "codex" } }
      },
      null,
      2
    )
  );

  try {
    const loaded = loadProjectEntry(workspace, slug);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.data.meta.scratchpad, "");
    assert.equal(loaded.data.tasks.find((task) => task.id === "t1").status, "not_started");
    assert.equal(loaded.data.tasks.find((task) => task.id === "t1").assignee, null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("store ingest clears legacy linked-tracker overlays without materializing them", async () => {
  const workspace = setupWorkspace();
  const repo = mkdtempSync(join(tmpdir(), "llm-tracker-overlay-materialize-"));
  const slug = "linked";
  const targetPath = join(repo, "linked.json");
  const targetBody = validProject({
    meta: { ...validProject().meta, slug, scratchpad: "" },
    tasks: validProject().tasks.map((task) => ({ ...task, assignee: null, blocker_reason: null }))
  });
  writeFileSync(targetPath, JSON.stringify(targetBody, null, 2));
  symlinkSync(targetPath, trackerPath(workspace, slug));
  mkdirSync(join(workspace, ".runtime", "overlays"), { recursive: true });
  writeFileSync(
    runtimeOverlayPath(workspace, slug),
    JSON.stringify(
      {
        meta: { scratchpad: "legacy banner", rev: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
        tasks: { t1: { status: "complete", assignee: "codex" } }
      },
      null,
      2
    )
  );

  try {
    const store = new Store(workspace);
    const linkPath = trackerPath(workspace, slug);
    const result = store.ingest(linkPath, readFileSync(linkPath, "utf-8"));
    assert.equal(result.ok, true);
    assert.equal(existsSync(runtimeOverlayPath(workspace, slug)), false);
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);

    const onDiskTarget = JSON.parse(readFileSync(targetPath, "utf-8"));
    assert.equal(onDiskTarget.meta.scratchpad, "");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").status, "not_started");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").assignee, null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repair-linked-overlays explicitly materializes legacy overlays into linked tracker targets", () => {
  const workspace = setupWorkspace();
  const repo = mkdtempSync(join(tmpdir(), "llm-tracker-overlay-repair-"));
  const slug = "linked";
  const targetPath = join(repo, "linked.json");
  const targetBody = validProject({
    meta: { ...validProject().meta, slug, scratchpad: "" },
    tasks: validProject().tasks.map((task) => ({ ...task, assignee: null, blocker_reason: null }))
  });
  writeFileSync(targetPath, JSON.stringify(targetBody, null, 2));
  symlinkSync(targetPath, trackerPath(workspace, slug));
  mkdirSync(join(workspace, ".runtime", "overlays"), { recursive: true });
  writeFileSync(
    runtimeOverlayPath(workspace, slug),
    JSON.stringify(
      {
        meta: { scratchpad: "legacy banner", rev: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
        tasks: { t1: { status: "complete", assignee: "codex" } }
      },
      null,
      2
    )
  );

  try {
    const dryRun = spawnSync(
      process.execPath,
      [BIN, "repair-linked-overlays", "--path", workspace, "--json"],
      { encoding: "utf-8", timeout: 10000 }
    );
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.equal(JSON.parse(dryRun.stdout).results[0].action, "repair");
    assert.equal(existsSync(runtimeOverlayPath(workspace, slug)), true);

    const repaired = spawnSync(
      process.execPath,
      [BIN, "repair-linked-overlays", "--path", workspace, "--write", "--json"],
      { encoding: "utf-8", timeout: 10000 }
    );
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    assert.equal(existsSync(runtimeOverlayPath(workspace, slug)), false);

    const onDiskTarget = JSON.parse(readFileSync(targetPath, "utf-8"));
    assert.equal(onDiskTarget.meta.scratchpad, "legacy banner");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").status, "complete");
    assert.equal(onDiskTarget.tasks.find((task) => task.id === "t1").assignee, "codex");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
