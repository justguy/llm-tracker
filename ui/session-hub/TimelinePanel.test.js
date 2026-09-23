import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TimelinePanelView,
  normalizeTimelineItems,
  timelineEvidenceHref,
} from "./TimelinePanel.js";

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

test("normalizeTimelineItems keeps kind icon, title, detail, chips, and evidence", () => {
  const rows = normalizeTimelineItems([
    {
      id: "tl_1",
      kind: "verify",
      title: "Verify passed",
      detail: "node --test",
      source: "mcp",
      confidence: "structured",
      evidenceRef: "evt_verify",
      ts: "2026-05-29T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(rows[0], {
    id: "tl_1",
    kind: "verify",
    icon: "[V]",
    title: "Verify passed",
    detail: "node --test",
    source: "mcp",
    confidence: "structured",
    evidenceRef: "evt_verify",
    ts: "2026-05-29T00:00:00.000Z",
  });
});

test("TimelinePanelView renders item rows with source/confidence chips and evidence link", () => {
  const vnode = TimelinePanelView({
    items: [
      {
        id: "tl_1",
        kind: "warning",
        title: "Context high",
        detail: "91%",
        source: "derived",
        confidence: "reported",
        evidenceRef: "evt_1",
      },
    ],
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /\[!\]/);
  assert.match(text, /Context high/);
  assert.match(text, /91%/);
  assert.match(text, /derived/);
  assert.match(text, /reported/);
  const evidence = nodesByClassName(vnode, "timeline-panel__evidence")[0];
  assert.equal(evidence.props.href, "#runtime-event-evt_1");
  assert.equal(evidence.props["data-evidence-ref"], "evt_1");
});

test("timelineEvidenceHref URL-encodes evidence refs", () => {
  assert.equal(timelineEvidenceHref("evt/a b"), "#runtime-event-evt%2Fa%20b");
});
