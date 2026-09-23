import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AttentionItemCard,
  normalizeAttentionActionOptions,
} from "./AttentionItemCard.js";

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
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function buttons(vnode) {
  return flattenRenderedNodes(vnode).filter((node) => node.type === "button");
}

function worktreeItem() {
  return {
    id: "att_worktree",
    kind: "conflict",
    severity: "high",
    title: "Two sessions share a worktree",
    detail: "File attribution is ambiguous.",
    source: "watcher_git",
    projectSlug: "llm-tracker",
    worktreePath: "/repo/main",
    createdAt: "2026-05-29T12:00:00.000Z",
    updatedAt: "2026-05-29T12:00:00.000Z",
    dedupeKey: "conflict|worktree",
    recommendedActions: [
      { id: "create", label: "Create worktree", kind: "create_worktree", enabled: true },
    ],
  };
}

test("normalizeAttentionActionOptions maps trusted worktree config into feature gates", () => {
  const normalized = normalizeAttentionActionOptions({
    trustedLocalMode: { allowWorktreeCreationFromUI: true },
    worktrees: { allowTrustedAutoCreateOnLaunch: true },
  });
  assert.equal(normalized.features.worktreeCreation, true);
  assert.equal(normalized.features.worktreeTrustedAutoCreateOnLaunch, true);
});

test("AttentionItemCard disables create_worktree when trusted UI creation is off", () => {
  const vnode = AttentionItemCard({
    item: worktreeItem(),
    actionOptions: {
      trustedLocalMode: { allowWorktreeCreationFromUI: false },
    },
  });
  const [button] = buttons(vnode);
  assert.equal(button.props.disabled, true);
  assert.match(button.props.title, /Worktree creation is gated/);
});

test("AttentionItemCard enables create_worktree when trusted UI creation is on", () => {
  let captured = null;
  const item = worktreeItem();
  const vnode = AttentionItemCard({
    item,
    actionOptions: {
      trustedLocalMode: { allowWorktreeCreationFromUI: true },
      worktrees: { allowTrustedAutoCreateOnLaunch: true },
    },
    onAction: (nextItem, action) => {
      captured = { nextItem, action };
    },
  });
  const [button] = buttons(vnode);
  assert.equal(button.props.disabled, false);
  button.props.onClick({ stopPropagation() {} });
  assert.equal(captured.nextItem.id, item.id);
  assert.equal(captured.action.kind, "create_worktree");
});
