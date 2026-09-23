// ui/attention/__tests__/phase4-acceptance.test.js -- SH-4-10

import { test } from "node:test";
import assert from "node:assert/strict";

import { AttentionItemCard } from "../AttentionItemCard.js";
import { AttentionStripView } from "../AttentionStrip.js";
import { EvidencePanelShellView, evidencePanelModel } from "../EvidencePanel.js";
import { TriagePageView } from "../../triage/TriagePage.js";

const NOW = new Date("2026-05-24T12:00:00.000Z");

function makeItem(overrides = {}) {
  return {
    id: "att_phase4_1",
    kind: "approval_needed",
    severity: "critical",
    title: "Approval required",
    detail: "Provider requested a command approval.",
    source: "structured",
    confidence: "high",
    evidenceRef: "evt_approval_1",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    dedupeKey: "approval_needed|proj|task|job|ses|evt_approval_1",
    clearCondition: "structured approval resolved or denied",
    recommendedActions: [
      { id: "approve", label: "Approve", kind: "approve", enabled: true },
      { id: "deny", label: "Deny", kind: "deny", enabled: true },
    ],
    projectSlug: "proj",
    taskId: "task",
    jobId: "job",
    sessionId: "ses",
    ...overrides,
  };
}

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
  )
    return acc;
  if (typeof node.type === "function") return flattenRenderedNodes(node.type(node.props || {}), acc);
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function findNodes(vnode, predicate) {
  return flattenRenderedNodes(vnode).filter(predicate);
}

test("Phase 4 UI keeps critical attention visible when the strip is collapsed", () => {
  const items = [
    makeItem({ id: "critical", severity: "critical", title: "Critical approval" }),
    makeItem({ id: "high", severity: "high", kind: "blocked", title: "Blocked job" }),
  ];
  const vnode = AttentionStripView({ items, now: NOW, collapsed: true });
  const text = collectVNodeText(vnode);
  assert.match(text, /1\s+critical/);
  assert.match(text, /Critical approval/);
  assert.doesNotMatch(text, /Blocked job/);
});

test("Phase 4 UI groups triage by severity and kind while preserving source labels", () => {
  const vnode = TriagePageView({
    items: [
      makeItem({ id: "a1", kind: "approval_needed", severity: "critical", source: "structured" }),
      makeItem({ id: "a2", kind: "approval_needed", severity: "critical", source: "structured" }),
      makeItem({ id: "c1", kind: "conflict", severity: "critical", source: "watcher_git", title: "File conflict" }),
      makeItem({ id: "b1", kind: "blocked", severity: "high", source: "reported", title: "Blocked" }),
    ],
    now: NOW,
  });
  const lanes = findNodes(vnode, (node) => node.props?.["data-severity"]);
  assert.deepEqual(lanes.map((node) => node.props["data-severity"]), ["critical", "high", "medium", "low"]);
  const text = collectVNodeText(vnode);
  assert.match(text, /Approval needed/);
  assert.match(text, /Conflict/);
  assert.match(text, /structured/);
  assert.match(text, /watcher_git/);
});

test("Phase 4 UI renders source, clear condition, and recommended action chips on cards", () => {
  const item = makeItem();
  let captured = null;
  const vnode = AttentionItemCard({
    item,
    onAction: (nextItem, action) => {
      captured = { nextItem, action };
    },
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /Approval required/);
  assert.match(text, /structured/);
  assert.match(text, /Clears when/);
  assert.match(text, /structured approval resolved or denied/);
  assert.match(text, /Approve/);
  const buttons = findNodes(vnode, (node) => node.type === "button");
  buttons[0].props.onClick({ stopPropagation() {} });
  assert.equal(captured.nextItem.id, "att_phase4_1");
  assert.equal(captured.action.kind, "approve");
});

test("Phase 4 UI opens an evidence drill-down with evidence source and action context", () => {
  const item = makeItem({ title: "Critical status chip", evidenceRef: "evt_status_1" });
  const model = evidencePanelModel(item);
  let opened = null;
  const vnode = EvidencePanelShellView({
    model,
    trigger: "critical",
    open: true,
    onOpen: (nextModel) => {
      opened = nextModel;
    },
  });
  const trigger = findNodes(
    vnode,
    (node) => node.type === "button" && String(node.props?.class || "").includes("evidence-panel-trigger"),
  )[0];
  trigger.props.onClick();
  assert.equal(opened.evidenceId, "evt_status_1");
  const text = collectVNodeText(vnode);
  assert.match(text, /Source/);
  assert.match(text, /structured/);
  assert.match(text, /Confidence/);
  assert.match(text, /evt_status_1/);
  assert.match(text, /Recommended action/);
  assert.match(text, /Approve/);
  assert.match(text, /Clear condition/);
  const evidenceLinks = findNodes(vnode, (node) => node.type === "a" && node.props?.["data-evidence-ref"] === "evt_status_1");
  assert.equal(evidenceLinks.length, 1);
});
