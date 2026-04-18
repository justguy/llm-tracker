import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCardMetaFacts,
  buildTaskFactList,
  defaultChangedFromRev,
  historyActionText,
  isIntelModeLoading
} from "../ui/lib/intelligence.js";
import { TaskIntelligenceView } from "../ui/modals/task-intelligence-view.js";
import { humanizeTaskOutcome, TASK_OUTCOME_VALUES } from "../ui/task-outcomes.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) {
    return node.map((item) => collectVNodeText(item)).join(" ");
  }
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (typeof node.type === "function") {
    return collectVNodeText(node.type(node.props || {}));
  }
  return collectVNodeText(node.props?.children);
}

test("defaultChangedFromRev clamps at zero", () => {
  assert.equal(defaultChangedFromRev(null), 0);
  assert.equal(defaultChangedFromRev(3, 10), 0);
  assert.equal(defaultChangedFromRev(18, 10), 8);
});

test("historyActionText reports delete, restore, undo, redo, and rollback events", () => {
  assert.equal(historyActionText({ action: "delete", deletedFromRev: 14 }), "delete after rev 14");
  assert.equal(historyActionText({ action: "restore", restoredFromRev: 7 }), "restore from rev 7");
  assert.equal(historyActionText({ action: "undo", undoOfRev: 14 }), "undo of rev 14");
  assert.equal(historyActionText({ action: "redo", redoOfRev: 14 }), "redo of rev 14");
  assert.equal(historyActionText({ rolledBackTo: 7 }), "rollback to rev 7");
  assert.equal(historyActionText({ rolledBackFrom: 18 }), "rollback from rev 18");
  assert.equal(historyActionText({}), "change");
});

test("buildTaskFactList surfaces readiness, approvals, and freshness", () => {
  const facts = buildTaskFactList({
    status: "in_progress",
    priorityId: "p0",
    swimlaneId: "exec",
    effort: "m",
    ready: false,
    blocked_kind: "deps",
    blocking_on: ["t-001", "t-002"],
    requires_approval: ["new dependency"],
    assignee: "codex",
    lastTouchedRev: 12
  });

  assert.deepEqual(
    facts.map((fact) => fact.label),
    ["status", "priority", "lane", "effort", "ready", "blocked", "blocking_on", "approval", "assignee", "last_touch"]
  );
  assert.equal(facts.find((fact) => fact.label === "ready")?.value, "no");
  assert.equal(facts.find((fact) => fact.label === "approval")?.value, "new dependency");
  assert.equal(facts.find((fact) => fact.label === "last_touch")?.value, "rev 12");
});

test("buildCardMetaFacts surfaces blocked deps, approvals, and task rev", () => {
  const facts = buildCardMetaFacts(
    {
      approval_required_for: ["breaking API change", "new dependency"],
      rev: 17
    },
    ["t-004"]
  );

  assert.deepEqual(
    facts.map((fact) => fact.label),
    ["deps", "approval", "rev"]
  );
  assert.equal(facts[0].value, "t-004");
  assert.equal(facts[1].value, "2 gates");
  assert.equal(facts[2].value, "r17");
});

test("task outcome helpers expose the canonical marker label", () => {
  assert.ok(TASK_OUTCOME_VALUES.includes("partial_slice_landed"));
  assert.equal(humanizeTaskOutcome("partial_slice_landed"), "partial slice landed");
  assert.equal(humanizeTaskOutcome(null), "");
});

test("isIntelModeLoading derives loading per mode from cache and errors", () => {
  assert.equal(isIntelModeLoading({}, {}, "why"), true);
  assert.equal(isIntelModeLoading({ why: { packType: "why" } }, {}, "why"), false);
  assert.equal(isIntelModeLoading({}, { why: "request failed" }, "why"), false);
  assert.equal(isIntelModeLoading({}, {}, null), false);
});

test("TaskIntelligenceView renders reusable task intelligence sections for drawer consumers", () => {
  const vnode = TaskIntelligenceView({
    task: {
      id: "t7",
      title: "Prepare inline drawer reuse",
      status: "in_progress",
      priorityId: "p0",
      swimlaneId: "exec"
    },
    mode: "why",
    payload: {
      task: {
        id: "t7",
        title: "Prepare inline drawer reuse",
        status: "in_progress",
        priorityId: "p0",
        swimlaneId: "exec",
        goal: "Share the task intelligence view across shells",
        comment: "Keep modal behavior unchanged",
        blocker_reason: "Waiting on reuse-ready exports"
      },
      why: [{ kind: "unblock", text: "Drawer work depends on the shared task view" }],
      blockedBy: [{ id: "t6", title: "Prep shared helpers", status: "done" }],
      unblocks: [{ id: "t8", title: "Wire inline drawer", status: "not_started" }],
      references: [{ value: "ui/modals/intelligence.js:1", selectedBecause: "current task shell" }],
      recentHistory: [{ rev: 14, ts: "2026-04-18T00:00:00.000Z", summary: [{ kind: "edit", id: "t7" }] }],
      truncation: { history: { returned: 1 } }
    },
    error: null,
    loading: false,
    onRetry() {},
    onSelectMode() {},
    onOpenTask() {}
  });

  const text = collectVNodeText(vnode).replace(/\s+/g, " ").trim();

  assert.match(text, /\[READ\]/);
  assert.match(text, /\[WHY\]/);
  assert.match(text, /Prepare inline drawer reuse/);
  assert.match(text, /Share the task intelligence view across shells/);
  assert.match(text, /Keep modal behavior unchanged/);
  assert.match(text, /Waiting on reuse-ready exports/);
  assert.match(text, /Drawer work depends on the shared task view/);
  assert.match(text, /ui\/modals\/intelligence\.js:1/);
});
