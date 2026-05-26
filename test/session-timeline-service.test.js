// test/session-timeline-service.test.js - SH-4A-02

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SessionTimelineService,
  buildSessionTimeline,
  timelineItemFromProviderItem,
  timelineItemFromRuntimeEvent,
} from "../hub/timeline/session-timeline-service.js";
import { assertValidTimelineItem } from "../hub/timeline/timeline-model.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const WORKSPACE = "/tmp/llm-tracker";
const SESSION = makeRuntimeId("ses");
const OTHER_SESSION = makeRuntimeId("ses");
const JOB = makeRuntimeId("job");

function runtimeEvent(type, ts, extra = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts,
    type,
    source: "mcp",
    workspace: WORKSPACE,
    sessionId: SESSION,
    ...extra,
  };
}

function assertEveryItemValid(items) {
  for (const item of items) {
    assertValidTimelineItem(item);
    assert.equal(typeof item.evidenceRef, "string");
    assert.notEqual(item.evidenceRef, "");
  }
}

test("buildSessionTimeline merges runtime, provider, repo, verify, and human override evidence in time order", () => {
  const providerEvent = {
    kind: "message",
    providerId: "codex-app-server",
    ts: "2026-05-24T12:01:00.000Z",
    threadId: "thread-1",
    role: "assistant",
    text: "Ready to work.",
  };
  const status = runtimeEvent("session.status", "2026-05-24T12:02:00.000Z", {
    status: "running",
  });
  const checkpoint = runtimeEvent("job.checkpoint", "2026-05-24T12:03:00.000Z", {
    jobId: JOB,
    projectSlug: "llm-tracker",
    taskId: "sh-4a-02",
    status: "verifying",
    summary: "Running timeline checks",
  });
  const repoChange = runtimeEvent("repo.change", "2026-05-24T12:04:00.000Z", {
    source: "watcher",
    projectSlug: "llm-tracker",
    repoRoot: "/repo",
    path: "hub/timeline/session-timeline-service.js",
    event: "change",
    activeSessionIds: [SESSION],
    possibleSessionIds: [SESSION, OTHER_SESSION],
    attribution: "single_active_session",
    relatedTaskIds: ["sh-4a-02"],
  });
  const skill = runtimeEvent("skill.run.finished", "2026-05-24T12:05:00.000Z", {
    jobId: JOB,
    skillId: "lt.verify",
    status: "succeeded",
    summary: "verify pack satisfied",
  });
  const verify = runtimeEvent("verify.command.completed", "2026-05-24T12:06:00.000Z", {
    source: "http",
    jobId: JOB,
    itemId: "node-tests",
    command: "node --test test/session-timeline-service.test.js",
    status: "succeeded",
    exitCode: 0,
  });
  const override = runtimeEvent("human.override", "2026-05-24T12:07:00.000Z", {
    source: "http",
    jobId: JOB,
    reason: "operator accepted manual evidence",
    context: {
      projectSlug: "llm-tracker",
      taskId: "sh-4a-02",
      sessionId: SESSION,
    },
  });

  const items = buildSessionTimeline({
    sessionId: SESSION,
    runtimeEvents: [verify, status, checkpoint, skill],
    providerEvents: [providerEvent],
    repoEvents: [repoChange],
    humanOverrides: [override],
  });

  assert.deepEqual(items.map((item) => item.kind), [
    "message",
    "status",
    "checkpoint",
    "repo_change",
    "skill",
    "verify",
    "status",
  ]);
  assert.deepEqual(items.map((item) => item.source), [
    "provider",
    "mcp",
    "mcp",
    "watcher_git",
    "mcp",
    "http",
    "human",
  ]);
  assert.equal(items[3].evidenceRef, repoChange.id);
  assert.equal(items[5].evidenceRef, verify.id);
  assert.equal(items[6].confidence, "manual");
  assertEveryItemValid(items);
});

test("provider normalizer rows map unsupported interim kinds into strict TimelineItem kinds", () => {
  const rows = [
    {
      sessionId: SESSION,
      providerId: "codex",
      ts: "2026-05-24T12:00:00.000Z",
      kind: "thread",
      data: { phase: "started", threadRef: { threadId: "t1" } },
    },
    {
      sessionId: SESSION,
      providerId: "codex",
      ts: "2026-05-24T12:00:01.000Z",
      kind: "turn",
      data: { phase: "completed", turnId: "turn-1" },
    },
    {
      sessionId: SESSION,
      providerId: "codex",
      ts: "2026-05-24T12:00:02.000Z",
      kind: "context_usage",
      data: { percent: 91, used: 91, total: 100 },
    },
    {
      sessionId: SESSION,
      providerId: "codex",
      ts: "2026-05-24T12:00:03.000Z",
      kind: "provider_error",
      severity: "high",
      data: { code: "ECONNRESET", message: "connection reset" },
    },
  ];

  const items = buildSessionTimeline({
    sessionId: SESSION,
    providerTimelineItems: rows,
  });

  assert.deepEqual(items.map((item) => item.kind), [
    "checkpoint",
    "checkpoint",
    "warning",
    "warning",
  ]);
  assert.ok(items.every((item) => item.source === "provider"));
  assert.ok(items.every((item) => item.confidence === "structured"));
  assertEveryItemValid(items);
});

test("session.output stdout and stderr become raw stdio message markers only", () => {
  const stdout = runtimeEvent("session.output", "2026-05-24T12:00:00.000Z", {
    source: "cli",
    stream: "stdout",
    text: "install complete",
  });
  const stderr = runtimeEvent("session.output", "2026-05-24T12:00:01.000Z", {
    source: "cli",
    stream: "stderr",
    text: "warning",
  });

  const items = buildSessionTimeline({
    sessionId: SESSION,
    runtimeEvents: [stderr, stdout],
  });

  assert.deepEqual(items.map((item) => item.kind), ["message", "message"]);
  assert.deepEqual(items.map((item) => item.source), ["raw_stdio", "raw_stdio"]);
  assert.deepEqual(items.map((item) => item.confidence), ["derived", "derived"]);
  assertEveryItemValid(items);
});

test("since, kinds, and limit are applied after projection and ordering", () => {
  const items = buildSessionTimeline({
    sessionId: SESSION,
    runtimeEvents: [
      runtimeEvent("verify.command.completed", "2026-05-24T12:03:00.000Z", {
        source: "http",
        command: "node --test",
        status: "succeeded",
      }),
      runtimeEvent("session.status", "2026-05-24T12:01:00.000Z", {
        status: "running",
      }),
      runtimeEvent("session.warning", "2026-05-24T12:02:00.000Z", {
        warning: { kind: "context_high", message: "high context" },
      }),
    ],
    since: "2026-05-24T12:02:00.000Z",
    kinds: ["warning", "verify"],
    limit: 1,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "warning");
  assert.equal(items[0].title, "Warning: context_high");
});

test("repo events are session-filtered by active or possible session ids", () => {
  const matched = runtimeEvent("repo.change", "2026-05-24T12:00:00.000Z", {
    source: "watcher",
    projectSlug: "llm-tracker",
    repoRoot: "/repo",
    path: "a.js",
    event: "change",
    activeSessionIds: [],
    possibleSessionIds: [SESSION],
    attribution: "ambiguous",
    relatedTaskIds: [],
  });
  const unrelated = runtimeEvent("repo.change", "2026-05-24T12:01:00.000Z", {
    source: "watcher",
    projectSlug: "llm-tracker",
    repoRoot: "/repo",
    path: "b.js",
    event: "change",
    activeSessionIds: [OTHER_SESSION],
    possibleSessionIds: [OTHER_SESSION],
    attribution: "single_active_session",
    relatedTaskIds: [],
  });

  const items = buildSessionTimeline({
    sessionId: SESSION,
    repoEvents: [unrelated, matched],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "repo_change");
  assert.equal(items[0].detail, "/repo");
  assert.equal(items[0].evidenceRef, matched.id);
});

test("provider file_change evidence stays distinct from watcher repo_change evidence", () => {
  const providerFileChange = {
    sessionId: SESSION,
    providerId: "codex",
    ts: "2026-05-24T12:00:00.000Z",
    kind: "file_change",
    data: {
      phase: "applied",
      proposalId: "proposal-1",
      files: ["src/app.js"],
    },
  };
  const repoChange = runtimeEvent("repo.change", "2026-05-24T12:00:01.000Z", {
    source: "watcher",
    projectSlug: "llm-tracker",
    repoRoot: "/repo",
    path: "src/app.js",
    event: "change",
    activeSessionIds: [SESSION],
    possibleSessionIds: [SESSION],
    attribution: "single_active_session",
    relatedTaskIds: [],
  });

  const items = buildSessionTimeline({
    sessionId: SESSION,
    providerTimelineItems: [providerFileChange],
    repoEvents: [repoChange],
  });

  assert.equal(items[0].kind, "file_change");
  assert.equal(items[0].source, "provider");
  assert.match(items[0].evidenceRef, /^provider:codex:file_change:proposal-1:/);
  assert.equal(items[1].kind, "repo_change");
  assert.equal(items[1].source, "watcher_git");
  assert.equal(items[1].evidenceRef, repoChange.id);
});

test("SessionTimelineService stores default sources and allows per-call overrides", () => {
  const status = runtimeEvent("session.status", "2026-05-24T12:00:00.000Z", {
    status: "running",
  });
  const service = new SessionTimelineService({ runtimeEvents: [status] });

  assert.equal(service.buildForSession(SESSION).length, 1);
  assert.equal(
    service.buildForSession(SESSION, {
      runtimeEvents: [
        runtimeEvent("session.warning", "2026-05-24T12:00:01.000Z", {
          warning: { kind: "quiet_terminal", message: "quiet" },
        }),
      ],
    })[0].kind,
    "warning",
  );
});

test("single-row helpers validate emitted TimelineItems", () => {
  const runtimeItem = timelineItemFromRuntimeEvent(
    runtimeEvent("verify.command.started", "2026-05-24T12:00:00.000Z", {
      source: "http",
      command: "node --test",
    }),
    { sessionId: SESSION },
  );
  const providerItem = timelineItemFromProviderItem(
    {
      sessionId: SESSION,
      providerId: "codex",
      ts: "2026-05-24T12:00:01.000Z",
      kind: "approval",
      data: { phase: "requested", approvalId: "a1", title: "Run tests" },
    },
    { sessionId: SESSION },
  );

  assertValidTimelineItem(runtimeItem);
  assertValidTimelineItem(providerItem);
  assert.equal(runtimeItem.kind, "verify");
  assert.equal(providerItem.kind, "approval");
});
