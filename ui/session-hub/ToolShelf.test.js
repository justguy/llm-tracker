import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_SHELF_GROUPS, ToolShelf, toolShelfModel } from "./ToolShelf.js";

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

function nodesByClassName(vnode, className) {
  return flattenRenderedNodes(vnode).filter((node) => {
    const cls = node?.props?.class;
    return typeof cls === "string" && cls.split(/\s+/).includes(className);
  });
}

test("ToolShelf model exposes the five PRD tool groups", () => {
  assert.deepEqual(TOOL_SHELF_GROUPS.map((group) => group.id), [
    "task",
    "session",
    "job",
    "repo",
    "review",
  ]);
  const groups = toolShelfModel({
    task: { id: "task_1" },
    session: { id: "ses_1", activeJobId: "job_1", repoRoot: "/repo" },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { structuredChat: true, rawStdio: true, review: true, worktree: true },
  });
  assert.deepEqual(groups.map((group) => group.actions.map((action) => action.label)), [
    ["READ", "WHY", "EXEC", "VERIFY", "HANDOFF", "RUN"],
    ["CHAT", "STDIO", "PING", "STOP", "RESUME", "ROLLOVER", "ARCHIVE"],
    ["CONTEXT", "SKILLS", "CHECKPOINT", "BLOCKED", "VERIFY", "CLOSEOUT", "COMPLETE"],
    ["DIFF", "STATUS", "FILES", "WORKTREE", "CONFLICTS"],
    ["SPAWN REVIEWER", "CHANGED SINCE", "CLOSEOUT"],
  ]);
});

test("ToolShelf disables chat when provider thread is missing", () => {
  const vnode = ToolShelf({
    task: { id: "task_1" },
    session: {
      id: "ses_1",
      tier: "codex_app_server",
      provider: "codex",
      activeJobId: "job_1",
      repoRoot: "/repo",
      providerCapabilities: { turnSteer: true },
    },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { review: true, worktree: true },
  });
  const chat = flattenRenderedNodes(vnode).find((node) => node.props?.["data-action"] === "chat");
  assert.equal(chat.props.disabled, true);
  assert.equal(chat.props["data-disabled-reason"], "provider thread required for chat");
});

test("ToolShelf enables chat when provider id lives in providerThread", () => {
  const groups = toolShelfModel({
    task: { id: "task_1" },
    session: {
      id: "ses_1",
      activeJobId: "job_1",
      repoRoot: "/repo",
      providerThread: { providerId: "codex_app_server", threadId: "thread_1" },
      providerCapabilities: { turnSteer: true },
    },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { review: true, worktree: true },
  });
  const chat = groups.find((group) => group.id === "session").actions.find((action) => action.id === "chat");
  assert.equal(chat.disabled, false);
});

test("ToolShelf keeps unwired actions visible but disabled", () => {
  const groups = toolShelfModel({
    task: { id: "task_1" },
    session: {
      id: "ses_1",
      activeJobId: "job_1",
      repoRoot: "/repo",
      provider: "codex",
      providerThread: { threadId: "thread_1" },
      providerCapabilities: { turnSteer: true, rawStdio: true },
    },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { review: true, worktree: true },
  });
  const byId = new Map(groups.flatMap((group) => group.actions.map((action) => [`${group.id}:${action.id}`, action])));
  for (const key of [
    "session:rollover",
    "job:verify",
    "job:blocked",
    "repo:status",
    "repo:files",
    "repo:conflicts",
    "review:changed_since",
  ]) {
    assert.equal(byId.get(key).disabled, true, key);
    assert.equal(byId.get(key).reason, "not wired in live UI", key);
  }
});

test("ToolShelf keeps missing-capability actions visible with short disabled reasons", () => {
  const vnode = ToolShelf({
    task: { id: "task_1" },
    session: { id: "ses_1", tier: "app_server", activeJobId: "job_1", repoRoot: "/repo" },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { review: true, worktree: true },
  });
  const chat = flattenRenderedNodes(vnode).find((node) => node.props?.["data-action"] === "chat");
  assert.equal(chat.props.disabled, true);
  assert.equal(chat.props.title, "missing chat capability");
  assert.equal(chat.props["data-disabled-reason"], "missing chat capability");
  assert.match(collectVNodeText(vnode), /CHAT/);
  assert.match(collectVNodeText(vnode), /missing chat capability/);
});

test("ToolShelf offers MCP contract fallback for low-capability sessions", () => {
  const groups = toolShelfModel({
    task: { id: "task_1" },
    session: { id: "ses_1", tier: "dumb_terminal", activeJobId: "job_1", repoRoot: "/repo" },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { structured: false, structuredChat: false },
  });
  const sessionActions = groups.find((group) => group.id === "session").actions;
  const fallback = sessionActions.find((action) => action.id === "mcp_contract");
  assert.equal(fallback.disabled, false);
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.reason, "MCP contract fallback");
});

test("ToolShelf offers MCP fallback when individual capabilities are missing", () => {
  const groups = toolShelfModel({
    task: { id: "task_1" },
    session: { id: "ses_1", tier: "app_server", activeJobId: "job_1", repoRoot: "/repo" },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { structured: true, structuredChat: true, review: false, worktree: false },
  });
  const fallback = groups.find((group) => group.id === "session").actions.find((action) => action.id === "mcp_contract");
  assert.equal(fallback.disabled, false);
  assert.equal(fallback.fallback, true);
});

test("ToolShelf renders enabled MCP fallback and routes it", () => {
  const calls = [];
  const vnode = ToolShelf({
    task: { id: "task_1" },
    session: { id: "ses_1", tier: "manual", activeJobId: "job_1", repoRoot: "/repo" },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { structuredChat: true, review: true, worktree: true },
    onAction: (payload) => calls.push(payload),
  });

  const fallback = flattenRenderedNodes(vnode).find((node) => node.props?.["data-action"] === "mcp_contract");
  assert.equal(fallback.props.disabled, false);
  assert.match(fallback.props.class, /tool-shelf__action--fallback/);
  assert.equal(fallback.props.title, "MCP contract fallback");
  fallback.props.onClick();
  assert.deepEqual(
    { groupId: calls[0].groupId, actionId: calls[0].actionId },
    { groupId: "session", actionId: "mcp_contract" },
  );
});

test("ToolShelf reports degraded capability reasons for review, worktree, and stdio", () => {
  const vnode = ToolShelf({
    task: { id: "task_1" },
    session: { id: "ses_1", activeJobId: "job_1", repoRoot: "/repo", stdioAvailable: false },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { structuredChat: true, review: false, worktree: false },
  });
  const buttons = flattenRenderedNodes(vnode).filter((node) => node.props?.["data-action"]);
  assert.equal(buttons.find((node) => node.props["data-action"] === "spawn_reviewer").props["data-disabled-reason"], "missing review capability");
  assert.equal(buttons.find((node) => node.props["data-action"] === "worktree").props["data-disabled-reason"], "missing worktree capability");
  assert.equal(buttons.find((node) => node.props["data-action"] === "stdio").props["data-disabled-reason"], "missing raw stdio capability");
});

test("ToolShelf keeps unwired live-app actions visible but disabled", () => {
  const vnode = ToolShelf({
    task: { id: "task_1" },
    session: { id: "ses_1", activeJobId: "job_1", repoRoot: "/repo", stdioAvailable: true },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { structuredChat: true, rawStdio: true, review: true, worktree: true },
  });
  const buttons = flattenRenderedNodes(vnode).filter((node) => node.props?.["data-action"]);
  for (const action of ["handoff", "ping", "stop", "resume", "archive", "checkpoint", "closeout", "changed_since"]) {
    const button = buttons.find((node) => node.props["data-action"] === action);
    assert.equal(button.props.disabled, true, `${action} should be disabled until routed`);
    assert.equal(button.props["data-disabled-reason"], "not wired in live UI");
  }
});

test("ToolShelf routes enabled actions and ignores disabled actions", () => {
  const calls = [];
  const vnode = ToolShelf({
    task: { id: "task_1" },
    session: { id: "ses_1", activeJobId: "job_1", repoRoot: "/repo" },
    job: { id: "job_1" },
    repo: { root: "/repo" },
    capabilities: { review: true, worktree: true },
    onAction: (payload) => calls.push(payload),
  });
  const buttons = nodesByClassName(vnode, "tool-shelf__action");
  buttons.find((node) => node.props["data-action"] === "read").props.onClick();
  buttons.find((node) => node.props["data-action"] === "chat").props.onClick();
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { groupId: calls[0].groupId, actionId: calls[0].actionId },
    { groupId: "task", actionId: "read" },
  );
});
