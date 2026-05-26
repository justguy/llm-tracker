// test/timeline-api.test.js - SH-4A-03

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTimelineAppendBatcher,
  registerTimelineRoutes,
} from "../hub/api/timeline.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const TEST_TIMEOUT = 8000;
const WORKSPACE = "/tmp/lt-timeline-api";

function makeRuntimeEvent(type, ts, extra = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts,
    type,
    source: "mcp",
    workspace: WORKSPACE,
    ...extra,
  };
}

function makeTimelineHarness({ runtimeEvents, projection }) {
  const routes = new Map();
  const app = {
    get(path, handler) {
      routes.set(path, handler);
    },
  };
  registerTimelineRoutes(app, {
    projection,
    getRuntimeEvents: () => runtimeEvents,
  });
  return {
    async getTimeline(sessionId, query = {}) {
      const handler = routes.get("/api/sessions/:sessionId/timeline");
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

function makeProjectionWithSession(sessionId, startedEvent) {
  const projection = new RuntimeProjection();
  projection.apply(startedEvent || makeRuntimeEvent("session.started", "2026-05-24T12:00:00.000Z", {
    source: "ui",
    session: {
      id: sessionId,
      name: "timeline",
      tier: "manual",
      projectSlug: "llm-tracker",
      taskId: "sh-4a-03",
    },
  }));
  return projection;
}

test("GET /api/sessions/:sessionId/timeline returns filtered TimelineItem[]", { timeout: TEST_TIMEOUT }, async () => {
  const sessionId = makeRuntimeId("ses");
  const started = makeRuntimeEvent("session.started", "2026-05-24T12:00:00.000Z", {
    source: "ui",
    session: {
      id: sessionId,
      name: "timeline",
      tier: "manual",
      projectSlug: "llm-tracker",
      taskId: "sh-4a-03",
    },
  });
  const status = makeRuntimeEvent("session.status", "2026-05-24T12:01:00.000Z", {
    sessionId,
    status: "running",
  });
  const warning = makeRuntimeEvent("session.warning", "2026-05-24T12:02:00.000Z", {
    sessionId,
    warning: { kind: "quiet_terminal", message: "quiet" },
  });
  const projection = makeProjectionWithSession(sessionId, started);
  projection.apply(status);
  projection.apply(warning);
  const app = makeTimelineHarness({
    projection,
    runtimeEvents: [warning, started, status],
  });

  const res = await app.getTimeline(sessionId, {
    since: "2026-05-24T12:01:00.000Z",
    kinds: "status,warning",
    limit: "2",
  });
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.equal(body.sessionId, sessionId);
  assert.equal(body.itemCount, 2);
  assert.equal(body.rev, projection.rev);
  assert.deepEqual(body.items.map((item) => item.kind), ["status", "warning"]);
  assert.deepEqual(body.items.map((item) => item.evidenceRef), [status.id, warning.id]);
  assert.deepEqual(body.filters.kinds, ["status", "warning"]);
});

test("GET timeline rejects bad ids, unknown sessions, and bad query values", { timeout: TEST_TIMEOUT }, async () => {
  const sessionId = makeRuntimeId("ses");
  const projection = makeProjectionWithSession(sessionId);
  const app = makeTimelineHarness({ projection, runtimeEvents: [] });

  const badId = await app.getTimeline("not-a-session");
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.body.error.code, "INVALID_SESSION_ID");

  const unknownId = makeRuntimeId("ses");
  const unknown = await app.getTimeline(unknownId);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, "UNKNOWN_SESSION");

  const badSince = await app.getTimeline(sessionId, { since: "nope" });
  assert.equal(badSince.statusCode, 400);
  assert.equal(badSince.body.error.code, "INVALID_QUERY");

  const badKind = await app.getTimeline(sessionId, { kinds: "ghost" });
  assert.equal(badKind.statusCode, 400);
  assert.equal(badKind.body.error.code, "INVALID_QUERY");

  const badLimit = await app.getTimeline(sessionId, { limit: "-1" });
  assert.equal(badLimit.statusCode, 400);
  assert.equal(badLimit.body.error.code, "INVALID_QUERY");
});

test("createTimelineAppendBatcher batches timeline.appended payloads per session", () => {
  const sessionId = makeRuntimeId("ses");
  const otherSessionId = makeRuntimeId("ses");
  const sent = [];
  const batcher = createTimelineAppendBatcher({
    batchMs: 1000,
    broadcastTimeline: (payload) => sent.push(payload),
  });

  const status = makeRuntimeEvent("session.status", "2026-05-24T12:01:00.000Z", {
    sessionId,
    status: "running",
  });
  const repoChange = makeRuntimeEvent("repo.change", "2026-05-24T12:02:00.000Z", {
    source: "watcher",
    projectSlug: "llm-tracker",
    repoRoot: "/repo",
    path: "hub/api/timeline.js",
    event: "change",
    activeSessionIds: [sessionId],
    possibleSessionIds: [sessionId, otherSessionId],
    attribution: "single_active_session",
    relatedTaskIds: ["sh-4a-03"],
  });
  const unrelated = makeRuntimeEvent("repo.change", "2026-05-24T12:03:00.000Z", {
    source: "watcher",
    projectSlug: "llm-tracker",
    repoRoot: "/repo",
    path: "other.js",
    event: "change",
    activeSessionIds: [],
    possibleSessionIds: [],
    attribution: "unknown",
    relatedTaskIds: [],
  });

  batcher.handleAppend(status);
  batcher.handleAppend(repoChange);
  batcher.handleAppend(unrelated);
  assert.equal(batcher.pendingCount(), 3);

  batcher.flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((payload) => payload.sessionId), [sessionId, otherSessionId]);
  assert.deepEqual(sent[0].items.map((item) => item.kind), ["status", "repo_change"]);
  assert.deepEqual(sent[0].items.map((item) => item.evidenceRef), [status.id, repoChange.id]);
  assert.deepEqual(sent[1].items.map((item) => item.kind), ["repo_change"]);
  batcher.handleAppend(status);
  assert.equal(batcher.pendingCount(), 1);
  batcher.close();
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2].items.map((item) => item.evidenceRef), [status.id]);
});
