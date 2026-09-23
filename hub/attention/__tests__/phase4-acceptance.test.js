// hub/attention/__tests__/phase4-acceptance.test.js -- SH-4-10

import { test } from "node:test";
import assert from "node:assert/strict";

import { AttentionEngine } from "../engine.js";
import { registerAllRules } from "../rules/index.js";

const NOW = new Date("2026-05-24T12:00:00.000Z");

let idCounter = 0;
function makeId(prefix) {
  idCounter += 1;
  return `${prefix}_phase4_${String(idCounter).padStart(4, "0")}`;
}

function engine() {
  const next = new AttentionEngine({ now: () => NOW, makeId });
  registerAllRules(next);
  return next;
}

function byKind(items, kind) {
  return items.find((item) => item.kind === kind);
}

test("Phase 4 engine projects structured/runtime/watcher/tracker attention scenarios", () => {
  const items = engine().compute({
    sessions: [
      {
        id: "ses_approval",
        projectSlug: "proj",
        taskId: "task_approval",
        activeJobId: "job_approval",
        warnings: [{ kind: "approval_needed", source: "app_server", actionId: "evt_approval" }],
      },
      {
        id: "ses_blocked",
        projectSlug: "proj",
        taskId: "task_blocked",
        activeJobId: "job_blocked",
        status: "blocked",
        statusSource: { kind: "mcp", eventId: "evt_blocked" },
      },
      {
        id: "ses_heartbeat",
        projectSlug: "proj",
        taskId: "task_heartbeat",
        capabilityTier: "mcp",
        warnings: [{ kind: "missing_heartbeat", minutes: 12 }],
      },
      {
        id: "ses_quiet",
        projectSlug: "proj",
        taskId: "task_quiet",
        tier: "dumb_terminal",
        warnings: [{ kind: "quiet_terminal", minutes: 15 }],
      },
      {
        id: "ses_context",
        projectSlug: "proj",
        taskId: "task_context",
        contextUsage: { percent: 92, source: "mcp" },
      },
      {
        id: "ses_raw_only",
        projectSlug: "proj",
        taskId: "task_raw",
        rawStdio: "APPROVE THIS COMMAND",
        stdout: "approval needed",
      },
    ],
    jobs: [
      {
        id: "job_verify",
        projectSlug: "proj",
        taskId: "task_verify",
        sessionId: "ses_verify",
        status: "running",
        completionGates: [],
      },
    ],
    conflicts: [
      {
        id: "conf_outside",
        kind: "outside_allowed_paths",
        projectSlug: "proj",
        taskId: "task_outside",
        sessionId: "ses_outside",
        path: "../outside.txt",
      },
    ],
    trackerSnapshot: {
      tasks: [
        { id: "task_complete", status: "complete", projectSlug: "proj", title: "Complete without verify" },
      ],
    },
  });

  assert.equal(byKind(items, "approval_needed")?.source, "structured");
  assert.equal(byKind(items, "blocked")?.source, "structured");
  assert.equal(byKind(items, "outside_allowed_paths")?.source, "watcher_git");
  assert.equal(byKind(items, "not_responding")?.source, "structured");
  assert.equal(byKind(items, "quiet")?.source, "derived");
  assert.equal(byKind(items, "context_high")?.source, "structured");
  assert.equal(byKind(items, "verify_missing")?.jobId, "job_verify");
  assert.equal(byKind(items, "done_claimed_verify_missing")?.taskId, "task_complete");
  assert.equal(
    items.filter((item) => item.kind === "approval_needed").length,
    1,
    "raw stdio approval-like text must not create approval_needed",
  );
  for (const item of items) {
    assert.ok(item.clearCondition, `${item.kind} should carry clearCondition`);
    assert.ok(Array.isArray(item.recommendedActions), `${item.kind} should carry recommendedActions`);
  }
});

test("Phase 4 projection preserves ack/snooze overlays and dedupes repeated equivalent warnings", () => {
  const attention = engine();
  const input = {
    sessions: [
      {
        id: "ses_approval",
        projectSlug: "proj",
        taskId: "task_approval",
        warnings: [
          { kind: "approval_needed", source: "app_server", actionId: "evt_same" },
          { kind: "approval_needed", source: "app_server", actionId: "evt_same" },
        ],
      },
    ],
  };

  const first = attention.compute(input);
  assert.equal(first.length, 1);
  const item = first[0];
  assert.equal(item.kind, "approval_needed");

  attention.applyRuntimeEvent({
    type: "attention.ack",
    attentionItemId: item.id,
    acknowledgedAt: "2026-05-24T12:01:00.000Z",
  });
  attention.applyRuntimeEvent({
    type: "attention.snoozed",
    attentionItemId: item.id,
    snoozedUntil: "2026-05-24T13:00:00.000Z",
  });

  const rebuilt = attention.compute(input);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].acknowledgedAt, "2026-05-24T12:01:00.000Z");
  assert.equal(rebuilt[0].snoozedUntil, "2026-05-24T13:00:00.000Z");
});
