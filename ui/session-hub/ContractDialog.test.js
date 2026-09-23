import { test } from "node:test";
import assert from "node:assert/strict";

import { renderMcpSessionContract } from "../../hub/cli/session-contract.js";
import {
  ContractDialog,
  ContractDialogView,
  mcpSessionContractText,
} from "./ContractDialog.js";

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

test("mcpSessionContractText matches the CLI renderer and fills concrete ids", () => {
  const args = { sessionId: "ses_abc", jobId: "job_abc" };
  const text = mcpSessionContractText(args);
  assert.equal(text, renderMcpSessionContract(args));
  assert.match(text, /llm-tracker session ses_abc and job job_abc/);
  assert.match(text, /tracker_session_heartbeat every 5 minutes/);
  assert.match(text, /tracker_job_checkpoint after meaningful progress/);
  assert.match(text, /tracker_session_handoff before stopping or rolling over/);
  assert.match(text, /Do not mark complete until verify gates are satisfied/);
});

test("ContractDialogView renders the pasteable MCP contract", () => {
  let copied = "";
  const vnode = ContractDialogView({
    sessionId: "ses_abc",
    jobId: "job_abc",
    onCopy: (text) => {
      copied = text;
    },
  });
  assert.match(collectVNodeText(vnode), /tracker_session_blocked when blocked/);
  const copyButton = flattenRenderedNodes(vnode).find((node) => {
    return node.type === "button" && collectVNodeText(node).includes("[COPY]");
  });
  assert.ok(copyButton);
  copyButton.props.onClick();
  assert.match(copied, /llm-tracker session ses_abc and job job_abc/);
});

test("ContractDialog returns null when closed", () => {
  assert.equal(ContractDialog({ open: false }), null);
});
