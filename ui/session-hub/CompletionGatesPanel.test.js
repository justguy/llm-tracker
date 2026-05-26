import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CompletionGatesPanel,
  completionGateMissingItems,
  isHumanApprovalGate,
} from "./CompletionGatesPanel.js";

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
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function nodesByClassName(vnode, className) {
  return flattenRenderedNodes(vnode).filter((n) => {
    const cls = n?.props?.class;
    return typeof cls === "string" && cls.split(/\s+/).includes(className);
  });
}

function result() {
  return {
    ok: false,
    mode: "gates_pending",
    missing: [
      {
        id: "cmd.ok",
        kind: "verify_pack",
        required: true,
        status: "pending",
        label: "Command check",
      },
      {
        id: "approve.ship",
        kind: "verify_pack",
        required: true,
        status: "pending",
        humanApproval: true,
        verifyItemKind: "human_approval",
        prompt: "Ship?",
      },
    ],
    overridePromptUrl: "/api/jobs/job_123/complete-override",
  };
}

test("completionGateMissingItems accepts both result field spellings", () => {
  assert.equal(completionGateMissingItems({ missing: [{ id: "a" }] }).length, 1);
  assert.equal(completionGateMissingItems({ missing_gates: [{ id: "b" }] })[0].id, "b");
});

test("isHumanApprovalGate detects projected human approval gates", () => {
  assert.equal(isHumanApprovalGate({ humanApproval: true }), true);
  assert.equal(isHumanApprovalGate({ verifyItemKind: "human_approval" }), true);
  assert.equal(isHumanApprovalGate({ kind: "command" }), false);
});

test("CompletionGatesPanel renders missing gates and primary actions", () => {
  const vnode = CompletionGatesPanel({
    result: result(),
    jobId: "job_123",
    session: { id: "ses_1" },
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /Completion gates/);
  assert.match(text, /2\s+missing/);
  assert.match(text, /Command check/);
  assert.match(text, /approve\.ship/);
  assert.match(text, /\[RUN MISSING\]/);
  assert.match(text, /\[RESOLVE HUMAN APPROVAL\]/);
  assert.match(text, /\[SPAWN REVIEWER\]/);
  assert.match(text, /\[OVERRIDE & COMPLETE\]/);
});

test("CompletionGatesPanel routes row and panel actions", () => {
  const calls = [];
  const vnode = CompletionGatesPanel({
    result: result(),
    jobId: "job_123",
    session: { id: "ses_1" },
    onRunMissing: (payload) => calls.push(["run", payload]),
    onSpawnReviewer: (payload) => calls.push(["reviewer", payload]),
  });
  const buttons = nodesByClassName(vnode, "completion-gates-panel__action");
  const runRow = buttons.find((button) => collectVNodeText(button).includes("[RUN MISSING]") && button.props.title);
  const spawn = buttons.find((button) => collectVNodeText(button).includes("[SPAWN REVIEWER]"));
  runRow.props.onClick();
  spawn.props.onClick();
  assert.equal(calls[0][0], "run");
  assert.equal(calls[0][1].jobId, "job_123");
  assert.equal(calls[0][1].missing[0].id, "cmd.ok");
  assert.equal(calls[1][0], "reviewer");
  assert.equal(calls[1][1].session.id, "ses_1");
});

test("CompletionGatesPanel requires override reason before callback", () => {
  const calls = [];
  const vnode = CompletionGatesPanel({
    result: result(),
    jobId: "job_123",
    onValidationError: (message, payload) => calls.push(["invalid", message, payload]),
    onOverrideComplete: (payload) => calls.push(["override", payload]),
  });
  const form = nodesByClassName(vnode, "completion-gates-panel__override")[0];
  form.props.onSubmit({
    preventDefault() {},
    currentTarget: { elements: { namedItem: () => ({ value: "  " }) } },
  });
  assert.equal(calls[0][0], "invalid");
  assert.equal(calls[0][2].jobId, "job_123");

  form.props.onSubmit({
    preventDefault() {},
    currentTarget: { elements: { namedItem: () => ({ value: "operator accepted" }) } },
  });
  assert.equal(calls[1][0], "override");
  assert.equal(calls[1][1].reason, "operator accepted");
});
