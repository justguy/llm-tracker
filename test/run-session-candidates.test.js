// test/run-session-candidates.test.js — sh-3-02 (TDD v0.5 §6.7, §8A.2)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreRunCandidates,
  RUN_CANDIDATE_WEIGHTS,
  DEFAULT_HIGH_PRIORITY_IDS,
  NON_RUNNABLE_STATUSES,
} from "../hub/run-session/candidates.js";

function task(overrides = {}) {
  const placement = overrides.placement ?? {
    priorityId: overrides.priorityId ?? "p2",
    swimlaneId: overrides.swimlaneId ?? overrides.laneId ?? "lane-default",
  };
  const { priorityId, swimlaneId, laneId, ...rest } = overrides;
  return {
    id: "t-1",
    status: "not_started",
    placement,
    dependencies: [],
    ...rest,
  };
}

const PROJECT = { projectSlug: "proj" };

test("weights match TDD §6.7", () => {
  assert.deepEqual({ ...RUN_CANDIDATE_WEIGHTS }, {
    inSelectedLane: 100,
    dependenciesSatisfied: 80,
    nextOrRecommended: 60,
    highPriority: 40,
    repoMetadataPresent: 30,
    verifyPlanPresent: 20,
    taskAlreadyHasActiveJob: -100,
    blocked: -80,
    sharedWorktreeWithActiveSession: -50,
    riskyRepoMissingAllowedPaths: -40,
  });
  assert.deepEqual([...DEFAULT_HIGH_PRIORITY_IDS], ["p0", "p1"]);
  assert.deepEqual([...NON_RUNNABLE_STATUSES], ["complete", "archived", "cancelled"]);
});

test("filters out completed/archived/cancelled and archived:true tasks", () => {
  const result = scoreRunCandidates({
    tasks: [
      task({ id: "alive" }),
      task({ id: "done", status: "complete" }),
      task({ id: "arch", status: "archived" }),
      task({ id: "cancel", status: "cancelled" }),
      task({ id: "archflag", archived: true }),
    ],
    options: PROJECT,
  });
  assert.deepEqual(
    result.map((c) => c.taskId),
    ["alive"],
  );
});

test("+100 when task is in selected lane (with a reason string)", () => {
  const [c] = scoreRunCandidates({
    tasks: [task({ swimlaneId: "feat-A" })],
    options: { ...PROJECT, laneId: "feat-A" },
  });
  assert.equal(c.score, 100 + 80); // lane + deps-satisfied(empty)
  assert.ok(c.reasons.some((r) => r.includes("+100") && r.includes("feat-A")));
});

test("no lane bonus when laneId option absent or mismatched", () => {
  const [c] = scoreRunCandidates({
    tasks: [task({ swimlaneId: "feat-A" })],
    options: { ...PROJECT, laneId: "feat-B" },
  });
  assert.equal(c.score, 80); // only deps-satisfied(empty)
});

test("dependencies satisfied when deps array is empty (+80)", () => {
  const [c] = scoreRunCandidates({
    tasks: [task({ dependencies: [] })],
    options: PROJECT,
  });
  assert.equal(c.score, 80);
  assert.ok(c.reasons.some((r) => r.includes("dependencies satisfied")));
});

test("dependencies satisfied when all deps are complete (+80)", () => {
  const result = scoreRunCandidates({
    tasks: [
      task({ id: "child", dependencies: ["parent"] }),
      task({ id: "parent", status: "complete" }),
    ],
    options: PROJECT,
  });
  // parent is filtered (complete); only child remains
  assert.equal(result.length, 1);
  assert.equal(result[0].taskId, "child");
  assert.equal(result[0].score, 80);
});

test("dependencies not satisfied if any dep is unresolved or unknown", () => {
  const result = scoreRunCandidates({
    tasks: [
      task({ id: "child", dependencies: ["pending"] }),
      task({ id: "pending", status: "in_progress" }),
    ],
    options: PROJECT,
  });
  const child = result.find((c) => c.taskId === "child");
  assert.equal(child.score, -80); // no deps bonus, and dependency-derived blocked penalty
  assert.equal(child.reasons.find((r) => r.includes("dependencies satisfied")), undefined);
  assert.ok(child.penalties.some((p) => p.includes("-80") && p.includes("pending")));

  const result2 = scoreRunCandidates({
    tasks: [task({ id: "orphan", dependencies: ["does-not-exist"] })],
    options: PROJECT,
  });
  assert.equal(result2[0].score, -80);
});

test("+60 for recommendedTaskIds", () => {
  const [c] = scoreRunCandidates({
    tasks: [task({ id: "t-1" })],
    options: { ...PROJECT, recommendedTaskIds: ["t-1"] },
  });
  assert.equal(c.score, 80 + 60);
  assert.ok(c.reasons.some((r) => r.includes("+60") && r.includes("recommended")));
});

test("+40 for p0/p1 by default; configurable via highPriorityIds", () => {
  const [p0] = scoreRunCandidates({
    tasks: [task({ priorityId: "p0" })],
    options: PROJECT,
  });
  assert.equal(p0.score, 80 + 40);

  const [p2] = scoreRunCandidates({
    tasks: [task({ priorityId: "p2" })],
    options: PROJECT,
  });
  assert.equal(p2.score, 80);

  const [p2Custom] = scoreRunCandidates({
    tasks: [task({ priorityId: "p2" })],
    options: { ...PROJECT, highPriorityIds: ["p2"] },
  });
  assert.equal(p2Custom.score, 80 + 40);
});

test("+30 when repo metadata is present (primary or secondary)", () => {
  const [withPrimary] = scoreRunCandidates({
    tasks: [task({ repos: { primary: { root: "/repo" } } })],
    options: PROJECT,
  });
  assert.equal(withPrimary.score, 80 + 30);

  const [withSecondary] = scoreRunCandidates({
    tasks: [task({ repos: { secondary: [{ root: "/sub" }] } })],
    options: PROJECT,
  });
  assert.equal(withSecondary.score, 80 + 30);

  const [empty] = scoreRunCandidates({
    tasks: [task({ repos: {} })],
    options: PROJECT,
  });
  assert.equal(empty.score, 80);
});

test("+20 when verify plan items are present", () => {
  const [withVerify] = scoreRunCandidates({
    tasks: [
      task({ verify: { items: [{ kind: "command", id: "build", required: true, cmd: "npm run build" }] } }),
    ],
    options: PROJECT,
  });
  assert.equal(withVerify.score, 80 + 20);
  assert.ok(withVerify.reasons.some((r) => r.includes("verify plan present")));

  const [emptyItems] = scoreRunCandidates({
    tasks: [task({ verify: { items: [] } })],
    options: PROJECT,
  });
  assert.equal(emptyItems.score, 80);
});

test("-100 when task has an active job (queued/running/etc.)", () => {
  const [c] = scoreRunCandidates({
    tasks: [task({ id: "t-1" })],
    jobs: [{ id: "job_a", taskId: "t-1", status: "running" }],
    options: PROJECT,
  });
  assert.equal(c.score, 80 - 100);
  assert.ok(c.penalties.some((p) => p.includes("-100") && p.includes("job_a")));
});

test("active job penalty covers canonical active states and ignores other projects", () => {
  for (const status of ["queued", "starting", "running", "blocked", "verifying"]) {
    const [c] = scoreRunCandidates({
      tasks: [task({ id: "t-1" })],
      jobs: [{ id: `job_${status}`, projectSlug: "proj", taskId: "t-1", status }],
      options: PROJECT,
    });
    assert.equal(c.score, 80 - 100);
  }

  const [otherProject] = scoreRunCandidates({
    tasks: [task({ id: "t-1" })],
    jobs: [{ id: "job_other", projectSlug: "other", taskId: "t-1", status: "running" }],
    options: PROJECT,
  });
  assert.equal(otherProject.score, 80);
});

test("completed jobs do not trigger active-job penalty", () => {
  const [c] = scoreRunCandidates({
    tasks: [task({ id: "t-1" })],
    jobs: [{ id: "job_a", taskId: "t-1", status: "complete" }],
    options: PROJECT,
  });
  assert.equal(c.score, 80);
});

test("-80 when task status is blocked OR blocked_kind/blocked_by set", () => {
  const [byStatus] = scoreRunCandidates({
    tasks: [task({ status: "blocked" })],
    options: PROJECT,
  });
  assert.equal(byStatus.score, 80 - 80);

  const [byKind] = scoreRunCandidates({
    tasks: [task({ blocked_kind: "decision_required" })],
    options: PROJECT,
  });
  assert.equal(byKind.score, 80 - 80);

  const [byBy] = scoreRunCandidates({
    tasks: [task({ blocked_by: ["x"] })],
    options: PROJECT,
  });
  assert.equal(byBy.score, 80 - 80);
});

test("-50 when an active session shares the same worktree", () => {
  const [c] = scoreRunCandidates({
    tasks: [
      task({
        repos: { primary: { root: "/repo", worktree: "/wt/feat", allowed_paths: ["src/**"] } },
      }),
    ],
    sessions: [{ id: "ses_x", worktreePath: "/wt/feat", status: "active" }],
    options: PROJECT,
  });
  // +80 deps + +30 repo metadata - 50 shared worktree = 60 (no risky penalty: allowed_paths set)
  assert.equal(c.score, 80 + 30 - 50);
  assert.ok(c.penalties.some((p) => p.includes("/wt/feat") && p.includes("ses_x")));
});

test("inactive sessions (e.g. complete) do not trigger shared-worktree penalty", () => {
  const [c] = scoreRunCandidates({
    tasks: [
      task({
        repos: { primary: { root: "/repo", worktree: "/wt/feat", allowed_paths: ["src/**"] } },
      }),
    ],
    sessions: [{ id: "ses_x", worktreePath: "/wt/feat", status: "complete" }],
    options: PROJECT,
  });
  assert.equal(c.score, 80 + 30); // no -50, no risky penalty
});

test("-40 when a repo pins worktree but has no allowed_paths", () => {
  const [pinned] = scoreRunCandidates({
    tasks: [task({ repos: { primary: { root: "/repo", worktree: "/wt" } } })],
    options: PROJECT,
  });
  // +80 deps + +30 repo - 40 risky = 70
  assert.equal(pinned.score, 80 + 30 - 40);

  const [bounded] = scoreRunCandidates({
    tasks: [
      task({ repos: { primary: { root: "/repo", worktree: "/wt", allowed_paths: ["src/**"] } } }),
    ],
    options: PROJECT,
  });
  assert.equal(bounded.score, 80 + 30);

  const [noWorktree] = scoreRunCandidates({
    tasks: [task({ repos: { primary: { root: "/repo" } } })],
    options: PROJECT,
  });
  assert.equal(noWorktree.score, 80 + 30); // no penalty when worktree isn't pinned
});

test("all reasons + penalties compose correctly", () => {
  const [c] = scoreRunCandidates({
    tasks: [
      task({
        id: "t-1",
        status: "not_started",
        priorityId: "p1",
        swimlaneId: "feat-A",
        dependencies: [],
        repos: { primary: { root: "/repo", worktree: "/wt", allowed_paths: ["src/**"] } },
        verify: { items: [{ kind: "lint", id: "lint", required: true, tool: "eslint" }] },
      }),
    ],
    options: { ...PROJECT, laneId: "feat-A", recommendedTaskIds: ["t-1"] },
  });
  // +100 + +80 + +60 + +40 + +30 + +20 = 330
  assert.equal(c.score, 330);
  assert.equal(c.reasons.length, 6);
  assert.equal(c.penalties.length, 0);
});

test("output is sorted by score desc, then taskId asc for deterministic ordering", () => {
  const result = scoreRunCandidates({
    tasks: [
      task({ id: "b-mid", priorityId: "p2", dependencies: [] }),
      task({ id: "a-mid", priorityId: "p2", dependencies: [] }),
      task({ id: "c-high", priorityId: "p0", dependencies: [] }),
    ],
    options: PROJECT,
  });
  assert.deepEqual(
    result.map((c) => c.taskId),
    ["c-high", "a-mid", "b-mid"],
  );
});

test("each result carries projectSlug, taskId, and laneId from the task", () => {
  const [c] = scoreRunCandidates({
    tasks: [task({ id: "t-1", swimlaneId: "lane-X" })],
    options: { ...PROJECT, projectSlug: "proj-foo" },
  });
  assert.equal(c.projectSlug, "proj-foo");
  assert.equal(c.taskId, "t-1");
  assert.equal(c.laneId, "lane-X");
});

test("uses laneId field as a fallback when swimlaneId is absent", () => {
  const [c] = scoreRunCandidates({
    tasks: [{ id: "t-1", status: "not_started", laneId: "fb-lane", dependencies: [] }],
    options: { ...PROJECT, laneId: "fb-lane" },
  });
  assert.equal(c.score, 80 + 100);
  assert.equal(c.laneId, "fb-lane");
});

test("scoreRunCandidates rejects bad inputs", () => {
  assert.throws(() => scoreRunCandidates(undefined), /options is required/);
  assert.throws(() => scoreRunCandidates({ tasks: [] }), /options is required/);
  assert.throws(() => scoreRunCandidates({ tasks: [], options: {} }), /projectSlug is required/);
  assert.throws(
    () => scoreRunCandidates({ tasks: "x", options: PROJECT }),
    /tasks must be an array/,
  );
  assert.throws(
    () => scoreRunCandidates({ tasks: [], sessions: "x", options: PROJECT }),
    /sessions must be an array/,
  );
  assert.throws(
    () => scoreRunCandidates({ tasks: [], jobs: "x", options: PROJECT }),
    /jobs must be an array/,
  );
});

test("scoring is deterministic — same input always returns identical output", () => {
  const input = {
    tasks: [
      task({ id: "z", priorityId: "p1" }),
      task({ id: "a", priorityId: "p0" }),
      task({ id: "m", priorityId: "p1", swimlaneId: "lane-X" }),
    ],
    sessions: [{ id: "ses_1", worktreePath: "/wt", status: "running" }],
    jobs: [{ id: "job_1", taskId: "z", status: "queued" }],
    options: { ...PROJECT, laneId: "lane-X", recommendedTaskIds: ["m"] },
  };
  const a = scoreRunCandidates(input);
  const b = scoreRunCandidates(input);
  assert.deepEqual(a, b);
});

test("empty tasks list returns empty array", () => {
  assert.deepEqual(scoreRunCandidates({ tasks: [], options: PROJECT }), []);
});
