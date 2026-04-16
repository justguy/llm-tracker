import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCardMetaFacts,
  buildTaskFactList,
  defaultChangedFromRev,
  historyActionText
} from "../ui/lib/intelligence.js";

test("defaultChangedFromRev clamps at zero", () => {
  assert.equal(defaultChangedFromRev(null), 0);
  assert.equal(defaultChangedFromRev(3, 10), 0);
  assert.equal(defaultChangedFromRev(18, 10), 8);
});

test("historyActionText reports undo, redo, and rollback events", () => {
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
