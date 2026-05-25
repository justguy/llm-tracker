// test/attention-item-card-ui.test.js — SH-4-12
//
// AttentionItemCard view. Tests follow the vnode-walk pattern used in
// attention-strip-ui.test.js (avoids jsdom / preact-render-to-string).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AttentionItemCard,
  resolveClearCondition,
  ATTENTION_ITEM_CARD_KIND_LABELS,
  ATTENTION_ITEM_CARD_SEVERITY_LABELS,
} from "../ui/attention/AttentionItemCard.js";
import {
  CLEAR_CONDITIONS_BY_KIND,
} from "../hub/attention/types.js";

const ISO_NOW = "2026-05-24T12:00:00.000Z";

function makeItem(overrides = {}) {
  return {
    id: overrides.id || "att_card_test_1",
    kind: overrides.kind || "blocked",
    severity: overrides.severity || "high",
    title: overrides.title || "Blocked: dependency missing",
    detail: overrides.detail || "Job needs sh-1-99 to land first.",
    source: overrides.source || "structured",
    createdAt: overrides.createdAt || ISO_NOW,
    updatedAt: overrides.updatedAt || ISO_NOW,
    dedupeKey: overrides.dedupeKey || "blocked|p|t-1|||",
    recommendedActions: overrides.recommendedActions || [],
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
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function findNodes(vnode, predicate) {
  return flattenRenderedNodes(vnode).filter(predicate);
}

function nodesByClassContains(vnode, substring) {
  return findNodes(vnode, (n) => {
    const cls = n?.props?.class;
    return typeof cls === "string" && cls.includes(substring);
  });
}

function nodesByDataAttr(vnode, attr, value) {
  return findNodes(vnode, (n) => {
    const props = n?.props || {};
    return props[attr] === value;
  });
}

test("resolveClearCondition prefers item.clearCondition over the kind default", () => {
  const item = makeItem({ clearCondition: "custom" });
  assert.equal(resolveClearCondition(item), "custom");
});

test("resolveClearCondition falls back to the kind default when clearCondition is absent", () => {
  const item = makeItem({ kind: "blocked" });
  delete item.clearCondition;
  assert.equal(resolveClearCondition(item), CLEAR_CONDITIONS_BY_KIND.blocked);
});

test("resolveClearCondition returns empty string for unknown kind without explicit clearCondition", () => {
  assert.equal(resolveClearCondition({ kind: "ghost" }), "");
  assert.equal(resolveClearCondition(null), "");
  assert.equal(resolveClearCondition(undefined), "");
});

test("AttentionItemCard renders the kind label, severity chip, source, and title", () => {
  const vnode = AttentionItemCard({ item: makeItem({ kind: "approval_needed", severity: "critical", source: "derived", title: "Approve foo" }) });
  const text = collectVNodeText(vnode);
  assert.match(text, /Approve foo/);
  assert.match(text, new RegExp(ATTENTION_ITEM_CARD_KIND_LABELS.approval_needed));
  assert.match(text, new RegExp(ATTENTION_ITEM_CARD_SEVERITY_LABELS.critical));
  assert.match(text, /derived/);
});

test("AttentionItemCard surfaces the explicit clearCondition under the body", () => {
  const item = makeItem({ clearCondition: "next heartbeat or human ack" });
  const vnode = AttentionItemCard({ item });
  const clearNodes = nodesByDataAttr(vnode, "data-field", "clearCondition");
  assert.equal(clearNodes.length, 1, "expected exactly one clearCondition row");
  assert.match(collectVNodeText(clearNodes[0]), /next heartbeat or human ack/);
});

test("AttentionItemCard falls back to the §15 default clearCondition when missing", () => {
  const item = makeItem({ kind: "context_high" });
  delete item.clearCondition;
  const vnode = AttentionItemCard({ item });
  const clearNodes = nodesByDataAttr(vnode, "data-field", "clearCondition");
  assert.equal(clearNodes.length, 1);
  assert.match(
    collectVNodeText(clearNodes[0]),
    new RegExp(CLEAR_CONDITIONS_BY_KIND.context_high.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("AttentionItemCard renders 'Clears when' label alongside the clearCondition text", () => {
  const vnode = AttentionItemCard({ item: makeItem() });
  const text = collectVNodeText(vnode);
  assert.match(text, /Clears when/);
});

test("AttentionItemCard omits the clearCondition row when neither field nor default exists", () => {
  const vnode = AttentionItemCard({ item: { kind: "ghost", severity: "low", title: "x", detail: "", source: "unknown", recommendedActions: [] } });
  const clearNodes = nodesByDataAttr(vnode, "data-field", "clearCondition");
  assert.equal(clearNodes.length, 0);
});

test("AttentionItemCard renders recommended actions and dispatches onAction", () => {
  const item = makeItem({
    recommendedActions: [
      { id: "act_1", label: "Approve", kind: "approve", enabled: true },
      { id: "act_2", label: "Deny", kind: "deny", enabled: false, disabledReason: "policy" },
    ],
  });
  let captured = null;
  const vnode = AttentionItemCard({ item, onAction: (it, ac) => { captured = { it, ac }; } });
  const buttons = findNodes(vnode, (n) => n.type === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].props.disabled, false);
  assert.equal(buttons[1].props.disabled, true);
  // Click the enabled action.
  buttons[0].props.onClick({ stopPropagation() {} });
  assert.equal(captured?.it.id, item.id);
  assert.equal(captured?.ac.id, "act_1");
});

test("AttentionItemCard does NOT dispatch onAction for disabled actions", () => {
  const item = makeItem({
    recommendedActions: [
      { id: "act_x", label: "X", kind: "approve", enabled: false, disabledReason: "no" },
    ],
  });
  let captured = null;
  const vnode = AttentionItemCard({ item, onAction: () => { captured = "called"; } });
  const buttons = findNodes(vnode, (n) => n.type === "button");
  buttons[0].props.onClick({ stopPropagation() {} });
  assert.equal(captured, null);
});

test("AttentionItemCard fires onItemClick when card is clicked and sets role=button", () => {
  let received = null;
  const vnode = AttentionItemCard({ item: makeItem(), onItemClick: (it) => { received = it; } });
  const cards = nodesByClassContains(vnode, "attention-item-card--sev-");
  assert.ok(cards.length >= 1);
  const root = cards[0];
  assert.equal(root.props.role, "button");
  root.props.onClick();
  assert.equal(received?.id, "att_card_test_1");
});

test("AttentionItemCard returns null when item is missing", () => {
  assert.equal(AttentionItemCard({ item: null }), null);
  assert.equal(AttentionItemCard({}), null);
});
