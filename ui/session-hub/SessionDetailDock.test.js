import { test } from "node:test";
import assert from "node:assert/strict";

import { SESSION_DETAIL_TABS, SessionDetailDockView } from "./SessionDetailDock.js";
import { STDIO_VISIBLE_RENDER_MS } from "./StdioPanel.js";

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

test("SessionDetailDockView places Timeline tab per addendum ordering", () => {
  const vnode = SessionDetailDockView({
    session: { id: "ses_tabs", status: "active" },
  });
  const tabs = nodesByClassName(vnode, "session-detail-dock__tab");
  assert.deepEqual(tabs.map((tab) => collectVNodeText(tab).trim()), [
    "Summary",
    "Timeline",
    "Stdio raw",
    "Chat",
    "Diff/Evidence",
    "Context",
    "Skills",
    "Events",
  ]);
  assert.deepEqual(SESSION_DETAIL_TABS, [
    "summary",
    "timeline",
    "stdio",
    "chat",
    "diff",
    "context",
    "skills",
    "events",
  ]);
  assert.equal(tabs[1].props["aria-selected"], "true");
});

test("SessionDetailDockView hosts timeline rows in the selected Timeline tab", () => {
  const vnode = SessionDetailDockView({
    session: { id: "ses_timeline", status: "active" },
    activeTab: "timeline",
    timelineItems: [
      {
        id: "tl_1",
        kind: "verify",
        title: "Verify passed",
        detail: "node --test",
        source: "mcp",
        confidence: "structured",
        evidenceRef: "evt_verify",
      },
    ],
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /\[V\]/);
  assert.match(text, /Verify passed/);
  assert.match(text, /node --test/);
  assert.match(text, /mcp/);
  assert.match(text, /structured/);
  assert.match(text, /evt_verify/);
});

test("SessionDetailDockView hosts stdio drawer controls for a selected session", () => {
  const vnode = SessionDetailDockView({
    session: {
      id: "ses_detail",
      name: "Detail session",
      status: "active",
      tier: "dumb_terminal",
      repoRoot: "/repo",
      activeJobId: "job_active",
    },
    stdioEntries: [
      { id: "evt_1", stream: "stdout", text: "ready\n" },
      { id: "evt_2", stream: "stderr", text: "warn\n" },
    ],
    activeTab: "stdio",
    query: "ready",
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /Detail session/);
  assert.match(text, /job_active/);
  assert.match(text, /Follow/);
  assert.match(text, /Pause/);
  assert.match(text, /Copy/);
  assert.match(text, /ready/);
  assert.doesNotMatch(text, /warn/);

  const stdioPanel = nodesByClassName(vnode, "stdio-panel")[0];
  assert.equal(stdioPanel.props["data-render-throttle-ms"], STDIO_VISIBLE_RENDER_MS);
});

test("SessionDetailDockView hosts a real chat send composer", async () => {
  let sent = null;
  let draft = "hello";
  const vnode = SessionDetailDockView({
    session: {
      id: "ses_chat",
      name: "Chat session",
      status: "active",
      provider: "terminal",
      providerThread: { threadId: "pty_1" },
      providerCapabilities: { stdinWrite: true },
      messages: [{ id: "m1", role: "assistant", text: "ready" }],
    },
    activeTab: "chat",
    chatDraft: draft,
    onDraftChange: (value) => {
      draft = value;
    },
    onSend: (result) => {
      sent = result;
    },
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /ready/);
  assert.match(text, /SEND/);
  const buttons = flattenRenderedNodes(vnode).filter((node) => node.type === "button");
  const send = buttons.find((button) => collectVNodeText(button).includes("SEND"));
  assert.equal(send.props.disabled, false);
});

test("SessionDetailDockView exposes force kill only through detail dock callback", () => {
  let payload = null;
  const vnode = SessionDetailDockView({
    session: { id: "ses_force", status: "active" },
    onForceKill: (next) => {
      payload = next;
    },
  });

  const button = nodesByClassName(vnode, "session-detail-dock__force-kill")[0];
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(payload.sessionId, "ses_force");
  assert.equal(payload.force, true);
});

test("SessionDetailDockView exposes set repo/worktree for repo-unknown sessions", () => {
  let payload = null;
  const vnode = SessionDetailDockView({
    session: { id: "ses_repo_unknown", status: "active", worktreePath: "/repo-wt" },
    activeTab: "summary",
    onSetRepoWorktree: (next) => {
      payload = next;
    },
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /repo unknown/);
  assert.match(text, /\[SET REPO\/WORKTREE\]/);
  const button = nodesByClassName(vnode, "session-detail-dock__set-repo-worktree")[0];
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(payload.sessionId, "ses_repo_unknown");
  assert.equal(payload.repoRoot, null);
  assert.equal(payload.worktreePath, "/repo-wt");
});

test("SessionDetailDockView hides set repo/worktree once repo is known", () => {
  const vnode = SessionDetailDockView({
    session: { id: "ses_repo_known", status: "active", repoRoot: "/repo", worktreePath: "/repo" },
    onSetRepoWorktree: () => {},
  });
  assert.equal(nodesByClassName(vnode, "session-detail-dock__set-repo-worktree").length, 0);
});

test("SessionDetailDockView disables force kill when no handler is supplied", () => {
  const vnode = SessionDetailDockView({
    session: { id: "ses_no_force", status: "active" },
  });
  const button = nodesByClassName(vnode, "session-detail-dock__force-kill")[0];
  assert.equal(button.props.disabled, true);
});
