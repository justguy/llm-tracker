import assert from "node:assert/strict";
import test from "node:test";

import { registerDiffRoutes } from "../../api/diffs.js";
import { detectConflicts } from "../../conflicts/detector.js";
import { buildChangedSincePayload } from "../changed-since.js";
import {
  DIFF_REVIEW_FORBIDDEN_PERSISTED_KEYS,
  DiffReviewService,
  annotateDiffAllowedPathWarnings,
  annotateDiffConflictWarnings,
  createDiffReviewRecord,
} from "../diff-review-service.js";
import { annotateProviderFileChanges } from "../provider-file-changes.js";
import { collectGitDiff } from "../git-diff.js";
import { makeRuntimeId } from "../../runtime/ids.js";
import { deriveActivity } from "../../sessions/activity.js";

const REPO_ROOT = "/tmp/phase7a/repo";
const SESSION_ID = makeRuntimeId("ses");
const OTHER_SESSION_ID = makeRuntimeId("ses");
const JOB_ID = makeRuntimeId("job");
const EVENT_A = makeRuntimeId("evt");
const EVENT_B = makeRuntimeId("evt");

test("Phase 7A acceptance: DiffReviewRecord persists metadata only", () => {
  const service = new DiffReviewService({
    now: () => "2026-05-30T00:00:00.000Z",
    makeId: () => "dfr_phase7a",
  });

  const record = service.create({
    projectSlug: "llm-tracker",
    taskId: "task-7a",
    jobId: JOB_ID,
    sessionId: SESSION_ID,
    baseRev: 42,
    baseGitSha: "1111111",
    evidenceRefs: [EVENT_A],
  });

  assert.deepEqual(record, {
    id: "dfr_phase7a",
    projectSlug: "llm-tracker",
    taskId: "task-7a",
    jobId: JOB_ID,
    sessionId: SESSION_ID,
    baseRev: 42,
    baseGitSha: "1111111",
    status: "open",
    evidenceRefs: [EVENT_A],
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
  });
  assert.equal(Object.hasOwn(record, "files"), false);
  assert.equal(Object.hasOwn(record, "patch"), false);
  for (const key of DIFF_REVIEW_FORBIDDEN_PERSISTED_KEYS) {
    assert.throws(
      () => createDiffReviewRecord({ projectSlug: "llm-tracker", [key]: "diff --git ..." }),
      new RegExp(`must not persist diff content field '${key}'`),
    );
  }

  const reviewed = service.updateStatus("dfr_phase7a", "reviewed", {
    evidenceRefs: [EVENT_B],
  });
  assert.equal(reviewed.status, "reviewed");
  assert.deepEqual(reviewed.evidenceRefs, [EVENT_A, EVENT_B]);
});

test("Phase 7A acceptance: changed-since combines tracker and git diff evidence", async () => {
  const gitCalls = [];

  const changed = await buildChangedSincePayload({
    slug: "llm-tracker",
    fromRev: 42,
    repoRoot: REPO_ROOT,
    baseGitSha: "1111111",
    changed: { rev: 45, tasks: [{ id: "task-7a", changedKeys: ["status"] }] },
    since: { fromRev: 42, currentRev: 45, events: [{ rev: 43 }] },
    runGit: fakeRunGit(gitCalls),
    now: () => "2026-05-30T00:01:00.000Z",
    includePatch: true,
  });

  assert.equal(changed.projectSlug, "llm-tracker");
  assert.equal(changed.currentRev, 45);
  assert.equal(changed.base.baseGitSha, "1111111");
  assert.equal(changed.base.headGitSha, "2222222");
  assert.equal(changed.git.ok, true);
  assert.deepEqual(
    changed.git.files.map((file) => [file.status, file.path, file.additions, file.deletions]),
    [
      ["M", "docs/guide.md", 2, 0],
      ["M", "src/app.js", 1, 1],
    ],
  );
  assert.deepEqual(gitCalls.map((call) => call.args), [
    ["rev-parse", "HEAD"],
    ["status", "--short", "--branch"],
    ["diff", "--stat", "1111111..2222222"],
    ["diff", "--name-status", "--find-renames", "1111111..2222222"],
    ["diff", "--numstat", "1111111..2222222"],
    ["diff", "1111111..2222222"],
  ]);

  const pathFilteredCalls = [];
  const pathFiltered = await collectGitDiff({
    repoRoot: REPO_ROOT,
    baseGitSha: "1111111",
    baseHead: {
      baseRev: 42,
      baseGitSha: "1111111",
      headGitSha: "2222222",
      unavailable: false,
      commands: {},
    },
    paths: ["src/app.js"],
    runGit: fakeRunGit(pathFilteredCalls),
  });
  assert.equal(pathFiltered.ok, true);
  assert.deepEqual(pathFilteredCalls.map((call) => call.args).slice(1, 4), [
    ["diff", "--stat", "1111111..2222222", "--", "src/app.js"],
    ["diff", "--name-status", "--find-renames", "1111111..2222222", "--", "src/app.js"],
    ["diff", "--numstat", "1111111..2222222", "--", "src/app.js"],
  ]);
});

test("Phase 7A acceptance: provider annotations preserve conflict warnings", () => {
  const files = [
    {
      path: "src/app.js",
      hasConflicts: true,
      conflictIds: ["cf-existing"],
    },
  ];

  const annotated = annotateProviderFileChanges(files, {
    providerEvents: [
      {
        kind: "file_change.applied",
        providerId: "codex_app_server",
        sessionId: SESSION_ID,
        threadId: "thread-1",
        proposalId: "proposal-1",
        ts: "2026-05-30T00:02:00.000Z",
        files: ["src/app.js"],
      },
      {
        kind: "file_change.proposed",
        providerId: "codex_app_server",
        sessionId: SESSION_ID,
        threadId: "thread-1",
        proposalId: "proposal-2",
        ts: "2026-05-30T00:02:30.000Z",
        files: ["unmatched.js"],
      },
    ],
  });

  assert.equal(annotated.providerItems.length, 2);
  assert.equal(annotated.unmatchedProviderItems.length, 1);
  assert.equal(annotated.unmatchedProviderItems[0].path, "unmatched.js");
  assert.equal(annotated.files[0].providerItems[0].phase, "applied");
  assert.equal(annotated.files[0].hasConflicts, true);
  assert.deepEqual(annotated.files[0].conflictIds, ["cf-existing"]);
});

test("Phase 7A acceptance: diff rows surface allowed-path and active conflict evidence", () => {
  const files = [
    { path: "docs/guide.md", filePath: `${REPO_ROOT}/docs/guide.md` },
    { path: "src/app.js", filePath: `${REPO_ROOT}/src/app.js` },
  ];
  const task = {
    id: "task-7a",
    repos: { primary: { root: REPO_ROOT, allowed_paths: ["docs/**"] } },
  };
  const allowed = annotateDiffAllowedPathWarnings(files, { task, repoRoot: REPO_ROOT });
  const conflicts = detectConflicts({
    projectSlug: "llm-tracker",
    repoEvents: [
      repoChange({ id: EVENT_A, path: "src/app.js", activeSessionIds: [SESSION_ID] }),
      repoChange({ id: EVENT_B, path: "src/app.js", activeSessionIds: [OTHER_SESSION_ID] }),
    ],
  });
  const conflictAnnotated = annotateDiffConflictWarnings(allowed.files, conflicts, {
    repoRoot: REPO_ROOT,
  });

  assert.equal(conflictAnnotated.files[0].outsideAllowedPaths, undefined);
  assert.equal(conflictAnnotated.files[1].outsideAllowedPaths, true);
  assert.equal(conflictAnnotated.files[1].allowedPathWarningDetails[0].path, "src/app.js");
  assert.equal(conflictAnnotated.files[1].hasConflicts, true);
  assert.equal(conflictAnnotated.conflictDetails[0].kind, "multiple_sessions_same_file");

  const noAllowedPaths = annotateDiffAllowedPathWarnings(files, {
    task: { id: "task-7a" },
    repoRoot: REPO_ROOT,
  });
  assert.deepEqual(noAllowedPaths.allowedPathWarnings, []);
  assert.equal(noAllowedPaths.files[1].outsideAllowedPaths, undefined);

  const worktreeConflicts = detectConflicts({
    projectSlug: "llm-tracker",
    sessions: [
      { id: SESSION_ID, status: "running", worktreePath: REPO_ROOT },
      { id: OTHER_SESSION_ID, status: "running", worktreePath: REPO_ROOT },
    ],
  });
  assert.equal(worktreeConflicts[0].kind, "multiple_sessions_same_worktree");
  assert.equal(worktreeConflicts[0].recommendedActions[0].kind, "create_worktree");
});

test("Phase 7A acceptance: dumb-terminal session diff works from git and watcher evidence alone", async () => {
  const activity = deriveActivity(
    {
      id: SESSION_ID,
      tier: "dumb_terminal",
      status: "active",
      startedAt: "2026-05-30T00:00:00.000Z",
      lastOutputAt: "2026-05-30T00:00:00.000Z",
    },
    new Date("2026-05-30T00:30:00.000Z"),
  );
  assert.equal(activity.state, "quiet");
  assert.deepEqual(activity.warnings.map((warning) => warning.kind), ["quiet_terminal"]);

  const gitCalls = [];
  const harness = makeDiffHarness({
    runGit: fakeRunGit(gitCalls),
    runtimeEvents: [
      repoChange({ id: EVENT_A, path: "src/app.js", activeSessionIds: [SESSION_ID] }),
      repoChange({ id: EVENT_B, path: "src/app.js", activeSessionIds: [OTHER_SESSION_ID] }),
    ],
    providerEvents: [],
    providerTimelineItems: [],
  });

  const response = await harness.getDiff(SESSION_ID);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const review = response.body.diffReview;
  assert.equal(review.sessionId, SESSION_ID);
  assert.equal(review.jobId, JOB_ID);
  assert.equal(review.baseRev, 42);
  assert.equal(review.baseGitSha, "1111111");
  assert.equal(review.headGitSha, "2222222");
  assert.deepEqual(
    review.files.map((file) => file.path),
    ["docs/guide.md", "src/app.js"],
  );
  assert.deepEqual(review.providerItems, []);
  assert.deepEqual(review.unmatchedProviderItems, []);
  assert.deepEqual(review.watcherEvidence, [EVENT_A]);
  assert.equal(review.files.find((file) => file.path === "src/app.js").outsideAllowedPaths, true);
  assert.equal(review.files.find((file) => file.path === "src/app.js").hasConflicts, true);
  assert.equal(review.tabs.gitDiff.commands.patch.ok, true);
  assert.equal(review.tabs.providerProposals.items.length, 0);
  assert.equal(review.tabs.allowedPaths.warnings.length, 1);
  assert.equal(review.tabs.conflicts.conflictIds.length, 1);
  assert.deepEqual(gitCalls.map((call) => call.args).slice(0, 2), [
    ["rev-parse", "HEAD"],
    ["status", "--short", "--branch"],
  ]);
});

function makeDiffHarness({
  runtimeEvents = [],
  providerEvents = [],
  providerTimelineItems = [],
  runGit,
} = {}) {
  const routes = new Map();
  const app = {
    get(path, handler) {
      routes.set(path, handler);
    },
  };
  const project = {
    rev: 45,
    data: {
      meta: { slug: "llm-tracker", rev: 45 },
      tasks: [
        {
          id: "task-7a",
          status: "in_progress",
          repos: { primary: { root: REPO_ROOT, allowed_paths: ["docs/**"] } },
        },
      ],
    },
  };
  registerDiffRoutes(app, {
    store: {
      get(slug) {
        return slug === "llm-tracker" ? project : null;
      },
      getSince(slug, fromRev) {
        return { fromRev, currentRev: project.rev, events: [] };
      },
      history() {
        return { events: [] };
      },
    },
    projection: {
      rev: 45,
      toSnapshots() {
        return {
          sessions: [
            {
              id: SESSION_ID,
              kind: "dumb_terminal",
              providerId: "generic_pty",
              projectSlug: "llm-tracker",
              taskId: "task-7a",
              activeJobId: JOB_ID,
              repoRoot: REPO_ROOT,
            },
            {
              id: OTHER_SESSION_ID,
              kind: "dumb_terminal",
              providerId: "generic_pty",
              projectSlug: "llm-tracker",
              repoRoot: REPO_ROOT,
            },
          ],
          jobs: [
            {
              id: JOB_ID,
              sessionId: SESSION_ID,
              projectSlug: "llm-tracker",
              taskId: "task-7a",
              startRev: 42,
              baseGitSha: "1111111",
              status: "running",
              repoRoot: REPO_ROOT,
            },
          ],
        };
      },
    },
    getRuntimeEvents: () => runtimeEvents,
    getProviderEvents: () => providerEvents,
    getProviderTimelineItems: () => providerTimelineItems,
    runGit,
  });

  return {
    async getDiff(sessionId, query = {}) {
      const handler = routes.get("/api/sessions/:sessionId/diff");
      assert.equal(typeof handler, "function");
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      };
      await handler({ params: { sessionId }, query }, res);
      return res;
    },
  };
}

function fakeRunGit(calls = []) {
  return async (args, options = {}) => {
    calls.push({ args: args.slice(), cwd: options.cwd });
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return gitResult("2222222\n");
    if (key === "status --short --branch") {
      return gitResult("## feature/v2\n M docs/guide.md\n M src/app.js\n");
    }
    if (key.startsWith("diff --stat ")) {
      return gitResult(" docs/guide.md | 2 ++\n src/app.js | 2 +-\n");
    }
    if (key.startsWith("diff --name-status --find-renames ")) {
      return gitResult("M\tdocs/guide.md\nM\tsrc/app.js\n");
    }
    if (key.startsWith("diff --numstat ")) {
      return gitResult("2\t0\tdocs/guide.md\n1\t1\tsrc/app.js\n");
    }
    if (key.startsWith("diff ")) {
      return gitResult("diff --git a/docs/guide.md b/docs/guide.md\n");
    }
    return gitResult("");
  };
}

function gitResult(stdout) {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

function repoChange(overrides = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-30T00:03:00.000Z",
    type: "repo.change",
    source: "watcher",
    workspace: "/tmp/phase7a",
    projectSlug: "llm-tracker",
    repoRoot: REPO_ROOT,
    path: "src/app.js",
    event: "change",
    activeSessionIds: [],
    possibleSessionIds: [],
    ...overrides,
  };
}
