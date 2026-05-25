// test/attention-strip-ui.test.js — SH-4-06
//
// AttentionStrip view + helpers. Pure helpers tested directly; rendering
// exercised via the same vnode-walk pattern used by ui-hero-strip.test.js
// (avoids jsdom / preact-render-to-string).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AttentionStripView,
  isItemActive,
  filterActiveItems,
  criticalItems,
} from "../ui/attention/AttentionStrip.js";

const NOW_ISO = "2026-05-24T12:00:00.000Z";
const NOW = new Date(NOW_ISO);

function makeItem(overrides = {}) {
  return {
    id: overrides.id || `att_${Math.random().toString(36).slice(2)}`,
    kind: overrides.kind || "blocked",
    severity: overrides.severity || "high",
    title: overrides.title || "T",
    detail: overrides.detail || "",
    source: overrides.source || "structured",
    createdAt: overrides.createdAt || NOW_ISO,
    updatedAt: overrides.updatedAt || NOW_ISO,
    dedupeKey: overrides.dedupeKey || `dk-${Math.random()}`,
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

test("isItemActive hides cleared, acked, and future-snoozed items; keeps past-snoozed and plain items", () => {
  assert.equal(isItemActive(makeItem(), NOW), true);
  assert.equal(isItemActive(makeItem({ clearedAt: NOW_ISO }), NOW), false);
  assert.equal(isItemActive(makeItem({ acknowledgedAt: NOW_ISO }), NOW), false);
  assert.equal(
    isItemActive(makeItem({ snoozedUntil: "2026-05-24T13:00:00.000Z" }), NOW),
    false,
  );
  assert.equal(
    isItemActive(makeItem({ snoozedUntil: "2026-05-24T11:00:00.000Z" }), NOW),
    true,
  );
});

test("filterActiveItems is defensive on non-array input", () => {
  assert.deepEqual(filterActiveItems(null, NOW), []);
  assert.deepEqual(filterActiveItems(undefined, NOW), []);
});

test("criticalItems returns only active items with severity === 'critical'", () => {
  const items = [
    makeItem({ severity: "critical", dedupeKey: "c1" }),
    makeItem({ severity: "critical", dedupeKey: "c2", acknowledgedAt: NOW_ISO }), // hidden
    makeItem({ severity: "high", dedupeKey: "h1" }),
  ];
  const crit = criticalItems(items, NOW);
  assert.equal(crit.length, 1);
  assert.equal(crit[0].dedupeKey, "c1");
});

test("AttentionStripView with zero active items and no loadError returns null", () => {
  const vnode = AttentionStripView({ items: [], now: NOW, collapsed: false });
  assert.equal(vnode, null);
});

test("AttentionStripView expanded renders one card per active item", () => {
  const items = [
    makeItem({ kind: "blocked", severity: "high", dedupeKey: "1" }),
    makeItem({ kind: "approval_needed", severity: "critical", dedupeKey: "2" }),
  ];
  const vnode = AttentionStripView({ items, now: NOW, collapsed: false });
  const cards = findNodes(
    vnode,
    (n) =>
      n.type === "div" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("attention-strip__card"),
  );
  assert.equal(cards.length, 2);
});

test("AttentionStripView collapsed with zero critical items shows the count chip but no cards", () => {
  const items = [
    makeItem({ kind: "blocked", severity: "high", dedupeKey: "1" }),
    makeItem({ kind: "blocked", severity: "high", dedupeKey: "2" }),
  ];
  const vnode = AttentionStripView({ items, now: NOW, collapsed: true });
  const cards = findNodes(
    vnode,
    (n) =>
      n.type === "div" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("attention-strip__card"),
  );
  assert.equal(cards.length, 0, "no cards while collapsed without critical items");

  const countNodes = findNodes(
    vnode,
    (n) =>
      n.type === "span" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("attention-strip__count"),
  );
  assert.equal(countNodes.length, 1);
  assert.equal(countNodes[0].props["data-count"], 2);
});

test("AttentionStripView collapsed with at least one critical item surfaces both the count and each critical card (never silently buries critical)", () => {
  const items = [
    makeItem({ kind: "approval_needed", severity: "critical", title: "Need approval", dedupeKey: "c1" }),
    makeItem({ kind: "blocked", severity: "high", title: "Blocked task", dedupeKey: "h1" }),
  ];
  const vnode = AttentionStripView({ items, now: NOW, collapsed: true });

  // The critical marker is rendered next to the count chip.
  const criticalMarkers = findNodes(
    vnode,
    (n) =>
      n.type === "span" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("attention-strip__critical-marker"),
  );
  assert.equal(criticalMarkers.length, 1);
  assert.equal(criticalMarkers[0].props["data-critical"], 1);

  // Critical card is rendered; high card is not.
  const text = collectVNodeText(vnode);
  assert.ok(text.includes("Need approval"));
  assert.ok(!text.includes("Blocked task"));
});

test("AttentionStripView shows source label and kind label on each card", () => {
  const items = [
    makeItem({
      kind: "approval_needed",
      severity: "critical",
      title: "Need ok",
      source: "structured",
      dedupeKey: "src1",
    }),
  ];
  const vnode = AttentionStripView({ items, now: NOW, collapsed: false });
  const text = collectVNodeText(vnode);
  assert.ok(text.includes("structured"));
  assert.ok(text.includes("Approval needed"));
});

test("AttentionStripView action chips: disabled chips show disabledReason and do not fire onAction", () => {
  let firedFor = null;
  const items = [
    makeItem({
      kind: "blocked",
      severity: "high",
      dedupeKey: "act1",
      recommendedActions: [
        { id: "open", label: "Open", kind: "open_session", enabled: true },
        {
          id: "approve",
          label: "Approve",
          kind: "approve",
          enabled: false,
          disabledReason: "not your call",
        },
      ],
    }),
  ];
  const vnode = AttentionStripView({
    items,
    now: NOW,
    collapsed: false,
    onAction: (item, action) => {
      firedFor = action.id;
    },
  });
  const buttons = findNodes(
    vnode,
    (n) =>
      n.type === "button" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("attention-strip__action"),
  );
  assert.equal(buttons.length, 2);
  const disabled = buttons.find((b) => b.props.disabled === true);
  assert.equal(disabled.props.title, "not your call");
  disabled.props.onClick({ stopPropagation() {} });
  assert.equal(firedFor, null);
  const enabled = buttons.find((b) => b.props.disabled !== true);
  enabled.props.onClick({ stopPropagation() {} });
  assert.equal(firedFor, "open");
});

test("AttentionStripView toggle button fires onToggleCollapsed", () => {
  let toggled = 0;
  const items = [makeItem({ kind: "blocked", severity: "high", dedupeKey: "tog1" })];
  const vnode = AttentionStripView({
    items,
    now: NOW,
    collapsed: false,
    onToggleCollapsed: () => {
      toggled += 1;
    },
  });
  const toggle = findNodes(
    vnode,
    (n) =>
      n.type === "button" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("attention-strip__toggle"),
  )[0];
  assert.ok(toggle);
  toggle.props.onClick();
  assert.equal(toggled, 1);
});

test("AttentionStripView reports loadError in a small notice", () => {
  const vnode = AttentionStripView({
    items: [],
    now: NOW,
    collapsed: false,
    loadError: "HTTP 404",
  });
  const text = collectVNodeText(vnode);
  assert.ok(text.includes("404"));
  assert.ok(text.toLowerCase().includes("attention"));
});

test("AttentionStripView ignores acked and future-snoozed items per §23.2 #16", () => {
  const items = [
    makeItem({ kind: "blocked", severity: "high", dedupeKey: "vis" }),
    makeItem({ kind: "blocked", severity: "high", dedupeKey: "acked", acknowledgedAt: NOW_ISO }),
    makeItem({
      kind: "blocked",
      severity: "high",
      dedupeKey: "snoozed",
      snoozedUntil: "2026-05-24T15:00:00.000Z",
    }),
  ];
  const vnode = AttentionStripView({ items, now: NOW, collapsed: false });
  const cards = findNodes(
    vnode,
    (n) =>
      n.type === "div" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("attention-strip__card"),
  );
  assert.equal(cards.length, 1);
});
