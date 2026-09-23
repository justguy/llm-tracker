import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionSkillsTab, normalizeSkillPlanItems } from "./SessionSkillsTab.js";

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

test("normalizeSkillPlanItems accepts job skill plan rows", () => {
  const rows = normalizeSkillPlanItems({
    job: {
      skillPlan: [
        {
          id: "spi_1",
          skillId: "lt.verify",
          phase: "before_complete",
          required: true,
          status: "satisfied",
          runId: "run_1",
          evidenceRef: "evt_skill_1",
        },
      ],
    },
  });
  assert.deepEqual(rows[0], {
    id: "spi_1",
    skillId: "lt.verify",
    phase: "before_complete",
    status: "satisfied",
    required: true,
    runId: "run_1",
    source: "",
    evidenceRef: "evt_skill_1",
  });
});

test("SessionSkillsTab shows skill plan status and RuntimeEvent evidence links", () => {
  const vnode = SessionSkillsTab({
    job: {
      skillPlan: [
        {
          id: "spi_1",
          skillId: "lt.closeout_sweep",
          phase: "after_complete",
          required: true,
          status: "pending",
          source: "profile",
          evidenceRef: "evt_closeout",
        },
      ],
    },
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /Skill plan/);
  assert.match(text, /lt\.closeout_sweep/);
  assert.match(text, /after_complete/);
  assert.match(text, /required/);
  assert.match(text, /pending/);
  const link = flattenRenderedNodes(vnode).find((node) => node.props?.["data-evidence-ref"] === "evt_closeout");
  assert.equal(link.props.href, "#runtime-event-evt_closeout");
});
