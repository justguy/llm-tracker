// hub/timeline/__tests__/phase4a-acceptance.test.js - SH-4A-08

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSessionTimeline } from "../session-timeline-service.js";
import { assertValidTimelineItem } from "../timeline-model.js";

const SESSION = "ses_phase4a";
const JOB = "job_phase4a";

function runtimeEvent(type, ts, extra = {}) {
  return {
    schemaVersion: 1,
    id: `evt_${type.replaceAll(".", "_")}_${ts}`,
    ts,
    type,
    source: "mcp",
    workspace: "/tmp/llm-tracker",
    sessionId: SESSION,
    ...extra,
  };
}

test("Phase 4A acceptance: provider and runtime timeline evidence merges in time order", () => {
  const items = buildSessionTimeline({
    sessionId: SESSION,
    providerEvents: [
      {
        providerId: "codex-app-server",
        kind: "message",
        ts: "2026-05-29T10:00:02.000Z",
        threadId: "thread-1",
        role: "assistant",
        text: "I will run the verify command.",
      },
    ],
    runtimeEvents: [
      runtimeEvent("verify.command.completed", "2026-05-29T10:00:04.000Z", {
        source: "http",
        jobId: JOB,
        itemId: "verify-1",
        command: "node --test",
        status: "succeeded",
        exitCode: 0,
      }),
      runtimeEvent("job.checkpoint", "2026-05-29T10:00:03.000Z", {
        jobId: JOB,
        projectSlug: "llm-tracker",
        taskId: "sh-4a-08",
        summary: "Collecting timeline evidence.",
      }),
    ],
    repoEvents: [
      runtimeEvent("repo.change", "2026-05-29T10:00:05.000Z", {
        source: "watcher",
        projectSlug: "llm-tracker",
        repoRoot: "/repo",
        path: "hub/timeline/session-timeline-service.js",
        event: "change",
        activeSessionIds: [SESSION],
      }),
    ],
    humanOverrides: [
      runtimeEvent("human.override", "2026-05-29T10:00:06.000Z", {
        source: "http",
        reason: "operator accepted evidence",
        context: { sessionId: SESSION, projectSlug: "llm-tracker", taskId: "sh-4a-08" },
      }),
    ],
  });

  assert.deepEqual(items.map((item) => item.kind), [
    "message",
    "checkpoint",
    "verify",
    "repo_change",
    "status",
  ]);
  assert.deepEqual(items.map((item) => item.source), [
    "provider",
    "mcp",
    "http",
    "watcher_git",
    "human",
  ]);
  assert.deepEqual(
    items.map((item) => item.ts),
    [...items.map((item) => item.ts)].sort(),
  );
  assert.ok(items.every((item) => typeof item.evidenceRef === "string" && item.evidenceRef.length > 0));
  for (const item of items) assertValidTimelineItem(item);
});

test("Phase 4A acceptance: raw stdio markers stay generic and derived", () => {
  const items = buildSessionTimeline({
    sessionId: SESSION,
    runtimeEvents: [
      runtimeEvent("session.output", "2026-05-29T10:00:01.000Z", {
        source: "cli",
        stream: "stderr",
        text: "approval requested: allow dangerous command",
      }),
    ],
    providerTimelineItems: [
      {
        sessionId: SESSION,
        providerId: "codex-app-server",
        ts: "2026-05-29T10:00:02.000Z",
        kind: "command",
        source: "raw_stdio",
        data: {
          rawStdio: true,
          text: "verify.command.completed succeeded",
        },
      },
    ],
  });

  assert.deepEqual(items.map((item) => item.kind), ["message", "message"]);
  assert.deepEqual(items.map((item) => item.source), ["raw_stdio", "raw_stdio"]);
  assert.deepEqual(items.map((item) => item.confidence), ["derived", "derived"]);
  for (const item of items) assertValidTimelineItem(item);
});
