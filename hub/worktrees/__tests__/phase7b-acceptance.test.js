import assert from "node:assert/strict";
import test from "node:test";

import { conflictRule } from "../../attention/rules/conflict.js";
import { wrapRuleWithAutoClear } from "../../attention/rules/auto_clear.js";
import { detectConflicts } from "../../conflicts/detector.js";
import {
  WORKTREE_ARCHIVE_CONFIRMATION,
  WORKTREE_DELETE_CONFIRMATION,
  WORKTREE_ERROR_CODES,
  WorktreeService,
} from "../worktree-service.js";

const REPO_ROOT = "/tmp/phase7b/repo";
const WORKTREE_PATH = "/tmp/phase7b/repo-worktrees/task-123";

function successfulGitRecorder(calls) {
  return async (args, options = {}) => {
    calls.push({ args: args.slice(), cwd: options.cwd });
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  };
}

function serviceWithClock(options = {}) {
  const stamps = options.stamps?.slice() || [
    "2026-05-30T00:00:00.000Z",
    "2026-05-30T00:01:00.000Z",
    "2026-05-30T00:02:00.000Z",
    "2026-05-30T00:03:00.000Z",
  ];
  return new WorktreeService({
    now: () => stamps.shift() || "2026-05-30T00:09:00.000Z",
    makeId: () => "wt_phase7b",
    ...options,
  });
}

async function createWorktree(service, overrides = {}) {
  const result = await service.create({
    projectSlug: "llm-tracker",
    repoRoot: REPO_ROOT,
    path: WORKTREE_PATH,
    taskId: "task-123",
    jobId: "job-123",
    sessionId: "ses-123",
    branch: "feature/session-worktree",
    baseRef: "origin/main",
    reason: "launch dedicated worktree",
    ...overrides,
  });
  assert.equal(result.ok, true);
  return result.worktree;
}

test("Phase 7B acceptance: WorktreeService creates and initially binds worktree metadata", async () => {
  const calls = [];
  const service = serviceWithClock({ runGit: successfulGitRecorder(calls) });

  const worktree = await createWorktree(service);

  assert.equal(worktree.id, "wt_phase7b");
  assert.equal(worktree.status, "active");
  assert.equal(worktree.branch, "feature/session-worktree");
  assert.equal(worktree.baseRef, "origin/main");
  assert.equal(worktree.createdAt, "2026-05-30T00:00:00.000Z");
  assert.deepEqual(worktree.bindings, [
    {
      projectSlug: "llm-tracker",
      taskId: "task-123",
      jobId: "job-123",
      sessionId: "ses-123",
      reason: "launch dedicated worktree",
      boundAt: "2026-05-30T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(calls, [
    {
      args: ["worktree", "add", WORKTREE_PATH, "origin/main"],
      cwd: REPO_ROOT,
    },
  ]);
});

test("Phase 7B acceptance: WorktreeService bind reactivates and records a new binding", async () => {
  const calls = [];
  const service = serviceWithClock({ runGit: successfulGitRecorder(calls) });
  await createWorktree(service);
  await service.archive({
    id: "wt_phase7b",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    reason: "closeout complete",
  });

  const rebound = service.bind({
    worktreePath: WORKTREE_PATH,
    taskId: "task-456",
    jobId: "job-456",
    sessionId: "ses-456",
    reason: "resume task in existing worktree",
  });

  assert.equal(rebound.ok, true);
  assert.equal(rebound.worktree.status, "active");
  assert.equal(rebound.worktree.archivedAt, null);
  assert.equal(rebound.worktree.archiveReason, null);
  assert.equal(rebound.worktree.taskId, "task-456");
  assert.equal(rebound.worktree.jobId, "job-456");
  assert.equal(rebound.worktree.sessionId, "ses-456");
  assert.deepEqual(rebound.worktree.bindings.at(-1), {
    projectSlug: null,
    taskId: "task-456",
    jobId: "job-456",
    sessionId: "ses-456",
    reason: "resume task in existing worktree",
    boundAt: "2026-05-30T00:02:00.000Z",
  });
});

test("Phase 7B acceptance: archive requires confirmation and reason before metadata closeout", async () => {
  const calls = [];
  const service = serviceWithClock({ runGit: successfulGitRecorder(calls) });
  await createWorktree(service);

  const missingConfirmation = await service.archive({ id: "wt_phase7b", reason: "done" });
  assert.equal(missingConfirmation.ok, false);
  assert.equal(
    missingConfirmation.error.code,
    WORKTREE_ERROR_CODES.ARCHIVE_CONFIRMATION_REQUIRED,
  );

  const missingReason = await service.archive({
    id: "wt_phase7b",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
  });
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.error.code, WORKTREE_ERROR_CODES.ARCHIVE_REASON_REQUIRED);

  const archived = await service.archive({
    id: "wt_phase7b",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    reason: "closeout complete",
  });

  assert.equal(archived.ok, true);
  assert.equal(archived.worktree.status, "archived");
  assert.equal(archived.worktree.archivedAt, "2026-05-30T00:01:00.000Z");
  assert.equal(archived.worktree.archiveReason, "closeout complete");
  assert.equal(archived.worktree.deletedFromDisk, false);
  assert.equal(archived.worktree.deletedAt, null);
  assert.deepEqual(calls.map((call) => call.args), [
    ["worktree", "add", WORKTREE_PATH, "origin/main"],
  ]);
});

test("Phase 7B acceptance: destructive archive runs clean delete safety checks in order", async () => {
  const calls = [];
  const service = serviceWithClock({
    runGit: async (args, options = {}) => {
      calls.push({ args: args.slice(), cwd: options.cwd });
      if (args[0] === "status") {
        return { exitCode: 0, stdout: "## main...origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await createWorktree(service);

  const archived = await service.archive({
    id: "wt_phase7b",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    deleteConfirmation: WORKTREE_DELETE_CONFIRMATION,
    deleteFromDisk: true,
    reason: "closeout complete",
  });

  assert.equal(archived.ok, true);
  assert.equal(archived.worktree.deletedFromDisk, true);
  assert.equal(archived.worktree.deletedAt, "2026-05-30T00:01:00.000Z");
  assert.deepEqual(calls.map((call) => call.args), [
    ["worktree", "add", WORKTREE_PATH, "origin/main"],
    ["status", "--porcelain=v1", "--branch"],
    ["rev-list", "--count", "HEAD", "--not", "--remotes"],
    ["worktree", "remove", WORKTREE_PATH],
  ]);
  assert.deepEqual(calls.map((call) => call.cwd), [
    REPO_ROOT,
    WORKTREE_PATH,
    WORKTREE_PATH,
    REPO_ROOT,
  ]);
});

test("Phase 7B acceptance: destructive archive refuses dirty or in-flight worktrees", async () => {
  const dirty = serviceWithClock({
    runGit: async (args) => {
      if (args[0] === "status") {
        return { exitCode: 0, stdout: "## main...origin/main\n M package.json\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await createWorktree(dirty);
  const dirtyArchive = await dirty.archive({
    id: "wt_phase7b",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    deleteConfirmation: WORKTREE_DELETE_CONFIRMATION,
    deleteFromDisk: true,
    reason: "closeout complete",
  });
  assert.equal(dirtyArchive.ok, false);
  assert.equal(
    dirtyArchive.error.code,
    WORKTREE_ERROR_CODES.DELETE_UNCOMMITTED_CHANGES_REFUSED,
  );

  const inFlight = serviceWithClock({
    runGit: async (args) => {
      if (args[0] === "status") {
        return { exitCode: 0, stdout: "## main...origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { exitCode: 0, stdout: "2\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await createWorktree(inFlight);
  const inFlightArchive = await inFlight.archive({
    id: "wt_phase7b",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    deleteConfirmation: WORKTREE_DELETE_CONFIRMATION,
    deleteFromDisk: true,
    reason: "closeout complete",
  });
  assert.equal(inFlightArchive.ok, false);
  assert.equal(
    inFlightArchive.error.code,
    WORKTREE_ERROR_CODES.DELETE_IN_FLIGHT_COMMITS_REFUSED,
  );
});

test("Phase 7B acceptance: dedicated worktree binding clears shared-worktree conflicts", () => {
  const sharedInput = {
    projectSlug: "llm-tracker",
    sessions: [
      { id: "ses-a", status: "running", worktreePath: "/tmp/project" },
      { id: "ses-b", status: "running", worktreePath: "/tmp/project" },
    ],
  };

  const conflicts = detectConflicts(sharedInput);
  const shared = conflicts.find((conflict) => conflict.kind === "multiple_sessions_same_worktree");
  assert.ok(shared);
  assert.deepEqual(shared.sessionIds, ["ses-a", "ses-b"]);
  assert.equal(shared.recommendedActions[0].kind, "create_worktree");
  assert.equal(shared.recommendedActions[1].kind, "acknowledge");
  assert.equal(shared.recommendedActions[2].kind, "view_conflict");

  const cleared = detectConflicts({
    ...sharedInput,
    sessions: [
      { id: "ses-a", status: "running", worktreePath: "/tmp/project" },
      { id: "ses-b", status: "running", worktreePath: "/tmp/project-worktrees/task-123" },
    ],
  });
  assert.equal(
    cleared.some((conflict) => conflict.kind === "multiple_sessions_same_worktree"),
    false,
  );
});

test("Phase 7B acceptance: conflict attention emits a clear marker after worktree conflict disappears", () => {
  let id = 0;
  const wrapped = wrapRuleWithAutoClear(conflictRule);
  const conflicts = detectConflicts({
    projectSlug: "llm-tracker",
    sessions: [
      { id: "ses-a", status: "running", worktreePath: "/tmp/project" },
      { id: "ses-b", status: "running", worktreePath: "/tmp/project" },
    ],
  });

  const firstTick = wrapped({
    conflicts,
    now: new Date("2026-05-30T00:00:00.000Z"),
    makeId: (prefix) => `${prefix}-${++id}`,
  });
  assert.equal(firstTick.length, 1);
  assert.equal(firstTick[0].evidenceRef, conflicts[0].id);
  assert.equal(firstTick[0].clearedAt, undefined);

  const secondTick = wrapped({
    conflicts: [],
    now: new Date("2026-05-30T00:01:00.000Z"),
    makeId: (prefix) => `${prefix}-${++id}`,
  });
  assert.equal(secondTick.length, 1);
  assert.equal(secondTick[0].evidenceRef, conflicts[0].id);
  assert.equal(secondTick[0].clearedAt, "2026-05-30T00:01:00.000Z");
});
