import { test } from "node:test";
import assert from "node:assert/strict";

import { JobContextTab, SessionContextTab, normalizeVerifyPackRows } from "./SessionContextTab.js";

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

test("normalizeVerifyPackRows joins verify pack items with completion gates", () => {
  const rows = normalizeVerifyPackRows({
    job: {
      verifyPack: {
        items: [{ id: "cmd.test", kind: "command", label: "Run tests", required: true }],
      },
      completionGates: [{ id: "cmd.test", status: "satisfied", evidenceRef: "evt_cmd" }],
    },
  });
  assert.deepEqual(rows[0], {
    id: "cmd.test",
    label: "Run tests",
    kind: "command",
    required: true,
    status: "satisfied",
    evidenceRef: "evt_cmd",
  });
});

test("SessionContextTab shows gate statuses and RuntimeEvent evidence links", () => {
  const vnode = SessionContextTab({
    job: {
      verifyPack: {
        items: [
          { id: "human.review", kind: "human_approval", prompt: "Approve release", required: true },
          { id: "lint", kind: "command", command: "npm run lint", required: false },
        ],
      },
      completionGates: [
        { id: "human.review", status: "pending" },
        { id: "lint", status: "satisfied", evidenceRef: "evt_lint" },
      ],
    },
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /Verify pack/);
  assert.match(text, /Approve release/);
  assert.match(text, /pending/);
  assert.match(text, /npm run lint/);
  assert.match(text, /satisfied/);
  const link = flattenRenderedNodes(vnode).find((node) => node.props?.["data-evidence-ref"] === "evt_lint");
  assert.equal(link.props.href, "#runtime-event-evt_lint");
});

test("JobContextTab aliases SessionContextTab", () => {
  assert.equal(JobContextTab, SessionContextTab);
});
