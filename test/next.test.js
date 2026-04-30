import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNextPayload } from "../hub/next.js";
import { validProject } from "./fixtures.js";

function projectWithPriorities() {
  const project = validProject();
  project.meta.priorities = [
    { id: "p0", label: "P0 / Now" },
    { id: "p1", label: "P1 / Next" },
    { id: "p2", label: "P2 / Soon" },
    { id: "p3", label: "P3 / Later" }
  ];
  project.meta.rev = 12;
  return project;
}

test("buildNextPayload ranks executable tasks and hides task-blocked work by default", () => {
  const project = projectWithPriorities();
  project.tasks[0].comment = "Highest-priority ready task";
  project.tasks[0].reference = "hub/store.js:1-20";
  project.tasks[0].effort = "s";
  project.tasks[1].comment = "Blocked until task 1 completes";
  project.tasks[1].references = ["hub/server.js:1-40"];
  project.tasks.push({
    id: "t4",
    title: "Task 4",
    status: "not_started",
    placement: { swimlaneId: "ops", priorityId: "p1" },
    dependencies: [],
    effort: "m"
  });

  const payload = buildNextPayload({
    slug: "test-project",
    data: project,
    history: [
      { rev: 10, delta: { tasks: { t1: { status: "in_progress" } } } },
      { rev: 11, delta: { tasks: { t2: { comment: "blocked" } } } }
    ]
  });

  assert.equal(payload.recommendedTaskId, "t1");
  assert.deepEqual(
    payload.next.map((task) => task.id),
    ["t1", "t4"]
  );
  assert.deepEqual(payload.next[0].references, ["hub/store.js:1-20"]);
  assert.equal(payload.next[0].ready, true);
  assert.equal(payload.next[0].actionability, "executable");
  assert.equal(payload.next[0].lastTouchedRev, 10);
  assert.equal(payload.actionabilityCounts.blocked_by_task, 1);
  assert.equal(payload.hiddenByActionability.blocked_by_task, 1);
});

test("buildNextPayload hides decision-gated work unless explicitly included", () => {
  const project = projectWithPriorities();
  project.tasks = [
    {
      id: "t1",
      title: "Fast task",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: [],
      effort: "xs"
    },
    {
      id: "t2",
      title: "Slow task",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: [],
      effort: "xl",
      approval_required_for: ["new dependencies"]
    }
  ];

  const payload = buildNextPayload({
    slug: "test-project",
    data: project
  });

  assert.deepEqual(
    payload.next.map((task) => task.id),
    ["t1"]
  );
  assert.equal(payload.actionabilityCounts.decision_gated, 1);
  assert.equal(payload.hiddenByActionability.decision_gated, 1);

  const withGated = buildNextPayload({
    slug: "test-project",
    data: project,
    includeGated: true
  });

  assert.deepEqual(
    withGated.next.map((task) => task.id),
    ["t1", "t2"]
  );
  assert.equal(withGated.next[1].actionability, "decision_gated");
  assert.deepEqual(withGated.next[1].decision_required, ["new dependencies"]);
  assert.ok(withGated.next[1].reason.some((reason) => reason.includes("Decision required")));
});

test("buildNextPayload prefers bounded actionable work over aggregate roadmap rows", () => {
  const project = projectWithPriorities();
  project.tasks = [
    {
      id: "rm-investor-demo-open",
      title: "Investor Demo Open Work",
      status: "in_progress",
      placement: { swimlaneId: "ops", priorityId: "p0" },
      dependencies: [],
      context: {
        tags: ["roadmap", "investor-demo-open"],
        source_title: "Open Investor Demo Work",
        task_count: 13,
        completed_subtasks: 4,
        open_subtasks: 9
      }
    },
    {
      id: "rm-parallel-execution",
      title: "Parallel Execution",
      status: "in_progress",
      placement: { swimlaneId: "exec", priorityId: "p3" },
      dependencies: [],
      context: {
        tags: ["roadmap", "parallel-execution"],
        source_title: "Current Parallel Execution Status",
        task_count: 5,
        completed_subtasks: 2,
        open_subtasks: 3
      }
    },
    {
      id: "t-017",
      title: "Parallel execution branch/variant route-flow proof",
      status: "in_progress",
      placement: { swimlaneId: "exec", priorityId: "p3" },
      dependencies: ["rm-parallel-execution"],
      assignee: "codex",
      references: [
        "docs/PHALANX_ROADMAP.md:619",
        "docs/references/PARALLEL_EXECUTION_BRANCH_VARIANT_ROUTE_FLOW_PROOF_CLAUDE_PROMPT.md:1"
      ],
      context: {
        tags: ["parallel-execution", "branch-variants", "route-flow-proof"]
      }
    }
  ];

  const payload = buildNextPayload({
    slug: "test-project",
    data: project
  });

  assert.equal(payload.recommendedTaskId, "t-017");
  assert.deepEqual(
    payload.next.map((task) => task.id),
    ["t-017"]
  );
  assert.equal(payload.next[0].ready, true);
  assert.equal(payload.next[0].aggregate, false);
  assert.equal(payload.next[0].actionability, "executable");
  assert.equal(payload.actionabilityCounts.parked, 2);
  assert.equal(payload.hiddenByActionability.parked, 2);
});

test("buildNextPayload does not fall back to aggregate rows when no executable task exists", () => {
  const project = projectWithPriorities();
  project.tasks = [
    {
      id: "rm-live-run-progress-surface",
      title: "Live Run Progress",
      status: "in_progress",
      placement: { swimlaneId: "ops", priorityId: "p0" },
      dependencies: [],
      context: {
        tags: ["roadmap", "live-run-progress-surface"],
        source_title: "Next In-Line P0",
        task_count: 11,
        completed_subtasks: 10,
        open_subtasks: 1
      }
    },
    {
      id: "rm-operator-trust",
      title: "Operator Trust",
      status: "not_started",
      placement: { swimlaneId: "ops", priorityId: "p0" },
      dependencies: [],
      context: {
        tags: ["roadmap", "operator-trust"],
        source_title: "Operator Trust Queue",
        task_count: 11,
        completed_subtasks: 9,
        open_subtasks: 2
      }
    }
  ];

  const payload = buildNextPayload({
    slug: "test-project",
    data: project
  });

  assert.equal(payload.recommendedTaskId, null);
  assert.deepEqual(
    payload.next.map((task) => task.id),
    []
  );
  assert.equal(payload.actionabilityCounts.parked, 2);
  assert.equal(payload.hiddenByActionability.parked, 2);
});

test("buildNextPayload parks explicit groups and parent containers", () => {
  const project = projectWithPriorities();
  project.tasks = [
    {
      id: "g1",
      kind: "group",
      title: "Container group",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: []
    },
    {
      id: "parent",
      title: "Parent row",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p0" },
      dependencies: []
    },
    {
      id: "child",
      title: "Executable child",
      status: "not_started",
      parent_id: "parent",
      placement: { swimlaneId: "exec", priorityId: "p1" },
      dependencies: []
    }
  ];

  const payload = buildNextPayload({
    slug: "test-project",
    data: project
  });

  assert.deepEqual(
    payload.next.map((task) => task.id),
    ["child"]
  );
  assert.equal(payload.next[0].actionability, "executable");
  assert.equal(payload.actionabilityCounts.executable, 1);
  assert.equal(payload.actionabilityCounts.parked, 2);
  assert.equal(payload.hiddenByActionability.parked, 2);
});

test("buildNextPayload prefers active bounded work over starting a new bounded task", () => {
  const project = projectWithPriorities();
  project.tasks = [
    {
      id: "t-in-progress",
      title: "Continue active seam",
      status: "in_progress",
      placement: { swimlaneId: "exec", priorityId: "p3" },
      dependencies: [],
      assignee: "codex",
      references: ["docs/plan.md:1-20"]
    },
    {
      id: "t-not-started",
      title: "Start a fresh task",
      status: "not_started",
      placement: { swimlaneId: "exec", priorityId: "p2" },
      dependencies: []
    }
  ];

  const payload = buildNextPayload({
    slug: "test-project",
    data: project
  });

  assert.deepEqual(
    payload.next.map((task) => task.id),
    ["t-in-progress", "t-not-started"]
  );
});
