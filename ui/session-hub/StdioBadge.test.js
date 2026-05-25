import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STDIO_SECRETS_CAVEAT_HREF,
  StdioBadge,
  resolveStdioMode,
} from "./StdioBadge.js";
import { SessionCard } from "./SessionCard.js";

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

function nodesByClassContains(vnode, substring) {
  return flattenRenderedNodes(vnode).filter((n) => {
    const cls = n?.props?.class;
    return typeof cls === "string" && cls.includes(substring);
  });
}

function countStdioLabels(text) {
  return ["STDIO LIVE", "STDIO CAPTURED", "STDIO OFF"].filter((label) => text.includes(label)).length;
}

test("resolveStdioMode returns LIVE when raw stdio exists and disk capture is off", () => {
  assert.deepEqual(
    resolveStdioMode({
      id: "ses_live",
      tier: "dumb_terminal",
      stdioCapture: { enabled: false },
    }),
    {
      mode: "live",
      label: "STDIO LIVE",
      title: "Raw stdio is available in the in-memory ring only; nothing is written to disk.",
    },
  );
  assert.equal(
    resolveStdioMode({
      id: "ses_live_override",
      tier: "manual",
      providerCapabilities: { rawStdio: true },
    }).label,
    "STDIO LIVE",
  );
});

test("resolveStdioMode returns CAPTURED with secrets caveat link when disk capture is on", () => {
  const mode = resolveStdioMode({
    id: "ses_captured",
    tier: "hybrid",
    stdioCapture: { enabled: true },
  });
  assert.equal(mode.mode, "captured");
  assert.equal(mode.label, "STDIO CAPTURED");
  assert.equal(mode.href, STDIO_SECRETS_CAVEAT_HREF);
  assert.match(mode.href, /^https:\/\/github\.com\/justguy\/llm-tracker\/blob\/main\/docs\/session-hub\/capture-and-secrets\.md#secrets-caveat$/);
  assert.match(mode.title, /secrets caveat/i);
});

test("resolveStdioMode returns OFF when provider exposes no raw stdio", () => {
  assert.equal(resolveStdioMode({ id: "ses_manual", tier: "manual" }).label, "STDIO OFF");
  assert.equal(
    resolveStdioMode({
      id: "ses_structured",
      tier: "codex_app_server",
      providerCapabilities: { rawStdio: false },
    }).label,
    "STDIO OFF",
  );
  assert.equal(
    resolveStdioMode({
      id: "ses_hybrid_explicit_off",
      tier: "hybrid",
      providerCapabilities: { rawStdio: false },
    }).label,
    "STDIO OFF",
  );
  assert.equal(
    resolveStdioMode({
      id: "ses_dumb_terminal_explicit_off",
      tier: "dumb_terminal",
      capabilities: { rawStdio: false },
    }).label,
    "STDIO OFF",
  );
});

test("StdioBadge renders exactly one stdio label and captured mode is a link", () => {
  const live = StdioBadge({ session: { tier: "dumb_terminal" } });
  assert.equal(countStdioLabels(collectVNodeText(live)), 1);
  assert.equal(live.type, "span");

  const captured = StdioBadge({ session: { tier: "dumb_terminal", stdioCapture: { enabled: true } } });
  assert.equal(countStdioLabels(collectVNodeText(captured)), 1);
  assert.equal(captured.type, "a");
  assert.equal(captured.props.href, STDIO_SECRETS_CAVEAT_HREF);

  const off = StdioBadge({ session: { tier: "manual" } });
  assert.equal(countStdioLabels(collectVNodeText(off)), 1);
  assert.equal(off.type, "span");
});

test("SessionCard includes exactly one StdioBadge for each mode", () => {
  for (const session of [
    { id: "ses_live", name: "Live", tier: "dumb_terminal" },
    { id: "ses_captured", name: "Captured", tier: "hybrid", stdioCapture: { enabled: true } },
    { id: "ses_off", name: "Off", tier: "manual" },
  ]) {
    const vnode = SessionCard({ session });
    const badges = nodesByClassContains(vnode, "session-stdio-badge");
    assert.equal(badges.length, 1, `${session.id} should render exactly one stdio badge`);
    assert.equal(countStdioLabels(collectVNodeText(vnode)), 1);
  }
});
