import { test } from "node:test";
import assert from "node:assert/strict";
import { CommentBadge, FilterToggles, STATUS_ORDER } from "../ui/primitives.js";

function flattenRenderedNodes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => flattenRenderedNodes(item, acc));
    return acc;
  }
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return acc;
  }
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function buttonByClass(vnode, className) {
  return flattenRenderedNodes(vnode).find((node) => node.type === "button" && node.props?.class?.includes(className));
}

test("STATUS_ORDER preserves board status order", () => {
  assert.deepEqual(STATUS_ORDER, ["complete", "in_progress", "not_started", "deferred"]);
});

test("FilterToggles sets aria-pressed on view, status, and block toggles", () => {
  const vnode = FilterToggles({
    counts: { complete: 2, in_progress: 1, not_started: 3, deferred: 0 },
    statusFilters: new Set(["complete", "not_started"]),
    toggleStatus: () => {},
    blockedCount: 4,
    openCount: 6,
    blockFilters: new Set(["blocked"]),
    toggleBlock: () => {},
    boardView: "tree",
    setBoardView: () => {}
  });

  assert.equal(buttonByClass(vnode, "view-toggle active").props["aria-pressed"], true);
  assert.equal(buttonByClass(vnode, "status-complete").props["aria-pressed"], true);
  assert.equal(buttonByClass(vnode, "status-in_progress").props["aria-pressed"], false);
  assert.equal(buttonByClass(vnode, "block-toggle blocked").props["aria-pressed"], true);
  assert.equal(buttonByClass(vnode, "block-toggle open").props["aria-pressed"], false);
});

test("CommentBadge exposes keyboard activation wiring for the focusable badge", () => {
  const source = CommentBadge.toString();
  assert.match(source, /onKeyDown=\$\{activateFromKeyboard\}/);
  assert.match(source, /e\.key !== "Enter"/);
  assert.match(source, /e\.key !== " "/);
});
