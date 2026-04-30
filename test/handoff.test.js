import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHandoffPayload } from "../hub/handoff.js";
import { validProject } from "./fixtures.js";

test("buildHandoffPayload combines brief, why, decisions, and renders a prompt", () => {
  const project = validProject();
  project.meta.rev = 9;
  project.tasks[0].goal = "Land the alpha skeleton";
  project.tasks[0].definition_of_done = ["Tests pass", "Docs updated"];
  project.tasks[0].constraints = ["No new dependencies"];
  project.tasks[0].expected_changes = ["src/alpha.js"];
  project.tasks[0].allowed_paths = ["src/"];
  project.tasks[0].comment = "Decision: keep schema flat";
  project.tasks[0].context = {
    ...project.tasks[0].context,
    roadmap_section: "Alpha roadmap"
  };

  const history = [
    {
      rev: 9,
      ts: "2026-04-29T10:00:00.000Z",
      delta: { tasks: { t1: { status: "in_progress" } } }
    }
  ];

  const payload = buildHandoffPayload({
    slug: "test-project",
    data: project,
    history,
    taskId: "t1",
    fromAssignee: "claude",
    toAssignee: "codex"
  });

  assert.equal(payload.packType, "handoff");
  assert.equal(payload.taskId, "t1");
  assert.equal(payload.fromAssignee, "claude");
  assert.equal(payload.toAssignee, "codex");
  assert.equal(payload.task.id, "t1");

  assert.deepEqual(payload.executionContract.definition_of_done, ["Tests pass", "Docs updated"]);
  assert.deepEqual(payload.executionContract.constraints, ["No new dependencies"]);
  assert.deepEqual(payload.executionContract.expected_changes, ["src/alpha.js"]);
  assert.deepEqual(payload.executionContract.allowed_paths, ["src/"]);

  assert.ok(Array.isArray(payload.why));
  assert.ok(payload.why.length > 0);

  // The decision shown for t1 is the comment we set
  const myDecision = payload.recentDecisions.find((d) => d.id === "t1");
  assert.ok(myDecision);
  assert.equal(myDecision.comment, "Decision: keep schema flat");

  assert.match(payload.handoffPrompt, /# Handoff: test-project\/t1 — Task 1/);
  assert.match(payload.handoffPrompt, /From: claude  →  To: codex/);
  assert.match(payload.handoffPrompt, /## Goal/);
  assert.match(payload.handoffPrompt, /Land the alpha skeleton/);
  assert.match(payload.handoffPrompt, /## Definition of done/);
  assert.match(payload.handoffPrompt, /Tests pass/);
  assert.match(payload.handoffPrompt, /## Constraints/);
  assert.match(payload.handoffPrompt, /## Expected changes/);
  assert.match(payload.handoffPrompt, /## Allowed paths/);
  assert.match(payload.handoffPrompt, /## Why this matters/);
  assert.match(payload.handoffPrompt, /## Decision note/);
  assert.match(payload.handoffPrompt, /Decision: keep schema flat/);
  assert.match(payload.handoffPrompt, /## Recent project decisions/);
  assert.match(payload.handoffPrompt, /## Recent task history/);
  assert.match(payload.handoffPrompt, /tracker_execute/);
  assert.match(payload.handoffPrompt, /tracker_verify/);
});

test("buildHandoffPayload falls back to the existing assignee for fromAssignee", () => {
  const project = validProject();
  project.meta.rev = 2;

  const payload = buildHandoffPayload({
    slug: "test-project",
    data: project,
    history: [],
    taskId: "t2"
  });

  assert.equal(payload.fromAssignee, "claude"); // t2's assignee in the fixture
  assert.equal(payload.toAssignee, null);
  assert.match(payload.handoffPrompt, /From: claude  →  To: \(next agent\)/);
});

test("buildHandoffPayload returns null for an unknown task id", () => {
  const project = validProject();
  const payload = buildHandoffPayload({
    slug: "test-project",
    data: project,
    history: [],
    taskId: "missing"
  });
  assert.equal(payload, null);
});

test("buildHandoffPayload reports blocked-by tasks in the prompt", () => {
  const project = validProject();
  project.meta.rev = 4;

  const payload = buildHandoffPayload({
    slug: "test-project",
    data: project,
    history: [],
    taskId: "t2"
  });

  assert.equal(payload.task.actionability, "blocked_by_task");
  assert.deepEqual(payload.task.blocking_on, ["t1"]);
  assert.match(payload.handoffPrompt, /blocked by: t1/);
  assert.match(payload.handoffPrompt, /## Dependencies/);
  assert.match(payload.handoffPrompt, /t1 \[not_started\]/);
});

test("buildHandoffPayload uses a longer markdown fence when snippets contain backticks", () => {
  const project = validProject();
  const payload = buildHandoffPayload({
    slug: "test-project",
    data: project,
    taskId: "t1",
    snippets: [
      {
        reference: "docs/example.md:1",
        text: "before\n```\ninside\n```\nafter"
      }
    ]
  });

  assert.match(payload.handoffPrompt, /````\nbefore\n```\ninside\n```\nafter\n````/);
});
