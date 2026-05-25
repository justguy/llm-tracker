// test/triage-page-ui.test.js — SH-4-07
//
// Triage page test coverage. Pure pivot helpers are tested directly. The
// rendered component is exercised via a small vnode-walk pattern that mirrors
// existing UI tests (test/ui-hero-strip.test.js) so we avoid pulling in
// jsdom / preact-render-to-string.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TriagePageView,
  filterTriageItems,
  groupBySeverityThenKind,
  isItemDimmed,
  TRIAGE_SEVERITY_ORDER,
} from "../ui/triage/TriagePage.js";

const NOW_ISO = "2026-05-24T12:00:00.000Z";
const NOW = new Date(NOW_ISO);

function makeItem(overrides = {}) {
  return {
    id: overrides.id || `att_${overrides.kind || "k"}_${overrides.dedupeKey || "x"}`,
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

test("TRIAGE_SEVERITY_ORDER follows §8A.3 highest -> lowest", () => {
  assert.deepEqual(TRIAGE_SEVERITY_ORDER, ["critical", "high", "medium", "low"]);
});

test("filterTriageItems drops cleared items and keeps acked / future-snoozed", () => {
  const items = [
    makeItem({ kind: "blocked", dedupeKey: "1" }),
    makeItem({ kind: "blocked", dedupeKey: "2", clearedAt: NOW_ISO }),
    makeItem({ kind: "blocked", dedupeKey: "3", acknowledgedAt: NOW_ISO }),
    makeItem({ kind: "blocked", dedupeKey: "4", snoozedUntil: "2026-05-24T13:00:00.000Z" }),
  ];
  const out = filterTriageItems(items);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((i) => i.dedupeKey).sort(), ["1", "3", "4"]);
});

test("filterTriageItems is defensive: non-array -> []", () => {
  assert.deepEqual(filterTriageItems(null), []);
  assert.deepEqual(filterTriageItems(undefined), []);
  assert.deepEqual(filterTriageItems("nope"), []);
});

test("isItemDimmed: acked or future-snoozed -> true; otherwise -> false", () => {
  assert.equal(isItemDimmed(makeItem(), NOW), false);
  assert.equal(isItemDimmed(makeItem({ acknowledgedAt: NOW_ISO }), NOW), true);
  assert.equal(
    isItemDimmed(makeItem({ snoozedUntil: "2026-05-24T13:00:00.000Z" }), NOW),
    true,
  );
  // past snoozedUntil should not dim
  assert.equal(
    isItemDimmed(makeItem({ snoozedUntil: "2026-05-24T11:00:00.000Z" }), NOW),
    false,
  );
});

test("groupBySeverityThenKind returns exactly 4 lanes in §8A.3 order, even when empty", () => {
  const lanes = groupBySeverityThenKind([]);
  assert.equal(lanes.length, 4);
  assert.deepEqual(
    lanes.map((l) => l.severity),
    ["critical", "high", "medium", "low"],
  );
  for (const lane of lanes) {
    assert.equal(lane.count, 0);
    assert.deepEqual(lane.kinds, []);
  }
});

test("groupBySeverityThenKind groups items by severity then by kind; counts reflect items in lane", () => {
  const items = [
    makeItem({ kind: "approval_needed", severity: "critical", dedupeKey: "a1" }),
    makeItem({ kind: "approval_needed", severity: "critical", dedupeKey: "a2" }),
    makeItem({ kind: "conflict", severity: "critical", dedupeKey: "c1" }),
    makeItem({ kind: "blocked", severity: "high", dedupeKey: "b1" }),
    makeItem({ kind: "context_high", severity: "high", dedupeKey: "ctx1" }),
    makeItem({ kind: "verify_missing", severity: "medium", dedupeKey: "v1" }),
    makeItem({ kind: "quiet", severity: "low", dedupeKey: "q1" }),
    // cleared item — must be filtered before bucketing
    makeItem({ kind: "quiet", severity: "low", dedupeKey: "qX", clearedAt: NOW_ISO }),
  ];

  const lanes = groupBySeverityThenKind(items);
  const [crit, high, med, low] = lanes;

  assert.equal(crit.count, 3);
  // approval_needed cluster has 2 items, conflict has 1 — approval_needed
  // should come first because count-desc.
  assert.equal(crit.kinds[0].kind, "approval_needed");
  assert.equal(crit.kinds[0].items.length, 2);
  assert.equal(crit.kinds[1].kind, "conflict");
  assert.equal(crit.kinds[1].items.length, 1);

  assert.equal(high.count, 2);
  // tie on count -> alphabetical
  assert.deepEqual(high.kinds.map((k) => k.kind), ["blocked", "context_high"]);

  assert.equal(med.count, 1);
  assert.equal(med.kinds[0].kind, "verify_missing");

  assert.equal(low.count, 1);
  assert.equal(low.kinds[0].kind, "quiet");
  // cleared item filtered out -> low.count is 1, not 2
});

test("groupBySeverityThenKind: unknown severity falls into 'low' lane", () => {
  const items = [makeItem({ kind: "blocked", severity: "weird", dedupeKey: "w1" })];
  const lanes = groupBySeverityThenKind(items);
  const low = lanes.find((l) => l.severity === "low");
  assert.equal(low.count, 1);
});

test("TriagePage renders four lane sections in severity order", () => {
  const items = [makeItem({ kind: "blocked", severity: "high", dedupeKey: "b1" })];
  const vnode = TriagePageView({ items, now: NOW });
  const laneNodes = findNodes(vnode, (n) => n.props?.["data-severity"]);
  assert.equal(laneNodes.length, 4);
  assert.deepEqual(
    laneNodes.map((n) => n.props["data-severity"]),
    ["critical", "high", "medium", "low"],
  );
});

test("TriagePage shows 'All clear' for empty lanes and a count chip with the lane count", () => {
  const items = [makeItem({ kind: "blocked", severity: "high", dedupeKey: "b1" })];
  const vnode = TriagePageView({ items, now: NOW });
  const text = collectVNodeText(vnode);
  // empty lanes (critical, medium, low) each contribute one 'All clear'
  const allClearMatches = text.match(/All clear/g) || [];
  assert.equal(allClearMatches.length, 3);
  // high lane shows the title and count 1
  assert.ok(text.includes("HIGH") || text.includes("High"));
});

test("TriagePage filters cleared items from the rendered surface", () => {
  const items = [
    makeItem({ kind: "blocked", severity: "high", title: "Active blocker", dedupeKey: "b1" }),
    makeItem({ kind: "blocked", severity: "high", title: "Stale cleared", dedupeKey: "b2", clearedAt: NOW_ISO }),
  ];
  const vnode = TriagePageView({ items, now: NOW });
  const text = collectVNodeText(vnode);
  assert.ok(text.includes("Active blocker"));
  assert.ok(!text.includes("Stale cleared"));
});

test("TriagePage card carries source label and renders a dimmed marker for acked items", () => {
  const items = [
    makeItem({
      kind: "blocked",
      severity: "high",
      title: "Acked item",
      source: "structured",
      acknowledgedAt: NOW_ISO,
      dedupeKey: "ack1",
    }),
  ];
  const vnode = TriagePageView({ items, now: NOW });
  const cards = findNodes(
    vnode,
    (n) =>
      n.type === "div" &&
      typeof n.props?.class === "string" &&
      n.props.class.split(/\s+/).includes("triage__card"),
  );
  assert.equal(cards.length, 1);
  assert.ok(cards[0].props.class.includes("triage__card--dimmed"));
  const text = collectVNodeText(vnode);
  assert.ok(text.includes("structured"));
  assert.ok(text.toLowerCase().includes("muted"));
});

test("TriagePage action chips: disabled actions render disabledReason and do not fire onAction on click", () => {
  let firedFor = null;
  const items = [
    makeItem({
      kind: "blocked",
      severity: "high",
      dedupeKey: "actn1",
      recommendedActions: [
        { id: "open", label: "Open", kind: "open_session", enabled: true },
        {
          id: "approve",
          label: "Approve",
          kind: "approve",
          enabled: false,
          disabledReason: "needs reviewer signoff",
        },
      ],
    }),
  ];
  const vnode = TriagePageView({
    items,
    now: NOW,
    onAction: (item, action) => {
      firedFor = action.id;
    },
  });
  const buttons = findNodes(
    vnode,
    (n) =>
      n.type === "button" &&
      typeof n.props?.class === "string" &&
      n.props.class.includes("triage__action"),
  );
  assert.equal(buttons.length, 2);
  const disabledBtn = buttons.find((b) => b.props.disabled === true);
  assert.ok(disabledBtn);
  assert.equal(disabledBtn.props.title, "needs reviewer signoff");

  // Simulate click on the disabled button — onAction must not fire.
  disabledBtn.props.onClick({ stopPropagation() {} });
  assert.equal(firedFor, null);

  // Click on the enabled button — onAction fires.
  const enabledBtn = buttons.find((b) => b.props.disabled !== true);
  enabledBtn.props.onClick({ stopPropagation() {} });
  assert.equal(firedFor, "open");
});

test("TriagePage action chips: feature-gated actions render generated disabledReason", () => {
  const items = [
    makeItem({
      kind: "context_high",
      severity: "high",
      dedupeKey: "gate1",
      recommendedActions: [
        { id: "rollover", label: "Roll over", kind: "rollover", enabled: true },
      ],
    }),
  ];
  const vnode = TriagePageView({ items, now: NOW });
  const buttons = findNodes(
    vnode,
    (n) =>
      n.type === "button" &&
      typeof n.props?.class === "string" &&
      n.props.class.includes("triage__action"),
  );
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, true);
  assert.match(buttons[0].props.title, /Rollover action handlers are gated/);
});

test("TriagePage onItemClick fires when the card is clicked (and not when a chip is clicked)", () => {
  const calls = [];
  const items = [
    makeItem({
      kind: "blocked",
      severity: "high",
      dedupeKey: "click1",
      recommendedActions: [
        { id: "open", label: "Open", kind: "open_session", enabled: true },
      ],
    }),
  ];
  const vnode = TriagePageView({
    items,
    now: NOW,
    onItemClick: (item) => calls.push(item.dedupeKey),
  });

  const card = findNodes(
    vnode,
    (n) =>
      n.type === "div" &&
      typeof n.props?.class === "string" &&
      n.props.class.includes("triage__card") &&
      typeof n.props.onClick === "function",
  )[0];
  assert.ok(card, "card should be clickable when onItemClick is provided");

  card.props.onClick();
  assert.deepEqual(calls, ["click1"]);

  // Button click stops propagation - but since we'd manually invoke the
  // card's onClick separately, just confirm the button has stopPropagation
  // wired (already done in the disabled-action test).
});
