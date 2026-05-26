import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CapabilityPreview,
  capabilityPreviewRows,
  normalizeProviderCapabilities,
  runtimeLabelFor,
} from "./CapabilityPreview.js";

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

function renderedRows(vnode) {
  return flattenRenderedNodes(vnode)
    .filter((node) => node.type === "li")
    .map((item) => ({
      id: item.props["data-capability"],
      supported: item.props["data-supported"],
      text: collectVNodeText(item).replace(/\s+/g, " ").trim(),
    }));
}

function caps(overrides = {}) {
  return {
    structuredThread: false,
    structuredTurns: false,
    structuredItems: false,
    structuredApprovals: false,
    structuredFileChanges: false,
    structuredCommandEvents: false,
    structuredContextUsage: false,
    providerTimeline: false,
    providerDiffs: false,
    providerReview: false,
    modelList: false,
    skillList: false,
    threadResume: false,
    threadFork: false,
    turnSteer: false,
    turnInterrupt: false,
    rawStdio: false,
    stdinWrite: false,
    processLifecycle: false,
    directContextInjection: false,
    ...overrides,
  };
}

test("normalizeProviderCapabilities coerces missing flags to false booleans", () => {
  const normalized = normalizeProviderCapabilities({ structuredTurns: true });
  assert.equal(normalized.structuredTurns, true);
  assert.equal(normalized.rawStdio, false);
  assert.equal(normalized.threadFork, false);
});

test("capabilityPreviewRows matches the Codex app-server addendum layout", () => {
  const rows = capabilityPreviewRows({
    runtime: "codex_app_server",
    capabilityPreview: caps({
      structuredTurns: true,
      structuredApprovals: true,
      providerTimeline: true,
      structuredFileChanges: true,
      structuredContextUsage: true,
      threadResume: true,
      threadFork: true,
      providerReview: true,
      directContextInjection: true,
    }),
  });

  assert.deepEqual(
    rows.map((row) => `${row.marker} ${row.label}`),
    [
      "✓ structured chat",
      "✓ structured approvals",
      "✓ provider timeline",
      "✓ provider file changes",
      "✓ context usage",
      "✓ thread resume/fork",
      "✓ provider review",
      "✓ direct context injection",
    ],
  );
});

test("CapabilityPreview renders the Codex app-server addendum layout", () => {
  const vnode = CapabilityPreview({
    runtimeLabel: "Codex app-server",
    capabilities: caps({
      structuredTurns: true,
      structuredApprovals: true,
      providerTimeline: true,
      structuredFileChanges: true,
      structuredContextUsage: true,
      threadResume: true,
      threadFork: true,
      providerReview: true,
      directContextInjection: true,
    }),
  });

  assert.match(collectVNodeText(vnode), /Runtime:\s*Codex app-server/);
  assert.deepEqual(
    renderedRows(vnode).map((row) => row.text),
    [
      "✓ structured chat",
      "✓ structured approvals",
      "✓ provider timeline",
      "✓ provider file changes",
      "✓ context usage",
      "✓ thread resume/fork",
      "✓ provider review",
      "✓ direct context injection",
    ],
  );
});

test("CapabilityPreview renders the generic terminal addendum layout", () => {
  const vnode = CapabilityPreview({
    draft: {
      runtime: "dumb_terminal",
      providerId: "generic_pty",
      capabilityPreview: caps({
        rawStdio: true,
        stdinWrite: true,
        processLifecycle: true,
      }),
    },
  });

  assert.match(collectVNodeText(vnode), /Runtime:\s*Generic terminal/);
  assert.deepEqual(
    renderedRows(vnode).map((row) => row.text),
    [
      "✓ raw stdio",
      "✓ stdin",
      "✓ stop/restart",
      "○ structured approvals unavailable",
      "○ context usage unavailable unless reported via MCP",
      "○ provider file changes unavailable; git diff still available",
    ],
  );
});

test("CapabilityPreview exposes stable row state for supported and unavailable flags", () => {
  const vnode = CapabilityPreview({
    runtime: "codex_app_server",
    capabilityPreview: caps({
      structuredTurns: true,
      structuredApprovals: true,
      providerTimeline: true,
      structuredFileChanges: true,
      structuredContextUsage: true,
      threadResume: true,
      threadFork: false,
      providerReview: true,
      directContextInjection: true,
    }),
  });
  const rows = renderedRows(vnode);

  assert.equal(rows.length, 8);
  assert.deepEqual(
    rows.map((row) => [row.id, row.supported]),
    [
      ["structured-chat", "true"],
      ["structured-approvals", "true"],
      ["provider-timeline", "true"],
      ["provider-file-changes", "true"],
      ["context-usage", "true"],
      ["thread-resume-fork", "false"],
      ["provider-review", "true"],
      ["direct-context-injection", "true"],
    ],
  );
  assert.match(collectVNodeText(vnode), /○\s*thread resume\/fork unavailable/);
});

test("runtimeLabelFor prefers explicit runtime label and handles Codex provider id", () => {
  assert.equal(runtimeLabelFor({ runtimeLabel: "Local shell" }), "Local shell");
  assert.equal(runtimeLabelFor({ providerId: "codex_app_server" }), "Codex app-server");
});
