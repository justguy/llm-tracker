import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHygienePayload } from "../hub/hygiene.js";
import { validProject } from "./fixtures.js";

test("buildHygienePayload reports empty swimlanes and orphaned priorities", () => {
  const project = validProject();
  project.meta.rev = 5;
  project.meta.swimlanes.push({ id: "review", label: "Review" });
  project.meta.priorities.push({ id: "p3", label: "P3 / Backlog" });

  const payload = buildHygienePayload({ slug: "test-project", data: project });

  assert.equal(payload.packType, "hygiene");
  assert.equal(payload.rev, 5);
  assert.equal(payload.thresholds.staleAfterRevs, 10);

  assert.equal(payload.emptySwimlanes.length, 1);
  assert.equal(payload.emptySwimlanes[0].id, "review");
  assert.equal(payload.emptySwimlanes[0].taskCount, 0);
  assert.equal(payload.emptySwimlanes[0].removable, true);
  assert.equal(payload.emptySwimlanes[0].reason, null);

  assert.equal(payload.orphanedPriorities.length, 1);
  assert.equal(payload.orphanedPriorities[0].id, "p3");
});

test("buildHygienePayload marks the only swimlane as not removable", () => {
  const project = validProject();
  project.meta.swimlanes = [{ id: "solo", label: "Solo" }];
  project.tasks = [];
  project.meta.rev = 1;

  const payload = buildHygienePayload({ slug: "test-project", data: project });

  assert.equal(payload.emptySwimlanes.length, 1);
  assert.equal(payload.emptySwimlanes[0].id, "solo");
  assert.equal(payload.emptySwimlanes[0].removable, false);
  assert.match(payload.emptySwimlanes[0].reason, /Only swimlane/);
});

test("buildHygienePayload flags stale in_progress tasks past the threshold", () => {
  const project = validProject();
  project.meta.rev = 30;
  project.tasks[1].rev = 5; // task t2 is in_progress, last touched at rev 5

  const payload = buildHygienePayload({
    slug: "test-project",
    data: project,
    history: [
      { rev: 5, ts: "2026-04-01T00:00:00.000Z", delta: { tasks: { t2: { status: "in_progress" } } } }
    ],
    staleAfterRevs: 10
  });

  assert.equal(payload.staleInProgress.length, 1);
  assert.equal(payload.staleInProgress[0].id, "t2");
  assert.equal(payload.staleInProgress[0].lastTouchedRev, 5);
  assert.equal(payload.staleInProgress[0].revsSinceTouched, 25);
  assert.equal(payload.staleInProgress[0].lastTouchedAt, "2026-04-01T00:00:00.000Z");
});

test("buildHygienePayload skips fresh in_progress tasks under the threshold", () => {
  const project = validProject();
  project.meta.rev = 12;
  project.tasks[1].rev = 11;

  const payload = buildHygienePayload({
    slug: "test-project",
    data: project,
    history: [
      { rev: 11, ts: "2026-04-29T00:00:00.000Z", delta: { tasks: { t2: { status: "in_progress" } } } }
    ],
    staleAfterRevs: 10
  });

  assert.deepEqual(payload.staleInProgress, []);
});

test("buildHygienePayload does not mark unknown last-touch tasks as stale", () => {
  const project = validProject();
  project.meta.rev = 30;
  delete project.tasks[1].rev;

  const payload = buildHygienePayload({
    slug: "test-project",
    data: project,
    history: [],
    staleAfterRevs: 10
  });

  assert.deepEqual(payload.staleInProgress, []);
});

test("buildHygienePayload reports blocked-without-reason and decision-gated-without-comment", () => {
  const project = validProject();
  project.meta.rev = 4;
  project.tasks.push({
    id: "t4",
    title: "Decision-gated task",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p1" },
    approval_required_for: ["security review"]
  });

  const payload = buildHygienePayload({ slug: "test-project", data: project });

  assert.equal(payload.blockedWithoutReason.length, 1);
  assert.equal(payload.blockedWithoutReason[0].id, "t2");
  assert.deepEqual(payload.blockedWithoutReason[0].blocking_on, ["t1"]);
  assert.deepEqual(payload.blockedWithoutReason[0].missingFields, ["blocker_reason", "comment"]);

  assert.equal(payload.decisionGatedWithoutComment.length, 1);
  assert.equal(payload.decisionGatedWithoutComment[0].id, "t4");
  assert.deepEqual(payload.decisionGatedWithoutComment[0].decision_required, ["security review"]);
});

test("buildHygienePayload omits blocked tasks with explicit narrative", () => {
  const project = validProject();
  project.meta.rev = 4;
  project.tasks[1].blocker_reason = "Need t1 to land first";

  const payload = buildHygienePayload({ slug: "test-project", data: project });

  assert.deepEqual(payload.blockedWithoutReason, []);
});

test("buildHygienePayload counts findings and clamps the stale threshold", () => {
  const project = validProject();
  project.meta.rev = 100;
  project.meta.swimlanes.push({ id: "review", label: "Review" });
  project.meta.priorities.push({ id: "p3", label: "P3" });
  project.tasks[1].rev = 1;

  const payload = buildHygienePayload({
    slug: "test-project",
    data: project,
    history: [
      { rev: 1, ts: "2026-01-01T00:00:00.000Z", delta: { tasks: { t2: { status: "in_progress" } } } }
    ],
    staleAfterRevs: 0 // should clamp up to MIN_STALE_AFTER_REVS=1
  });

  assert.equal(payload.thresholds.staleAfterRevs, 1);
  assert.equal(payload.counts.emptySwimlanes, 1);
  assert.equal(payload.counts.removableSwimlanes, 1);
  assert.equal(payload.counts.orphanedPriorities, 1);
  assert.equal(payload.counts.staleInProgress, 1);
  assert.equal(payload.counts.blockedWithoutReason, 1);
  assert.equal(payload.counts.decisionGatedWithoutComment, 0);
});
