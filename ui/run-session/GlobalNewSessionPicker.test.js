import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GLOBAL_NEW_SESSION_OPTIONS,
  GlobalNewSessionPicker,
  buildGlobalNewSessionIntent,
  nextGlobalNewSessionIndex,
} from "./GlobalNewSessionPicker.js";

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

test("global picker exposes the configured three options and wizard modes", () => {
  assert.deepEqual(GLOBAL_NEW_SESSION_OPTIONS.map((option) => option.label), [
    "Pick task",
    "Start untasked",
    "Attach existing",
  ]);
  assert.deepEqual(buildGlobalNewSessionIntent("pick_task"), {
    source: "global_new_session",
    mode: "task_backed",
    optionId: "pick_task",
  });
  assert.deepEqual(buildGlobalNewSessionIntent("start_untasked").mode, "untasked");
  assert.deepEqual(buildGlobalNewSessionIntent("attach_existing").mode, "attach_existing");
});

test("global picker keyboard navigation supports 1/2/3 and arrows", () => {
  assert.equal(nextGlobalNewSessionIndex(0, "2"), 1);
  assert.equal(nextGlobalNewSessionIndex(0, "3"), 2);
  assert.equal(nextGlobalNewSessionIndex(2, "ArrowDown"), 0);
  assert.equal(nextGlobalNewSessionIndex(0, "ArrowUp"), 2);
});

test("GlobalNewSessionPicker opens selected option on enter", () => {
  let selected = null;
  let opened = null;
  const vnode = GlobalNewSessionPicker({
    selectedIndex: 1,
    onSelectIndex: (index) => {
      selected = index;
    },
    onOpenWizard: (intent) => {
      opened = intent;
    },
  });
  const root = flattenRenderedNodes(vnode)[0];
  root.props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
  assert.equal(selected, 2);
  root.props.onKeyDown({ key: "Enter", preventDefault() {} });
  assert.deepEqual(opened, {
    source: "global_new_session",
    mode: "untasked",
    optionId: "start_untasked",
  });
});

test("GlobalNewSessionPicker buttons open matching wizard intents", () => {
  let opened = null;
  const vnode = GlobalNewSessionPicker({
    onOpenWizard: (intent) => {
      opened = intent;
    },
  });
  const attach = flattenRenderedNodes(vnode).find((node) => node.props?.["data-option-id"] === "attach_existing");
  assert.equal(attach.props["data-mode"], "attach_existing");
  attach.props.onClick();
  assert.deepEqual(opened, {
    source: "global_new_session",
    mode: "attach_existing",
    optionId: "attach_existing",
  });
});
