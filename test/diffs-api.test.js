// test/diffs-api.test.js - SH-7A-06

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  providerEventsFromRuntimeEvents,
  providerTimelineItemsFromRuntimeEvents,
  registerDiffRoutes,
} from "../hub/api/diffs.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const TEST_TIMEOUT = 8000;
const WORKSPACE = "/tmp/lt-diffs-api";

function makeHarness({ session, job, project, runtimeEvents = [], providerEvents = [] } = {}) {
  const routes = new Map();
  const app = {
    get(path, handler) {
      routes.set(path, handler);
    },
  };
  const projection = {
    rev: 7,
    toSnapshots() {
      return {
        sessions: session ? [session] : [],
        jobs: job ? [job] : [],
      };
    },
  };
  const store = {
    get(slug) {
      return slug === "demo" ? project || null : null;
    },
    getSince(slug, fromRev) {
      return { fromRev, currentRev: project?.rev ?? null, events: [] };
    },
    history() {
      return { events: [] };
    },
  };
  registerDiffRoutes(app, {
    store,
    projection,
    getRuntimeEvents: () => runtimeEvents,
    getProviderEvents: () => providerEvents,
    runGit: fakeRunGit,
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

test("registerDiffRoutes validates required dependencies", () => {
  assert.throws(() => registerDiffRoutes(null, {}), /express app required/);
  assert.throws(() => registerDiffRoutes({ get() {} }, { projection: {} }), /store/);
  assert.throws(
    () => registerDiffRoutes({ get() {} }, { store: { get() {} } }),
    /projection/,
  );
});

test("GET /api/sessions/:sessionId/diff returns DiffReview tabs", { timeout: TEST_TIMEOUT }, async () => {
  const sessionId = makeRuntimeId("ses");
  const otherSessionId = makeRuntimeId("ses");
  const jobId = makeRuntimeId("job");
  const eventA = makeRuntimeId("evt");
  const eventB = makeRuntimeId("evt");
  const session = {
    id: sessionId,
    projectSlug: "demo",
    taskId: "task-1",
    activeJobId: jobId,
    repoRoot: "/repo",
  };
  const job = {
    id: jobId,
    sessionId,
    projectSlug: "demo",
    taskId: "task-1",
    startRev: 2,
    baseGitSha: "1111111",
    status: "running",
  };
  const project = {
    rev: 5,
    data: {
      meta: { slug: "demo", rev: 5 },
      tasks: [
        {
          id: "task-1",
          status: "in_progress",
          repos: { primary: { root: "/repo", allowed_paths: ["docs/**"] } },
        },
      ],
    },
  };
  const runtimeEvents = [
    repoChange({ id: eventA, activeSessionIds: [sessionId] }),
    repoChange({ id: eventB, activeSessionIds: [otherSessionId] }),
  ];
  const providerEvents = [
    {
      kind: "file_change.applied",
      providerId: "codex",
      sessionId,
      threadId: "thread-1",
      proposalId: "proposal-1",
      ts: "2026-05-27T10:00:00.000Z",
      files: ["src/app.js"],
    },
    {
      kind: "file_change.applied",
      providerId: "codex",
      sessionId: otherSessionId,
      threadId: "thread-2",
      proposalId: "proposal-2",
      ts: "2026-05-27T10:01:00.000Z",
      files: ["src/app.js"],
    },
  ];
  const app = makeHarness({ session, job, project, runtimeEvents, providerEvents });

  const res = await app.getDiff(sessionId);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sessionId, sessionId);
  assert.equal(res.body.projectSlug, "demo");
  assert.equal(res.body.taskId, "task-1");
  assert.equal(res.body.jobId, jobId);
  assert.equal(res.body.rev, 7);
  const review = res.body.diffReview;
  assert.equal(review.sessionId, sessionId);
  assert.equal(review.baseRev, 2);
  assert.equal(review.currentRev, 5);
  assert.equal(review.baseGitSha, "1111111");
  assert.equal(review.headGitSha, "2222222");
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0].path, "src/app.js");
  assert.equal(review.files[0].providerItems.length, 1);
  assert.equal(review.files[0].providerItems[0].sessionId, sessionId);
  assert.equal(review.files[0].outsideAllowedPaths, true);
  assert.equal(review.files[0].hasConflicts, true);
  assert.equal(review.allowedPathWarnings.length, 1);
  assert.equal(review.conflictIds.length, 1);
  assert.deepEqual(Object.keys(review.tabs), [
    "changedSince",
    "providerProposals",
    "gitDiff",
    "allowedPaths",
    "conflicts",
    "reviewerNotes",
  ]);
  assert.equal(review.tabs.gitDiff.commands.patch.ok, true);
  assert.deepEqual(review.watcherEvidence, [eventA]);
});

test("provider evidence extractors read provider payloads from runtime events", () => {
  const providerEvent = {
    kind: "file_change.proposed",
    providerId: "codex",
    sessionId: makeRuntimeId("ses"),
    threadId: "thread-1",
    proposalId: "proposal-1",
    ts: "2026-05-27T10:00:00.000Z",
    files: ["src/app.js"],
  };
  const providerTimelineItem = {
    kind: "file_change",
    providerId: "codex",
    sessionId: providerEvent.sessionId,
    ts: "2026-05-27T10:00:01.000Z",
    data: {
      phase: "applied",
      threadId: "thread-1",
      proposalId: "proposal-1",
      files: ["src/app.js"],
    },
  };

  const events = [
    { providerEvent },
    { providerEvents: [providerEvent] },
    { providerTimelineItems: [providerTimelineItem] },
    { timelineItems: [providerTimelineItem] },
  ];

  assert.deepEqual(providerEventsFromRuntimeEvents(events), [providerEvent, providerEvent]);
  assert.deepEqual(providerTimelineItemsFromRuntimeEvents(events), [
    providerTimelineItem,
    providerTimelineItem,
  ]);
});

test("GET /api/sessions/:sessionId/diff supports baseRev override", { timeout: TEST_TIMEOUT }, async () => {
  const sessionId = makeRuntimeId("ses");
  const project = { rev: 5, data: { meta: { slug: "demo", rev: 5 }, tasks: [] } };
  const session = { id: sessionId, projectSlug: "demo", repoRoot: "/repo" };
  const app = makeHarness({ session, project });

  const res = await app.getDiff(sessionId, { baseRev: "3" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.diffReview.baseRev, 3);
  assert.equal(res.body.diffReview.tabs.changedSince.since.fromRev, 3);
});

test("GET /api/sessions/:sessionId/diff rejects bad input", { timeout: TEST_TIMEOUT }, async () => {
  const sessionId = makeRuntimeId("ses");
  const app = makeHarness({
    session: { id: sessionId, projectSlug: "demo" },
    project: { rev: 5, data: { meta: { slug: "demo", rev: 5 }, tasks: [] } },
  });

  const badId = await app.getDiff("not-a-session");
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.body.error.code, "INVALID_SESSION_ID");

  const unknown = await app.getDiff(makeRuntimeId("ses"));
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, "UNKNOWN_SESSION");

  const badQuery = await app.getDiff(sessionId, { baseRev: "-1" });
  assert.equal(badQuery.statusCode, 400);
  assert.equal(badQuery.body.error.code, "INVALID_QUERY");
});

test("GET /api/sessions/:sessionId/diff reports missing project", { timeout: TEST_TIMEOUT }, async () => {
  const sessionId = makeRuntimeId("ses");
  const app = makeHarness({
    session: { id: sessionId, projectSlug: "demo" },
    project: null,
  });

  const res = await app.getDiff(sessionId);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, "PROJECT_NOT_FOUND");
});

function repoChange(overrides = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-27T10:00:00.000Z",
    type: "repo.change",
    source: "watcher",
    workspace: WORKSPACE,
    projectSlug: "demo",
    repoRoot: "/repo",
    path: "src/app.js",
    event: "change",
    activeSessionIds: [],
    possibleSessionIds: [],
    ...overrides,
  };
}

async function fakeRunGit(args) {
  const key = args.join(" ");
  if (key === "rev-parse HEAD") return gitResult("2222222\n");
  if (key === "status --short --branch") return gitResult("## feature/v2\n M src/app.js\n");
  if (key.startsWith("diff --stat ")) return gitResult(" src/app.js | 2 +-\n");
  if (key.startsWith("diff --name-status --find-renames ")) return gitResult("M\tsrc/app.js\n");
  if (key.startsWith("diff --numstat ")) return gitResult("1\t1\tsrc/app.js\n");
  if (key.startsWith("diff ")) return gitResult("diff --git a/src/app.js b/src/app.js\n");
  return gitResult("");
}

function gitResult(stdout) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}
