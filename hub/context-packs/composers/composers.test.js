import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_PACK_COMPOSERS,
  composeContextPack,
} from "./index.js";

const EXPECTED = Object.freeze({
  start: {
    sources: ["tracker.brief", "tracker.why", "tracker.execute", "tracker.verify", "tracker.changed"],
    sections: ["job", "draft", "brief", "why", "execute", "verify", "changed"],
  },
  resume: {
    sources: ["tracker.brief", "tracker.execute", "tracker.verify", "tracker.changed", "runtime.events", "repo.watcher", "git.evidence"],
    sections: ["job", "brief", "execute", "verify", "changed", "runtime_events", "repo_events", "git"],
  },
  rollover: {
    sources: ["tracker.brief", "tracker.why", "tracker.execute", "tracker.verify", "tracker.handoff", "tracker.changed", "tracker.history", "tracker.since_rev", "runtime.events", "repo.watcher", "git.evidence"],
    sections: ["job", "brief", "why", "execute", "verify", "changed", "history", "since_rev", "runtime_events", "repo_events", "git", "advisory_handoff"],
  },
  handoff: {
    sources: ["tracker.brief", "tracker.execute", "tracker.verify", "tracker.handoff", "tracker.changed", "runtime.events", "repo.watcher", "git.evidence"],
    sections: ["job", "brief", "execute", "verify", "changed", "runtime_events", "repo_events", "git", "handoff"],
  },
  review: {
    sources: ["tracker.brief", "tracker.why", "tracker.changed", "tracker.history", "runtime.events", "repo.watcher", "git.evidence"],
    sections: ["job", "brief", "why", "changed", "history", "runtime_events", "repo_events", "git"],
  },
  verify: {
    sources: ["tracker.brief", "tracker.verify", "runtime.events", "git.evidence"],
    sections: ["job", "brief", "verify", "completion_gates", "skill_plan", "runtime_events", "git"],
  },
  closeout: {
    sources: ["tracker.brief", "tracker.verify", "tracker.handoff", "tracker.changed", "tracker.history", "runtime.events", "git.evidence"],
    sections: ["job", "brief", "verify", "handoff", "changed", "history", "completion_gates", "skill_plan", "runtime_events", "git"],
  },
  changed_since: {
    sources: ["tracker.changed", "tracker.since_rev", "snapshots.history", "repo.watcher", "git.evidence"],
    sections: ["job", "changed", "since_rev", "snapshots_history", "repo_events", "git"],
  },
});

test("composeContextPack exposes golden fixtures for every context pack kind", () => {
  assert.deepEqual(Object.keys(CONTEXT_PACK_COMPOSERS), Object.keys(EXPECTED));
  for (const [kind, expected] of Object.entries(EXPECTED)) {
    const pack = composeContextPack(kind, fixtureParams(), {
      workspace: "/repo",
      runtimeEvents: [{ id: "evt_1", jobId: "job_1", type: "session.output" }],
      repoEvents: [{ id: "repo_1", projectSlug: "demo", path: "src/app.js" }],
    });
    assert.equal(pack.kind, kind);
    assert.equal(pack.source, "deterministic");
    assert.equal(pack.generatedAt, "2026-05-28T00:00:00.000Z");
    assert.equal(pack.jobId, "job_1");
    assert.equal(pack.sessionId, "ses_1");
    assert.equal(pack.projectSlug, "demo");
    assert.equal(pack.taskId, "task-1");
    assert.equal(pack.workspace, "/repo");
    assert.deepEqual(pack.sources.map((source) => source.id), expected.sources, kind);
    assert.deepEqual(pack.sections.map((section) => section.id), expected.sections, kind);
    assert.equal(Object.isFrozen(pack), true);
  }
});

test("rollover pack labels old-session handoff as advisory", () => {
  const pack = composeContextPack("rollover", fixtureParams());
  const advisory = pack.sections.find((section) => section.id === "advisory_handoff");
  assert.equal(advisory.sourceId, "tracker.handoff");
  assert.equal(advisory.value.advisoryHandoff.oldSessionId, "ses_old");
  assert.match(advisory.value.advisoryHandoffLabel, /verify against tracker\/git evidence/);
});

test("source manifest marks dependency-provided runtime and repo evidence as provided", () => {
  const pack = composeContextPack("resume", fixtureParams(), {
    runtimeStore: {
      eventsForJob: () => [{ id: "evt_1", jobId: "job_1" }],
      repoEventsFor: () => [{ id: "repo_1", projectSlug: "demo" }],
    },
  });
  assert.equal(pack.sources.find((source) => source.id === "runtime.events").status, "provided");
  assert.equal(pack.sources.find((source) => source.id === "repo.watcher").status, "provided");
  assert.deepEqual(pack.sections.find((section) => section.id === "runtime_events").value, [
    { id: "evt_1", jobId: "job_1" },
  ]);
  assert.deepEqual(pack.sections.find((section) => section.id === "repo_events").value, [
    { id: "repo_1", projectSlug: "demo" },
  ]);
});

function fixtureParams() {
  return {
    now: () => "2026-05-28T00:00:00.000Z",
    workspace: "/repo",
    draft: { id: "draft_1", mode: "task_backed" },
    job: {
      id: "job_1",
      sessionId: "ses_1",
      projectSlug: "demo",
      taskId: "task-1",
      verifyPack: { items: [{ id: "test", kind: "command" }] },
      completionGates: [{ id: "gate_1", status: "pending" }],
      humanApprovalRequests: [{ id: "approve_1" }],
      skillPlan: [{ skillId: "lt.closeout_sweep" }],
    },
    session: {
      id: "ses_1",
      projectSlug: "demo",
      taskId: "task-1",
    },
    brief: { id: "task-1", title: "Task" },
    why: { rationale: "important" },
    execute: { steps: ["do work"] },
    verify: { checks: ["node --test"] },
    changed: { fromRev: 1, tasks: ["task-1"] },
    history: [{ rev: 2, summary: "changed" }],
    sinceRev: { fromRev: 1, events: [{ rev: 2 }] },
    snapshotsHistory: [{ rev: 2 }],
    handoff: { oldSessionId: "ses_old", summary: "old claim" },
    git: { files: [{ path: "src/app.js", status: "M" }] },
  };
}
