import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SessionCard,
  WORKTREE_ARCHIVE_CONFIRMATION,
  WORKTREE_CREATE_DISABLED_REASON,
  WORKTREE_DELETE_CONFIRMATION,
  formatSessionWorktreePath,
} from "./SessionCard.js";

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

test("SessionCard large size shows last three timeline items beneath status", () => {
  const vnode = SessionCard({
    size: "large",
    session: {
      id: "ses_timeline",
      status: "active",
      timelineItems: [
        { id: "evt_1", kind: "message", title: "Prompt received", ts: "2026-05-29T10:00:00.000Z" },
        { id: "evt_2", kind: "command", title: "Ran tests", evidenceRef: "cmd_1" },
        { id: "evt_3", kind: "file_change", title: "Edited SessionCard", evidenceRef: "fs_2" },
        { id: "evt_4", kind: "verify", title: "Verify passed", evidenceRef: "verify_3" },
      ],
    },
  });

  const rows = nodesByClassName(vnode, "session-card__timeline-preview-item");
  assert.equal(rows.length, 3);
  const rendered = flattenRenderedNodes(vnode);
  assert.ok(
    rendered.findIndex((node) => node?.props?.class === "session-card__meta") <
      rendered.findIndex((node) => node?.props?.class === "session-card__timeline-preview"),
    "timeline preview renders beneath status metadata"
  );
  const text = collectVNodeText(vnode);
  assert.doesNotMatch(text, /Prompt received/);
  assert.match(text, /Ran tests/);
  assert.match(text, /Edited SessionCard/);
  assert.match(text, /Verify passed/);

  const evidence = nodesByClassName(vnode, "session-card__timeline-preview-evidence");
  assert.equal(evidence.length, 3);
  assert.equal(evidence[0].props.href, "#runtime-event-cmd_1");
});

test("SessionCard hides timeline preview for normal and compact cards", () => {
  const session = {
    id: "ses_timeline",
    status: "active",
    timelineItems: [{ id: "evt_1", kind: "verify", title: "Verify passed" }],
  };

  assert.equal(nodesByClassName(SessionCard({ size: "normal", session }), "session-card__timeline-preview-item").length, 0);
  assert.equal(nodesByClassName(SessionCard({ size: "compact", session }), "session-card__timeline-preview-item").length, 0);
});

test("SessionCard ignores missing or malformed timeline preview data", () => {
  assert.equal(
    nodesByClassName(
      SessionCard({ size: "large", session: { id: "ses_empty", timelineItems: null } }),
      "session-card__timeline-preview-item"
    ).length,
    0
  );

  const vnode = SessionCard({
    size: "large",
    session: {
      id: "ses_malformed",
      timelineItems: [
        null,
        false,
        "not an item",
        { id: "evt_ok", title: "Renderable event" },
      ],
    },
  });

  assert.equal(nodesByClassName(vnode, "session-card__timeline-preview-item").length, 1);
  assert.match(collectVNodeText(vnode), /Renderable event/);
});

test("SessionCard exposes worktree actions with default naming pattern", () => {
  const calls = [];
  const session = {
    id: "ses_worktree",
    name: "Implement Worktree UI",
    status: "active",
    projectSlug: "demo-project",
    taskId: "sh-7b-05",
    repoRoot: "/repo",
    worktreePath: "/repo",
    warnings: [{ kind: "shared_worktree", message: "Two sessions share this worktree" }],
  };
  const vnode = SessionCard({
    session,
    onCreateWorktree: (payload) => calls.push(["create", payload]),
    onBindWorktree: (payload) => calls.push(["bind", payload]),
    onAcknowledgeSharedWorktree: (payload) => calls.push(["ack", payload]),
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /\[CREATE WORKTREE\]/);
  assert.match(text, /\[BIND WORKTREE\]/);
  assert.match(text, /\[ACKNOWLEDGE SHARED WORKTREE\]/);

  const actions = nodesByClassName(vnode, "session-card__worktree-action");
  assert.equal(actions.length, 3);
  assert.equal(actions[0].props.disabled, false);
  assert.equal(actions[0].props.title, "demo-project/sh-7b-05-implement-worktree-ui");
  actions[0].props.onClick();
  actions[1].props.onClick();
  actions[2].props.onClick();

  assert.equal(calls[0][0], "create");
  assert.deepEqual(calls[0][1], {
    sessionId: "ses_worktree",
    projectSlug: "demo-project",
    taskId: "sh-7b-05",
    worktreePath: "demo-project/sh-7b-05-implement-worktree-ui",
    namingPattern: "{projectSlug}/{taskId}-{shortTitle}",
    oneClickAutoCreate: true,
  });
  assert.deepEqual(calls[1], ["bind", {
    sessionId: "ses_worktree",
    repoRoot: "/repo",
    worktreePath: "/repo",
  }]);
  assert.deepEqual(calls[2], ["ack", {
    sessionId: "ses_worktree",
    worktreePath: "/repo",
  }]);
});

test("SessionCard labels unknown repo sessions with set repo/worktree action", () => {
  let payload = null;
  const vnode = SessionCard({
    session: {
      id: "ses_unbound_repo",
      name: "Needs repo",
      status: "active",
      projectSlug: "demo",
      taskId: "sh-2-22",
      worktreePath: "/repo-wt",
    },
    onSetRepoWorktree: (next) => {
      payload = next;
    },
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /repo unknown/);
  assert.match(text, /\[SET REPO\/WORKTREE\]/);
  assert.doesNotMatch(text, /\[BIND WORKTREE\]/);

  const action = nodesByClassName(vnode, "session-card__worktree-action")
    .find((node) => collectVNodeText(node) === "[SET REPO/WORKTREE]");
  assert.equal(action.props.disabled, false);
  action.props.onClick();
  assert.deepEqual(payload, {
    sessionId: "ses_unbound_repo",
    repoRoot: null,
    worktreePath: "/repo-wt",
  });
});

test("SessionCard gates create worktree on trusted local mode flag", () => {
  let called = false;
  const vnode = SessionCard({
    session: {
      id: "ses_no_create",
      name: "No create",
      projectSlug: "demo",
      taskId: "t-1",
      status: "active",
    },
    trustedLocalMode: { allowWorktreeCreationFromUI: false },
    onCreateWorktree: () => { called = true; },
  });

  const actions = nodesByClassName(vnode, "session-card__worktree-action");
  assert.equal(actions[0].props.disabled, true);
  assert.equal(actions[0].props.title, WORKTREE_CREATE_DISABLED_REASON);
  actions[0].props.onClick();
  assert.equal(called, false);
});

test("SessionCard requires both worktree flags for one-click auto-create", () => {
  let payload = null;
  const vnode = SessionCard({
    session: {
      id: "ses_confirm",
      name: "Needs confirmation",
      projectSlug: "demo",
      taskId: "t-2",
      status: "active",
    },
    trustedLocalMode: { allowWorktreeCreationFromUI: true },
    worktrees: { allowTrustedAutoCreateOnLaunch: false },
    onCreateWorktree: (next) => { payload = next; },
  });

  const actionGroup = nodesByClassName(vnode, "session-card__worktree-actions")[0];
  assert.equal(actionGroup.props["data-auto-create"], "false");
  nodesByClassName(vnode, "session-card__worktree-action")[0].props.onClick();
  assert.equal(payload.oneClickAutoCreate, false);
});

test("formatSessionWorktreePath honors custom naming pattern", () => {
  assert.equal(
    formatSessionWorktreePath({
      session: { id: "ses_abc", projectSlug: "LLM Tracker", name: "Build UI" },
      task: { taskId: "SH-7B-05", title: "Worktree UI Actions" },
      pattern: "{sessionId}/{projectSlug}/{taskId}/{shortTitle}",
    }),
    "ses-abc/llm-tracker/sh-7b-05/worktree-ui-actions",
  );
});

test("SessionCard offers archive and delete only after closeout with confirmation", () => {
  const calls = [];
  const confirmations = [];
  const session = {
    id: "ses_done",
    status: "done",
    projectSlug: "demo",
    taskId: "sh-7b-06",
    activeJobId: "job_1",
    worktreeId: "wt_1",
    worktreePath: "/repo/.worktrees/sh-7b-06",
  };
  const vnode = SessionCard({
    session,
    confirmWorktreeArchive: (message, details) => {
      confirmations.push({ message, payload: details.payload });
      return true;
    },
    onArchiveWorktree: (payload) => calls.push(["archive", payload]),
    onDeleteWorktree: (payload) => calls.push(["delete", payload]),
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /\[ARCHIVE WORKTREE\]/);
  assert.match(text, /\[DELETE WORKTREE\]/);

  const actions = nodesByClassName(vnode, "session-card__worktree-action");
  const archive = actions.find((node) => collectVNodeText(node) === "[ARCHIVE WORKTREE]");
  const remove = actions.find((node) => collectVNodeText(node) === "[DELETE WORKTREE]");
  archive.props.onClick();
  remove.props.onClick();

  assert.equal(confirmations.length, 2);
  assert.deepEqual(calls[0], ["archive", {
    sessionId: "ses_done",
    jobId: "job_1",
    projectSlug: "demo",
    taskId: "sh-7b-06",
    worktreeId: "wt_1",
    worktreePath: "/repo/.worktrees/sh-7b-06",
    reason: "session closeout",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    deleteFromDisk: false,
  }]);
  assert.deepEqual(calls[1], ["delete", {
    sessionId: "ses_done",
    jobId: "job_1",
    projectSlug: "demo",
    taskId: "sh-7b-06",
    worktreeId: "wt_1",
    worktreePath: "/repo/.worktrees/sh-7b-06",
    reason: "session closeout",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    deleteFromDisk: true,
    deleteConfirmation: WORKTREE_DELETE_CONFIRMATION,
  }]);
});

test("SessionCard never runs worktree archive/delete without closeout or confirmation", () => {
  let called = false;
  const active = SessionCard({
    session: {
      id: "ses_active",
      status: "active",
      worktreePath: "/repo/.worktrees/active",
    },
    confirmWorktreeArchive: () => true,
    onArchiveWorktree: () => { called = true; },
    onDeleteWorktree: () => { called = true; },
  });
  assert.doesNotMatch(collectVNodeText(active), /\[ARCHIVE WORKTREE\]/);
  assert.doesNotMatch(collectVNodeText(active), /\[DELETE WORKTREE\]/);

  const done = SessionCard({
    session: {
      id: "ses_done_cancel",
      status: "done",
      worktreePath: "/repo/.worktrees/done",
    },
    confirmWorktreeArchive: () => false,
    onArchiveWorktree: () => { called = true; },
    onDeleteWorktree: () => { called = true; },
  });
  const actions = nodesByClassName(done, "session-card__worktree-action");
  actions.find((node) => collectVNodeText(node) === "[ARCHIVE WORKTREE]").props.onClick();
  actions.find((node) => collectVNodeText(node) === "[DELETE WORKTREE]").props.onClick();
  assert.equal(called, false);
});
