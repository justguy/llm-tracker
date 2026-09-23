// ui/session-hub/__tests__/phase4a-acceptance.test.js - SH-4A-08

import { test } from "node:test";
import assert from "node:assert/strict";

import { EvidencePanelTrigger, evidencePanelModel } from "../../attention/EvidencePanel.js";
import { SessionCard } from "../SessionCard.js";
import { SESSION_DETAIL_TABS, SessionDetailDockView } from "../SessionDetailDock.js";

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

test("Phase 4A acceptance: detail dock exposes timeline tab rows with evidence links", () => {
  const vnode = SessionDetailDockView({
    session: { id: "ses_phase4a", status: "active" },
    activeTab: "timeline",
    timelineItems: [
      {
        id: "tl_provider",
        kind: "message",
        title: "assistant: ready",
        detail: "Ready to work.",
        source: "provider",
        confidence: "structured",
        evidenceRef: "provider:codex:message:thread-1",
      },
      {
        id: "tl_raw",
        kind: "message",
        title: "stderr output",
        detail: "approval requested text stays raw",
        source: "raw_stdio",
        confidence: "derived",
        evidenceRef: "evt_raw_stdio",
      },
    ],
  });

  assert.deepEqual(SESSION_DETAIL_TABS, [
    "summary",
    "timeline",
    "stdio",
    "chat",
    "diff",
    "context",
    "skills",
    "events",
  ]);
  const tabs = nodesByClassName(vnode, "session-detail-dock__tab");
  assert.deepEqual(tabs.map((tab) => collectVNodeText(tab).trim()), [
    "Summary",
    "Timeline",
    "Stdio raw",
    "Chat",
    "Diff/Evidence",
    "Context",
    "Skills",
    "Events",
  ]);

  const text = collectVNodeText(vnode);
  assert.match(text, /assistant: ready/);
  assert.match(text, /provider/);
  assert.match(text, /structured/);
  assert.match(text, /stderr output/);
  assert.match(text, /raw_stdio/);
  assert.match(text, /derived/);

  const evidenceLinks = nodesByClassName(vnode, "timeline-panel__evidence");
  assert.equal(evidenceLinks.length, 2);
  assert.equal(evidenceLinks[1].props.href, "#runtime-event-evt_raw_stdio");
  assert.equal(evidenceLinks[1].props["data-evidence-ref"], "evt_raw_stdio");
});

test("Phase 4A acceptance: large session cards show the last timeline items", () => {
  const vnode = SessionCard({
    size: "large",
    session: {
      id: "ses_phase4a_card",
      status: "active",
      timelineItems: [
        { id: "tl_1", kind: "status", title: "Session started", evidenceRef: "evt_start" },
        { id: "tl_2", kind: "message", title: "Provider message", evidenceRef: "evt_provider" },
        { id: "tl_3", kind: "repo_change", title: "Repo changed", evidenceRef: "evt_repo" },
        { id: "tl_4", kind: "verify", title: "Verify passed", evidenceRef: "evt_verify" },
      ],
    },
  });

  const rows = nodesByClassName(vnode, "session-card__timeline-preview-item");
  assert.equal(rows.length, 3);
  const text = collectVNodeText(vnode);
  assert.doesNotMatch(text, /Session started/);
  assert.match(text, /Provider message/);
  assert.match(text, /Repo changed/);
  assert.match(text, /Verify passed/);
});

test("Phase 4A acceptance: attention evidence trigger jumps to matching timeline row", () => {
  let scrolled = false;
  let highlighted = false;
  let opened = null;
  const timelineItem = {
    scrollIntoView(options) {
      scrolled = options?.block === "center";
    },
    classList: {
      add() {
        highlighted = true;
      },
      remove() {},
    },
  };
  const evidenceNode = {
    getAttribute(name) {
      return name === "data-evidence-ref" ? "evt_attention" : "";
    },
    closest(selector) {
      return selector === ".timeline-panel__item" ? timelineItem : null;
    },
  };
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === "[data-evidence-ref]" ? [evidenceNode] : [];
    },
  };

  try {
    const model = evidencePanelModel({
      id: "att_1",
      kind: "provider_error",
      severity: "high",
      title: "Provider error",
      detail: "Provider emitted an error.",
      source: "provider",
      confidence: "structured",
      evidenceRef: "evt_attention",
      createdAt: "2026-05-29T10:00:00.000Z",
      recommendedActions: [],
    });
    const vnode = EvidencePanelTrigger({ model, onOpen: (next) => { opened = next; } });
    const button = flattenRenderedNodes(vnode).find((node) => node.type === "button");
    button.props.onClick();
  } finally {
    globalThis.document = originalDocument;
  }

  assert.equal(opened.evidenceId, "evt_attention");
  assert.equal(scrolled, true);
  assert.equal(highlighted, true);
});
