import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TaskSessionBadge,
  TaskSessionBadgeView,
  findTaskSession,
  formatSessionActivity,
  taskSessionBadgeModel,
} from "./TaskSessionBadge.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

function renderVNode(node) {
  if (node && typeof node.type === "function") return renderVNode(node.type(node.props || {}));
  return node;
}

test("findTaskSession resolves active sessions by bound task id", () => {
  const session = findTaskSession(
    { id: "task-1" },
    [
      { id: "stopped", taskId: "task-1", status: "stopped" },
      { id: "active", taskId: "task-1", tier: "codex_app_server", status: "active" },
    ],
  );
  assert.equal(session.id, "active");
});

test("findTaskSession resolves embedded active sessions from task cards", () => {
  const session = findTaskSession({
    id: "task-1",
    activeSession: { id: "ses-1", tier: "mcp_tracked", status: "quiet" },
  });
  assert.equal(session.id, "ses-1");
});

test("taskSessionBadgeModel shows tier, status, and stable last activity", () => {
  const model = taskSessionBadgeModel({
    task: { id: "task-1" },
    sessions: [
      {
        id: "ses-1",
        taskId: "task-1",
        tier: "codex_app_server",
        status: "active",
        lastActivityAt: "2026-05-29T20:15:30.000Z",
      },
    ],
  });
  assert.deepEqual(model, {
    sessionId: "ses-1",
    taskId: "task-1",
    tier: "codex_app_server",
    status: "active",
    lastActivity: "2026-05-29 20:15",
  });
});

test("TaskSessionBadgeView renders inline badge attrs and labels", () => {
  const vnode = TaskSessionBadgeView({
    model: {
      sessionId: "ses-1",
      taskId: "task-1",
      tier: "mcp_tracked",
      status: "quiet",
      lastActivity: "2026-05-29 20:15",
    },
  });
  assert.equal(vnode.props.class, "task-session-badge");
  assert.equal(vnode.props["data-session-id"], "ses-1");
  assert.equal(vnode.props["data-task-id"], "task-1");
  const text = collectVNodeText(vnode);
  assert.match(text, /mcp_tracked/);
  assert.match(text, /quiet/);
  assert.match(text, /2026-05-29 20:15/);
});

test("TaskSessionBadge renders null when task card is not bound to an active session", () => {
  assert.equal(renderVNode(TaskSessionBadge({ task: { id: "task-1" }, sessions: [] })), null);
  assert.equal(formatSessionActivity("not-a-date"), "not-a-date");
  assert.equal(formatSessionActivity(""), "activity unknown");
});
