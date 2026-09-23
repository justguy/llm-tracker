import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TASK_CARD_STATE_ACTIONS,
  TaskCard,
  resolveTaskCardState,
  taskCardActionsForState,
} from "./TaskCard.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

function flattenRenderedNodes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => flattenRenderedNodes(item, acc));
    return acc;
  }
  if (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number"
  ) {
    return acc;
  }
  if (typeof node.type === "function") return flattenRenderedNodes(node.type(node.props || {}), acc);
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function actionLabels(vnode) {
  return flattenRenderedNodes(vnode)
    .filter((node) => node.props?.class === "project-task-card__action")
    .map((node) => node.props["data-action"]);
}

test("taskCardActionsForState matches every PRD 8.1 task-card row exactly", () => {
  assert.deepEqual(taskCardActionsForState("unbound_runnable"), ["+ RUN SESSION"]);
  assert.deepEqual(taskCardActionsForState("bound_active"), ["OPEN SESSION", "CHECKPOINT", "ROLLOVER"]);
  assert.deepEqual(taskCardActionsForState("bound_quiet"), ["OPEN SESSION", "PING", "ROLLOVER"]);
  assert.deepEqual(taskCardActionsForState("done_active_job"), ["CLOSEOUT", "VERIFY", "ARCHIVE SESSION"]);
  assert.deepEqual(taskCardActionsForState("failed_abandoned"), ["RESUME", "RUN SUCCESSOR"]);
  assert.deepEqual(taskCardActionsForState("conflict"), ["VIEW CONFLICT", "CREATE WORKTREE"]);
});

test("resolveTaskCardState classifies PRD 8.1 task-card states", () => {
  assert.equal(resolveTaskCardState({ task: { id: "t1", status: "not_started" } }), "unbound_runnable");
  assert.equal(resolveTaskCardState({
    task: { id: "t1", activeSession: { id: "s1", status: "active" } },
  }), "bound_active");
  assert.equal(resolveTaskCardState({
    task: { id: "t1", activeSession: { id: "s1", status: "quiet" } },
  }), "bound_quiet");
  assert.equal(resolveTaskCardState({
    task: { id: "t1", status: "complete", activeJobId: "j1" },
  }), "done_active_job");
  assert.equal(resolveTaskCardState({
    task: { id: "t1", activeSession: { id: "s1", status: "failed" } },
  }), "failed_abandoned");
  assert.equal(resolveTaskCardState({
    task: { id: "t1", hasConflicts: true },
  }), "conflict");
});

test("TaskCard renders the exact action set for every state row", () => {
  for (const [state, expected] of Object.entries(TASK_CARD_STATE_ACTIONS)) {
    const vnode = TaskCard({ task: { id: state, title: state }, state });
    assert.equal(vnode.props["data-task-state"], state);
    assert.deepEqual(actionLabels(vnode), expected);
  }
});

test("TaskCard action callback includes action, state, and task", () => {
  let payload = null;
  const task = { id: "t1", title: "Run task" };
  const vnode = TaskCard({
    task,
    state: "unbound_runnable",
    onAction: (next) => {
      payload = next;
    },
  });
  const button = flattenRenderedNodes(vnode).find((node) => node.props?.class === "project-task-card__action");
  button.props.onClick();
  assert.deepEqual(payload, { action: "+ RUN SESSION", state: "unbound_runnable", task });
  assert.match(collectVNodeText(vnode), /\+\s+RUN SESSION/);
});
