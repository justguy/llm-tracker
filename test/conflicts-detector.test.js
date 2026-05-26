import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFLICT_KINDS, detectConflicts } from "../hub/conflicts/detector.js";

function repoChange(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "evt_1",
    ts: "2026-05-26T16:00:00.000Z",
    type: "repo.change",
    source: "watcher",
    workspace: "/workspace",
    projectSlug: "demo",
    repoRoot: "/repo",
    path: "src/app.js",
    event: "change",
    activeSessionIds: ["ses_1"],
    possibleSessionIds: ["ses_1"],
    attribution: "single_active_session",
    relatedTaskIds: ["task-1"],
    ...overrides,
  };
}

test("CONFLICT_KINDS declares every TDD §9.5 conflict warning kind", () => {
  assert.deepEqual([...CONFLICT_KINDS], [
    "multiple_sessions_same_file",
    "multiple_sessions_same_worktree",
    "outside_allowed_paths",
    "task_claim_conflict",
    "stale_tracker_rev",
  ]);
});

test("detectConflicts detects multiple_sessions_same_file from watcher events", () => {
  const conflicts = detectConflicts({
    repoEvents: [
      repoChange({ id: "evt_1", activeSessionIds: ["ses_1"] }),
      repoChange({ id: "evt_2", activeSessionIds: ["ses_2"] }),
      repoChange({ id: "evt_3", path: "src/other.js", activeSessionIds: ["ses_3"] }),
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "multiple_sessions_same_file");
  assert.equal(conflicts[0].conflictId, conflicts[0].id);
  assert.equal(conflicts[0].projectSlug, "demo");
  assert.equal(conflicts[0].repoRoot, "/repo");
  assert.equal(conflicts[0].path, "src/app.js");
  assert.deepEqual(conflicts[0].activeSessionIds, ["ses_1", "ses_2"]);
  assert.deepEqual(conflicts[0].eventIds, ["evt_1", "evt_2"]);
});

test("detectConflicts detects multiple_sessions_same_file from one ambiguous event", () => {
  const conflicts = detectConflicts({
    repoEvents: [repoChange({ activeSessionIds: ["ses_1", "ses_2"], attribution: "ambiguous" })],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "multiple_sessions_same_file");
  assert.deepEqual(conflicts[0].activeSessionIds, ["ses_1", "ses_2"]);
});

test("detectConflicts detects multiple_sessions_same_worktree for active sessions only", () => {
  const conflicts = detectConflicts({
    sessions: [
      { id: "ses_1", projectSlug: "demo", worktreePath: "/repo-wt", status: "active" },
      { id: "ses_2", projectSlug: "demo", worktreePath: "/repo-wt", status: "running" },
      { id: "ses_old", projectSlug: "demo", worktreePath: "/repo-wt", status: "completed" },
      { id: "ses_other", projectSlug: "demo", worktreePath: "/repo-other", status: "active" },
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "multiple_sessions_same_worktree");
  assert.equal(conflicts[0].worktreePath, "/repo-wt");
  assert.deepEqual(conflicts[0].activeSessionIds, ["ses_1", "ses_2"]);
  assert.equal(conflicts[0].recommendedActions[0].kind, "create_worktree");
});

test("detectConflicts emits outside_allowed_paths from task allowed_paths evidence", () => {
  const conflicts = detectConflicts({
    repoEvents: [repoChange({ id: "evt_oap", path: "docs/readme.md" })],
    tasks: [
      {
        id: "task-1",
        repos: { primary: { root: "/repo", allowed_paths: ["src/**"] } },
      },
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "outside_allowed_paths");
  assert.equal(conflicts[0].taskId, "task-1");
  assert.equal(conflicts[0].repoRoot, "/repo");
  assert.deepEqual(conflicts[0].paths, ["docs/readme.md"]);
  assert.equal(conflicts[0].evidenceRef, "evt_oap");
});

test("detectConflicts avoids duplicate outside_allowed_paths for pre-annotated events", () => {
  const conflicts = detectConflicts({
    repoEvents: [repoChange({ id: "evt_oap", path: "docs/readme.md", outsideAllowedPaths: true })],
    tasks: [
      {
        id: "task-1",
        repos: { primary: { root: "/repo", allowed_paths: ["src/**"] } },
      },
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "outside_allowed_paths");
  assert.equal(conflicts[0].evidenceRef, "evt_oap");
});

test("detectConflicts does not emit outside_allowed_paths when allowed_paths is absent", () => {
  const conflicts = detectConflicts({
    repoEvents: [repoChange({ id: "evt_absent", path: "docs/readme.md" })],
    tasks: [{ id: "task-1", repos: { primary: { root: "/repo" } } }],
  });

  assert.deepEqual(conflicts, []);
});

test("detectConflicts detects task_claim_conflict from launch claim results", () => {
  const conflicts = detectConflicts({
    projectSlug: "demo",
    claimResults: [
      {
        taskId: "task-1",
        result: { ok: false, error: "task_claim_conflict", activeJobId: "job_active" },
      },
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "task_claim_conflict");
  assert.equal(conflicts[0].taskId, "task-1");
  assert.equal(conflicts[0].activeJobId, "job_active");
});

test("detectConflicts detects task_claim_conflict from duplicate active jobs", () => {
  const conflicts = detectConflicts({
    jobs: [
      { id: "job_1", projectSlug: "demo", taskId: "task-1", status: "running" },
      { id: "job_2", projectSlug: "demo", taskId: "task-1", status: "blocked" },
      { id: "job_done", projectSlug: "demo", taskId: "task-1", status: "completed" },
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "task_claim_conflict");
  assert.deepEqual(conflicts[0].activeJobIds, ["job_1", "job_2"]);
});

test("detectConflicts detects stale_tracker_rev from direct rev evidence", () => {
  const conflicts = detectConflicts({
    projectSlug: "demo",
    taskId: "task-1",
    expectedTrackerRev: 7,
    currentTrackerRev: 9,
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "stale_tracker_rev");
  assert.equal(conflicts[0].expectedTrackerRev, 7);
  assert.equal(conflicts[0].currentRev, 9);
});

test("detectConflicts detects stale_tracker_rev from launch claim results", () => {
  const conflicts = detectConflicts({
    projectSlug: "demo",
    claimResults: [
      {
        taskId: "task-1",
        expectedTrackerRev: 3,
        result: { ok: false, error: "stale_tracker_rev", currentRev: 4 },
      },
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "stale_tracker_rev");
  assert.equal(conflicts[0].expectedTrackerRev, 3);
  assert.equal(conflicts[0].currentTrackerRev, 4);
});

test("detectConflicts dedupes stable conflicts by id", () => {
  const conflicts = detectConflicts({
    repoEvents: [
      repoChange({ id: "evt_1", activeSessionIds: ["ses_1", "ses_2"] }),
      repoChange({ id: "evt_1", activeSessionIds: ["ses_2", "ses_1"] }),
    ],
  });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "multiple_sessions_same_file");
});
