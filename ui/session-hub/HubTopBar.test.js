import { test } from "node:test";
import assert from "node:assert/strict";

import { HubTopBarView } from "./HubTopBar.js";

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

test("HubTopBarView exposes top-nav new-session trigger", () => {
  let toggled = false;
  const vnode = HubTopBarView({
    onTogglePicker: () => {
      toggled = true;
    },
  });
  assert.match(collectVNodeText(vnode), /\[\+ NEW SESSION\]/);
  const button = flattenRenderedNodes(vnode).find((node) => node.props?.class === "hub-top-bar__new-session");
  assert.equal(button.props["aria-expanded"], "false");
  button.props.onClick();
  assert.equal(toggled, true);
});

test("HubTopBarView renders picker when open and forwards wizard intents", () => {
  let opened = null;
  const vnode = HubTopBarView({
    pickerOpen: true,
    selectedIndex: 0,
    onOpenWizard: (intent) => {
      opened = intent;
    },
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /Pick task/);
  assert.match(text, /Start untasked/);
  assert.match(text, /Attach existing/);
  const pickTask = flattenRenderedNodes(vnode).find((node) => node.props?.["data-option-id"] === "pick_task");
  pickTask.props.onClick();
  assert.deepEqual(opened, {
    source: "global_new_session",
    mode: "task_backed",
    optionId: "pick_task",
  });
});
