import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RolloverDialogView,
  buildRolloverLaunchPayload,
  rolloverPackSections,
  serializeRolloverPack,
} from "./RolloverDialog.js";

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
  return flattenRenderedNodes(vnode).filter((node) => {
    const cls = node?.props?.class;
    return typeof cls === "string" && cls.split(/\s+/).includes(className);
  });
}

function samplePack() {
  return {
    title: "Context rollover",
    sessionId: "ses_0123456789abcdefghjkmnpqr",
    jobId: "job_0123456789abcdefghjkmnpqr",
    projectSlug: "demo",
    taskId: "sh-8-06",
    sections: [
      { id: "rollover_trigger", title: "Rollover trigger", value: { id: "context_high" } },
      { id: "verify", title: "Verify", value: "node --test test/foo.test.js" },
    ],
  };
}

test("rolloverPackSections normalizes preview sections", () => {
  const sections = rolloverPackSections(samplePack());
  assert.equal(sections.length, 2);
  assert.equal(sections[0].id, "rollover_trigger");
  assert.equal(sections[1].title, "Verify");
});

test("serializeRolloverPack preserves editable string packs and formats objects", () => {
  assert.equal(serializeRolloverPack("plain pack"), "plain pack");
  assert.match(serializeRolloverPack({ a: 1 }), /"a": 1/);
});

test("buildRolloverLaunchPayload carries edited pack text and scope ids", () => {
  const payload = buildRolloverLaunchPayload({
    session: { id: "ses_live", projectSlug: "demo", taskId: "sh-8-06" },
    job: { id: "job_live" },
    pack: samplePack(),
    packText: "edited handoff",
    reason: "context pressure",
  });
  assert.equal(payload.sessionId, "ses_live");
  assert.equal(payload.jobId, "job_live");
  assert.equal(payload.projectSlug, "demo");
  assert.equal(payload.taskId, "sh-8-06");
  assert.equal(payload.packText, "edited handoff");
  assert.equal(payload.reason, "context pressure");
});

test("RolloverDialogView previews pack, supports inline edit, copy, and launch", () => {
  const calls = [];
  const vnode = RolloverDialogView({
    session: { id: "ses_live", projectSlug: "demo", taskId: "sh-8-06" },
    jobId: "job_live",
    pack: samplePack(),
    packText: "editable pack",
    reason: "ctx high",
    onPackTextChange: (value) => calls.push(["edit", value]),
    onReasonChange: (value) => calls.push(["reason", value]),
    onCopy: (value, payload) => calls.push(["copy", value, payload]),
    onLaunch: (payload) => calls.push(["launch", payload]),
  });

  const renderedText = collectVNodeText(vnode);
  assert.match(renderedText, /Context rollover/);
  assert.match(renderedText, /Rollover trigger/);
  assert.match(renderedText, /node --test test\/foo\.test\.js/);
  assert.match(renderedText, /\[COPY\]/);
  assert.match(renderedText, /\[LAUNCH SUCCESSOR\]/);

  const textarea = flattenRenderedNodes(vnode).find((node) => node.type === "textarea");
  textarea.props.onInput({ currentTarget: { value: "edited pack" } });
  assert.deepEqual(calls[0], ["edit", "edited pack"]);

  const reason = flattenRenderedNodes(vnode).find((node) => node.type === "input");
  reason.props.onInput({ currentTarget: { value: "manual rollover" } });
  assert.deepEqual(calls[1], ["reason", "manual rollover"]);

  const buttons = nodesByClassName(vnode, "icon-btn");
  const copy = buttons.find((button) => collectVNodeText(button).includes("[COPY]"));
  const launch = buttons.find((button) => collectVNodeText(button).includes("[LAUNCH SUCCESSOR]"));
  copy.props.onClick();
  launch.props.onClick();
  assert.equal(calls[2][0], "copy");
  assert.equal(calls[2][1], "editable pack");
  assert.equal(calls[3][0], "launch");
  assert.equal(calls[3][1].sessionId, "ses_live");
  assert.equal(calls[3][1].packText, "editable pack");
});

test("RolloverDialogView renders copied and launching states", () => {
  const vnode = RolloverDialogView({
    pack: samplePack(),
    packText: "pack",
    copied: true,
    saving: true,
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /\[COPIED\]/);
  assert.match(text, /\[LAUNCHING\]/);
  assert.match(text, /working/);
});
