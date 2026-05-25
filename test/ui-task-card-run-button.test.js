import { test } from "node:test";
import assert from "node:assert/strict";
import { Bracket } from "../ui/primitives.js";
import {
  Card,
  resolveTaskRunSessionAction,
} from "../ui/task-card.js";
import { applyRuntimeJobEvent } from "../ui/app.js";

function baseTask(overrides = {}) {
  return {
    id: "t-run",
    title: "Runnable task",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p1" },
    dependencies: [],
    context: {},
    ...overrides,
  };
}

function childrenOf(vnode) {
  const children = vnode?.props?.children;
  if (children == null) return [];
  return Array.isArray(children) ? children.flat(Infinity).filter(Boolean) : [children];
}

function findAll(vnode, predicate, acc = []) {
  if (!vnode || typeof vnode !== "object") return acc;
  if (predicate(vnode)) acc.push(vnode);
  for (const child of childrenOf(vnode)) findAll(child, predicate, acc);
  return acc;
}

function findRunSessionBracket(vnode) {
  return findAll(vnode, (node) => node.type === Bracket && node.props?.label === "+ RUN SESSION")[0] || null;
}

function findActionReason(vnode) {
  return findAll(vnode, (node) => node.type === "span" && node.props?.class === "card__action-reason")[0] || null;
}

test("resolveTaskRunSessionAction is ready for runnable unbound tasks", () => {
  assert.deepEqual(resolveTaskRunSessionAction(baseTask()), {
    visible: true,
    disabled: false,
    reason: null,
    kind: "ready",
  });
});

test("Card shows [+ RUN SESSION] for runnable unbound tasks and dispatches the callback", () => {
  let called = null;
  const task = baseTask();
  const vnode = Card({
    task,
    blockedBy: [],
    onRunSession: (selected, action) => {
      called = { selected, action };
    },
  });

  const run = findRunSessionBracket(vnode);
  assert.ok(run, "runnable card should include a run-session action");
  assert.equal(run.props.disabled, false);
  assert.equal(run.props.title, "Run session for t-run");

  let stopped = false;
  let prevented = false;
  run.props.onClick({
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(stopped, true);
  assert.equal(prevented, true);
  assert.equal(called.selected, task);
  assert.equal(called.action.kind, "ready");
});

test("Card disables run-session action with visible reason when dependencies are unmet", () => {
  const vnode = Card({
    task: baseTask(),
    blockedBy: ["dep-1", "dep-2"],
  });

  const run = findRunSessionBracket(vnode);
  assert.ok(run, "blocked runnable card should still show the action");
  assert.equal(run.props.disabled, true);
  assert.equal(run.props.title, "Blocked by unmet dependencies: dep-1, dep-2");

  const reason = findActionReason(vnode);
  assert.ok(reason, "disabled card should expose the reason next to the action");
  assert.equal(childrenOf(reason).join("").trim(), "Blocked by unmet dependencies: dep-1, dep-2");
});

test("Card disables run-session action with visible reason when an active job is bound", () => {
  const vnode = Card({
    task: baseTask({ activeJobId: "job_123" }),
    blockedBy: [],
  });

  const run = findRunSessionBracket(vnode);
  assert.ok(run);
  assert.equal(run.props.disabled, true);
  assert.equal(run.props.title, "Task already has active job job_123");

  const reason = findActionReason(vnode);
  assert.equal(childrenOf(reason).join("").trim(), "Task already has active job job_123");
});

test("runtime jobs are the authoritative active-job binding for task cards", () => {
  const action = resolveTaskRunSessionAction(baseTask(), [], {
    projectSlug: "demo",
    runtimeJobs: [
      { id: "job_other", projectSlug: "other", taskId: "t-run", status: "running" },
      { id: "job_done", projectSlug: "demo", taskId: "t-run", status: "completed" },
      { id: "job_live", projectSlug: "demo", taskId: "t-run", status: "blocked" },
    ],
  });

  assert.equal(action.disabled, true);
  assert.equal(action.kind, "active_job");
  assert.equal(action.reason, "Task already has active job job_live");
});

test("terminal runtime jobs do not disable the run-session action", () => {
  for (const status of ["completed", "cancelled", "rolled_over"]) {
    const action = resolveTaskRunSessionAction(baseTask(), [], {
      projectSlug: "demo",
      runtimeJobs: [{ id: `job_${status}`, projectSlug: "demo", taskId: "t-run", status }],
    });
    assert.equal(action.disabled, false, `${status} should not block a new run session`);
    assert.equal(action.kind, "ready");
  }
});

test("runtime session binding is a fallback when job projection is unavailable", () => {
  for (const status of ["running", "active"]) {
    const action = resolveTaskRunSessionAction(baseTask(), [], {
      projectSlug: "demo",
      runtimeSessions: [{ id: `ses_${status}`, projectSlug: "demo", taskId: "t-run", status }],
    });

    assert.equal(action.disabled, true);
    assert.equal(action.kind, "active_session");
    assert.equal(action.reason, `Task already has active session ses_${status}`);
  }
});

test("authoritative runtime state keeps stale task metadata from disabling runnable cards", () => {
  const action = resolveTaskRunSessionAction(baseTask({ activeJobId: "job_stale" }), [], {
    projectSlug: "demo",
    runtimeJobs: [],
    runtimeSessions: [],
  });

  assert.equal(action.disabled, false);
  assert.equal(action.kind, "ready");
});

test("applyRuntimeJobEvent tracks live runtime job status for the card resolver", () => {
  let jobs = applyRuntimeJobEvent([], {
    type: "job.started",
    jobId: "job_event",
    sessionId: "ses_event",
    projectSlug: "demo",
    taskId: "t-run",
    ts: "2026-05-25T19:00:00.000Z",
  });
  assert.equal(resolveTaskRunSessionAction(baseTask(), [], { projectSlug: "demo", runtimeJobs: jobs }).disabled, true);

  jobs = applyRuntimeJobEvent(jobs, {
    type: "job.completed",
    jobId: "job_event",
    status: "completed",
    ts: "2026-05-25T19:10:00.000Z",
  });
  assert.equal(resolveTaskRunSessionAction(baseTask(), [], { projectSlug: "demo", runtimeJobs: jobs }).disabled, false);
});

test("Card omits run-session action for closed tasks", () => {
  assert.equal(findRunSessionBracket(Card({ task: baseTask({ status: "complete" }) })), null);
  assert.equal(findRunSessionBracket(Card({ task: baseTask({ status: "deferred" }) })), null);
});
