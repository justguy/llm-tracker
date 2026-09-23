import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RunSessionButton,
  buildRunSessionPickerIntent,
} from "./RunSessionButton.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

test("buildRunSessionPickerIntent scopes the picker to workspace-local projects", () => {
  assert.deepEqual(
    buildRunSessionPickerIntent({
      projects: [{ slug: "alpha" }, { projectSlug: "beta" }, { id: "gamma" }, {}],
      topN: 7,
    }),
    {
      source: "hub_run_button",
      scope: "workspace-local",
      projectSlugs: ["alpha", "beta", "gamma"],
      topN: 7,
    },
  );
});

test("RunSessionButton opens the cross-project picker intent", () => {
  let opened = null;
  const vnode = RunSessionButton({
    projects: [{ slug: "alpha" }],
    topN: 5,
    onOpenPicker: (intent) => {
      opened = intent;
    },
  });

  assert.equal(collectVNodeText(vnode).trim(), "[+ RUN]");
  assert.equal(vnode.props["data-scope"], "workspace-local");
  vnode.props.onClick();
  assert.equal(opened.scope, "workspace-local");
  assert.deepEqual(opened.projectSlugs, ["alpha"]);
});

test("RunSessionButton does not open picker while disabled", () => {
  let opened = false;
  const vnode = RunSessionButton({
    disabled: true,
    onOpenPicker: () => {
      opened = true;
    },
  });
  assert.equal(vnode.props.disabled, true);
  vnode.props.onClick();
  assert.equal(opened, false);
});
