import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STDIO_OFFSCREEN_RENDER_MS,
  STDIO_VISIBLE_RENDER_MS,
  StdioPanelView,
  filterStdioEntries,
  normalizeStdioEntries,
  stdioCopyText,
  stdioRenderThrottleMs,
} from "./StdioPanel.js";

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

function nodesByClassName(vnode, className) {
  return flattenRenderedNodes(vnode).filter((node) => {
    const cls = node?.props?.class;
    return typeof cls === "string" && cls.split(/\s+/).includes(className);
  });
}

test("normalizeStdioEntries accepts session.output events, chunks, and command stdout/stderr", () => {
  const entries = normalizeStdioEntries([
    { id: "evt_stdout", type: "session.output", stream: "stdout", text: "ok\n", ts: "2026-05-29T00:00:00.000Z" },
    { id: "evt_stderr", type: "session.output", stream: "stderr", text: "warn\n" },
    { id: "cmd_1", stdout: "done\n", stderr: "failed\n" },
    "loose chunk\n",
  ]);

  assert.deepEqual(entries.map((entry) => [entry.id, entry.stream, entry.text]), [
    ["evt_stdout:stdout:0", "stdout", "ok\n"],
    ["evt_stderr:stderr:1", "stderr", "warn\n"],
    ["cmd_1:stdout:2", "stdout", "done\n"],
    ["cmd_1:stderr:3", "stderr", "failed\n"],
    ["stdio-3-4", "stdout", "loose chunk\n"],
  ]);
});

test("filterStdioEntries searches text and stream without mutating entries", () => {
  const entries = normalizeStdioEntries([
    { stream: "stdout", text: "install complete\n" },
    { stream: "stderr", text: "warning: retry\n" },
  ]);

  assert.deepEqual(filterStdioEntries(entries, "WARN").map((entry) => entry.text), ["warning: retry\n"]);
  assert.deepEqual(filterStdioEntries(entries, "stderr").map((entry) => entry.stream), ["stderr"]);
  assert.equal(filterStdioEntries(entries, "").length, entries.length);
});

test("stdioRenderThrottleMs returns 30fps visible and 5fps off-screen cadence", () => {
  assert.equal(stdioRenderThrottleMs({ visible: true }), STDIO_VISIBLE_RENDER_MS);
  assert.equal(stdioRenderThrottleMs({ visible: false }), STDIO_OFFSCREEN_RENDER_MS);
  assert.ok(STDIO_VISIBLE_RENDER_MS <= 34);
  assert.equal(STDIO_OFFSCREEN_RENDER_MS, 200);
});

test("StdioPanelView exposes follow, pause, search, and copy controls", () => {
  const calls = [];
  const vnode = StdioPanelView({
    entries: [
      { stream: "stdout", text: "install complete\n" },
      { stream: "stderr", text: "warning\n" },
    ],
    visible: false,
    follow: true,
    paused: false,
    query: "warning",
    onToggleFollow: (value) => calls.push(["follow", value]),
    onTogglePause: (value) => calls.push(["pause", value]),
    onSearch: (value) => calls.push(["search", value]),
    onCopy: (value) => calls.push(["copy", value]),
  });

  assert.equal(vnode.props["data-render-throttle-ms"], STDIO_OFFSCREEN_RENDER_MS);
  assert.match(collectVNodeText(vnode), /warning/);
  assert.doesNotMatch(collectVNodeText(vnode), /install complete/);

  const follow = nodesByClassName(vnode, "stdio-panel__toggle")[0];
  const pause = nodesByClassName(vnode, "stdio-panel__toggle")[1];
  const search = nodesByClassName(vnode, "stdio-panel__search")[0];
  const copy = nodesByClassName(vnode, "stdio-panel__copy")[0];
  follow.props.onClick();
  pause.props.onClick();
  search.props.onInput({ currentTarget: { value: "done" } });
  copy.props.onClick();

  assert.deepEqual(calls, [
    ["follow", false],
    ["pause", true],
    ["search", "done"],
    ["copy", "warning\n"],
  ]);
});

test("paused StdioPanelView still searches the frozen entries", () => {
  const vnode = StdioPanelView({
    entries: [
      { stream: "stdout", text: "visible before pause\n" },
      { stream: "stderr", text: "error before pause\n" },
    ],
    paused: true,
    query: "error",
  });

  assert.doesNotMatch(collectVNodeText(vnode), /visible before pause/);
  assert.match(collectVNodeText(vnode), /error before pause/);
  assert.equal(stdioCopyText(normalizeStdioEntries([{ text: "a\n" }, { text: "b\n" }])), "a\nb\n");
});
