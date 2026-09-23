// ui/attention/EvidencePanel.test.js -- SH-4-13

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EvidencePanelShellView,
  EvidencePanelTrigger,
  EvidencePanelView,
  TIMELINE_EVIDENCE_HIGHLIGHT_CLASS,
  evidencePanelModel,
  jumpToTimelineEvidence,
} from "./EvidencePanel.js";

function makeItem(overrides = {}) {
  return {
    id: "att_ev_1",
    kind: "conflict",
    severity: "critical",
    title: "Conflict on server.js",
    detail: "Watcher found overlapping edits.",
    source: "watcher",
    confidence: 0.87,
    evidenceRef: "evt_conflict_1",
    createdAt: "2026-05-24T12:00:00.000Z",
    projectSlug: "llm-tracker",
    taskId: "sh-4-13",
    jobId: "job_1",
    sessionId: "ses_1",
    dedupeKey: "conflict|server.js",
    recommendedActions: [{ id: "open-conflict", label: "Open conflict", kind: "open_conflict", enabled: true }],
    clearCondition: "conflict id disappears from watcher projection",
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

test("evidencePanelModel normalizes required drill-down fields", () => {
  const model = evidencePanelModel(makeItem());
  assert.equal(model.source, "watcher");
  assert.equal(model.confidence, "87%");
  assert.equal(model.evidenceId, "evt_conflict_1");
  assert.equal(model.evidenceKind, "evidence");
  assert.equal(model.evidenceHref, "#runtime-event-evt_conflict_1");
  assert.equal(model.timestamp, "2026-05-24T12:00:00.000Z");
  assert.equal(model.why, "Watcher found overlapping edits.");
  assert.equal(model.recommendedAction, "Open conflict");
  assert.equal(model.clearCondition, "conflict id disappears from watcher projection");
  assert.match(model.context, /project: llm-tracker/);
  assert.match(model.context, /session: ses_1/);
});

test("evidencePanelModel falls back to typed evidence ids and default clear condition", () => {
  const model = evidencePanelModel(makeItem({
    evidenceRef: "",
    runtimeEventId: "rt_123",
    kind: "context_high",
    clearCondition: "",
    confidence: "derived",
  }));
  assert.equal(model.evidenceId, "rt_123");
  assert.equal(model.evidenceKind, "runtime event");
  assert.equal(model.confidence, "derived");
  assert.match(model.clearCondition, /context/i);
});

test("EvidencePanelTrigger renders a critical status chip that can open the panel", () => {
  const model = evidencePanelModel(makeItem());
  let opened = null;
  const vnode = EvidencePanelTrigger({ model, variant: "critical", onOpen: (m) => { opened = m; } });
  const buttons = findNodes(vnode, (n) => n.type === "button");
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].props.class, /evidence-panel-trigger--critical/);
  assert.equal(buttons[0].props["data-evidence-id"], "evt_conflict_1");
  buttons[0].props.onClick();
  assert.equal(opened.evidenceId, "evt_conflict_1");
});

test("EvidencePanelTrigger also attempts the timeline jump for evidence-backed attention", () => {
  const model = evidencePanelModel(makeItem());
  let scrolled = false;
  const timelineItem = {
    scrollIntoView() {
      scrolled = true;
    },
    classList: {
      add() {},
      remove() {},
    },
  };
  const evidenceNode = {
    getAttribute(name) {
      return name === "data-evidence-ref" ? "evt_conflict_1" : "";
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
    const vnode = EvidencePanelTrigger({ model, variant: "badge" });
    findNodes(vnode, (n) => n.type === "button")[0].props.onClick();
  } finally {
    globalThis.document = originalDocument;
  }

  assert.equal(scrolled, true);
});

test("EvidencePanelView renders source, confidence, evidence id, timestamp, why, action, and clear condition", () => {
  const model = evidencePanelModel(makeItem());
  const vnode = EvidencePanelView({ model });
  const text = collectVNodeText(vnode);
  assert.match(text, /Source/);
  assert.match(text, /watcher/);
  assert.match(text, /Confidence/);
  assert.match(text, /87%/);
  assert.match(text, /evt_conflict_1/);
  assert.match(text, /Timestamp/);
  assert.match(text, /2026-05-24T12:00:00.000Z/);
  assert.match(text, /Why/);
  assert.match(text, /Watcher found overlapping edits/);
  assert.match(text, /Recommended action/);
  assert.match(text, /Open conflict/);
  assert.match(text, /Clear condition/);
  assert.match(text, /conflict id disappears/);

  const evidenceLinks = findNodes(vnode, (n) => n.type === "a" && n.props?.["data-evidence-ref"] === "evt_conflict_1");
  assert.equal(evidenceLinks.length, 1);
  assert.equal(evidenceLinks[0].props.href, "#runtime-event-evt_conflict_1");
});

test("EvidencePanel evidence link jumps to and highlights the matching timeline item", () => {
  const model = evidencePanelModel(makeItem());
  const vnode = EvidencePanelView({ model });
  const evidenceLink = findNodes(vnode, (n) => n.type === "a" && n.props?.["data-evidence-ref"] === "evt_conflict_1")[0];
  let prevented = false;
  let scrolled = false;
  let timeout = null;
  const classes = new Set();
  const timelineItem = {
    scrollIntoView(options) {
      scrolled = options;
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
    },
  };
  const evidenceNode = {
    getAttribute(name) {
      return name === "data-evidence-ref" ? "evt_conflict_1" : "";
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
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay) => {
      timeout = { callback, delay };
      return 1;
    };
    try {
      evidenceLink.props.onClick({ preventDefault: () => { prevented = true; } });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  } finally {
    globalThis.document = originalDocument;
  }

  assert.equal(prevented, true);
  assert.deepEqual(scrolled, { block: "center", inline: "nearest", behavior: "smooth" });
  assert.equal(classes.has(TIMELINE_EVIDENCE_HIGHLIGHT_CLASS), true);
  assert.equal(timeout.delay, 1600);
  timeout.callback();
  assert.equal(classes.has(TIMELINE_EVIDENCE_HIGHLIGHT_CLASS), false);
});

test("jumpToTimelineEvidence falls back to normal hash navigation when no timeline evidence matches", () => {
  const found = jumpToTimelineEvidence("missing", {
    documentRef: { querySelectorAll: () => [] },
    timerRef: { setTimeout: () => {} },
  });
  assert.equal(found, false);
});

test("jumpToTimelineEvidence ignores the EvidencePanel self-link before matching timeline evidence", () => {
  let selfScrolled = false;
  let timelineScrolled = false;
  const selfLink = {
    getAttribute(name) {
      return name === "data-evidence-ref" ? "evt_conflict_1" : "";
    },
    closest() {
      return null;
    },
    scrollIntoView() {
      selfScrolled = true;
    },
  };
  const timelineItem = {
    scrollIntoView() {
      timelineScrolled = true;
    },
    classList: {
      add() {},
      remove() {},
    },
  };
  const timelineLink = {
    getAttribute(name) {
      return name === "data-evidence-ref" ? "evt_conflict_1" : "";
    },
    closest(selector) {
      return selector === ".timeline-panel__item" ? timelineItem : null;
    },
  };

  const found = jumpToTimelineEvidence("evt_conflict_1", {
    documentRef: { querySelectorAll: () => [selfLink, timelineLink] },
    timerRef: { setTimeout: () => {} },
  });

  assert.equal(found, true);
  assert.equal(selfScrolled, false);
  assert.equal(timelineScrolled, true);
});

test("EvidencePanelShellView wires the clickable trigger to the panel", () => {
  const model = evidencePanelModel(makeItem());
  let opened = null;
  const vnode = EvidencePanelShellView({ model, open: true, onOpen: (m) => { opened = m; } });
  const buttons = findNodes(vnode, (n) => n.type === "button");
  const trigger = buttons.find((button) => String(button.props?.class || "").includes("evidence-panel-trigger"));
  assert.ok(trigger);
  trigger.props.onClick();
  assert.equal(opened.evidenceId, "evt_conflict_1");
  const dialogs = findNodes(vnode, (n) => n.props?.role === "dialog");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].props["data-evidence-id"], "evt_conflict_1");
});
