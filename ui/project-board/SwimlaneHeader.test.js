import { test } from "node:test";
import assert from "node:assert/strict";

import { SwimlaneHeaderView } from "./SwimlaneHeader.js";

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

test("SwimlaneHeaderView renders lane stats and run-next affordance", () => {
  let opened = null;
  const vnode = SwimlaneHeaderView({
    projectSlug: "demo",
    lane: { id: "lane-a", label: "Track 2" },
    total: 4,
    active: 1,
    candidates: [{ taskId: "t1", laneId: "lane-a", score: 9, reasons: ["highest fit"] }],
    onRunNext: (intent) => {
      opened = intent;
    },
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /Track 2/);
  assert.match(text, /4\s+tasks/);
  assert.match(text, /1\s+active/);
  assert.match(text, /\[\+ NEXT IN LANE\]/);
  const button = flattenRenderedNodes(vnode).find((node) => node.props?.class === "swimlane-run-next-button");
  button.props.onClick();
  assert.equal(opened.taskId, "t1");
  assert.equal(opened.reason, "highest fit");
});
