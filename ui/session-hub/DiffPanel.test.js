import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIFF_PANEL_TABS,
  DiffPanelView,
  buildDiffPanelUrl,
  createDiffReviewerDraft,
  diffPanelTabCounts,
  loadSessionDiff,
  markDiffCloseoutPending,
  normalizeDiffPanelTab,
  runDiffVerify,
} from "./DiffPanel.js";

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
  return flattenRenderedNodes(vnode).filter((n) => {
    const cls = n?.props?.class;
    return typeof cls === "string" && cls.split(/\s+/).includes(className);
  });
}

function review() {
  return {
    projectSlug: "demo",
    taskId: "task-1",
    jobId: "job_1",
    sessionId: "ses_1",
    baseRev: 2,
    currentRev: 5,
    files: [{ path: "src/app.js", status: "M", additions: 2, deletions: 1 }],
    tabs: {
      changedSince: {
        since: {
          events: [
            { rev: 3, summary: [{ kind: "status", id: "task-1" }] },
            { rev: 4, summary: [{ kind: "edit", key: "context" }] },
          ],
        },
        changed: {
          changed: [
            {
              id: "task-1",
              title: "Diff task",
              status: "in_progress",
              changedKeys: ["status"],
              lastChangedRev: 4,
            },
          ],
        },
      },
      providerProposals: {
        items: [{ providerId: "codex", path: "src/app.js", evidenceRef: "evt_provider" }],
        unmatchedItems: [{ providerId: "codex", proposalId: "proposal-2" }],
      },
      gitDiff: {
        commands: {
          patch: {
            ok: true,
            stdout: "diff --git a/src/app.js b/src/app.js",
            stdoutTruncated: true,
          },
        },
      },
      allowedPaths: {
        warnings: ["src/app.js"],
        details: [{ id: "allowed-1", path: "src/app.js", reason: "outside task scope" }],
      },
      conflicts: {
        conflictIds: ["conflict-1"],
        details: [{ conflictId: "conflict-1", path: "src/app.js", evidenceRef: "evt_conflict" }],
      },
      reviewerNotes: {
        status: "open",
        notes: [{ author: "reviewer", body: "Check test coverage" }],
      },
    },
  };
}

test("buildDiffPanelUrl targets the session diff endpoint and validates baseRev", () => {
  assert.equal(buildDiffPanelUrl("ses_a/b", { baseRev: "3" }), "/api/sessions/ses_a%2Fb/diff?baseRev=3");
  assert.equal(buildDiffPanelUrl("ses_a"), "/api/sessions/ses_a/diff");
  assert.throws(() => buildDiffPanelUrl("ses_a", { baseRev: "-1" }), /baseRev/);
});

test("loadSessionDiff returns the DiffReview body and reports API errors", async () => {
  const calls = [];
  const diffReview = review();
  const loaded = await loadSessionDiff({
    sessionId: "ses_a",
    baseRev: 2,
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ ok: true, diffReview });
    },
  });
  assert.equal(calls[0][0], "/api/sessions/ses_a/diff?baseRev=2");
  assert.equal(calls[0][1].method, "GET");
  assert.equal(loaded, diffReview);

  await assert.rejects(
    () => loadSessionDiff({
      sessionId: "ses_a",
      fetchImpl: async () => jsonResponse({ error: { message: "missing" } }, { ok: false }),
    }),
    /missing/,
  );
});

test("DiffPanelView renders all required tabs and the active panel", () => {
  const vnode = DiffPanelView({ diffReview: review(), activeTab: "conflicts" });
  const text = collectVNodeText(vnode);
  for (const tab of DIFF_PANEL_TABS) {
    assert.match(text, new RegExp(tab.label));
  }
  assert.match(text, /conflict-1/);
  assert.match(text, /src\/app\.js/);
});

test("DiffPanelView renders changed tasks and patch command stdout", () => {
  const changed = DiffPanelView({ diffReview: review(), activeTab: "changedSince" });
  assert.match(collectVNodeText(changed), /Diff task/);
  assert.match(collectVNodeText(changed), /status/);

  const git = DiffPanelView({ diffReview: review(), activeTab: "gitDiff" });
  assert.match(collectVNodeText(git), /diff --git/);
  assert.match(collectVNodeText(git), /patch output truncated/);
});

test("DiffPanelView exposes tab counts and routes tab clicks", () => {
  const selected = [];
  const vnode = DiffPanelView({
    diffReview: review(),
    activeTab: "changedSince",
    onSelectTab: (tabId) => selected.push(tabId),
  });
  const tabs = nodesByClassName(vnode, "diff-panel__tab");
  assert.equal(tabs.length, 6);
  const providerTab = tabs.find((tab) => collectVNodeText(tab).includes("Provider proposals"));
  assert.equal(collectVNodeText(providerTab).includes("2"), true);
  providerTab.props.onClick();
  assert.deepEqual(selected, ["providerProposals"]);
});

test("DiffPanelView renders job actions and routes clicks", () => {
  const clicks = [];
  const vnode = DiffPanelView({
    diffReview: review(),
    onSpawnReviewer: () => clicks.push("reviewer"),
    onRunVerify: () => clicks.push("verify"),
    onMarkCloseoutPending: () => clicks.push("closeout"),
    trustedLocalMode: { allowVerifyCommandRunFromUI: true },
    actionState: { message: "working" },
  });
  const actions = nodesByClassName(vnode, "diff-panel__action");
  assert.equal(actions.length, 3);
  assert.match(collectVNodeText(vnode), /working/);
  actions[0].props.onClick();
  actions[1].props.onClick();
  actions[2].props.onClick();
  assert.deepEqual(clicks, ["reviewer", "verify", "closeout"]);

  const busy = DiffPanelView({
    diffReview: review(),
    onSpawnReviewer: () => {},
    onRunVerify: () => {},
    onMarkCloseoutPending: () => {},
    trustedLocalMode: { allowVerifyCommandRunFromUI: true },
    actionState: { busyAction: "runVerify" },
  });
  assert.match(collectVNodeText(busy), /Running/);

  const noJob = DiffPanelView({ diffReview: { ...review(), jobId: null } });
  assert.equal(nodesByClassName(noJob, "diff-panel__action").length, 0);
});

test("DiffPanelView disables verify action when trusted UI command mode is off", () => {
  const vnode = DiffPanelView({
    diffReview: review(),
    onSpawnReviewer: () => {},
    onRunVerify: () => {},
    onMarkCloseoutPending: () => {},
    trustedLocalMode: {},
  });
  const actions = nodesByClassName(vnode, "diff-panel__action");
  assert.equal(actions.length, 3);
  assert.equal(collectVNodeText(actions[1]), "Verify");
  assert.equal(actions[1].props.disabled, true);
  assert.equal(actions[1].props.onClick, undefined);
  assert.match(actions[1].props.title, /disabled/);
});

test("diffPanelTabCounts and normalizeDiffPanelTab handle sparse data", () => {
  assert.deepEqual(diffPanelTabCounts(review()), {
    changedSince: 2,
    providerProposals: 2,
    gitDiff: 1,
    allowedPaths: 2,
    conflicts: 1,
    reviewerNotes: 1,
  });
  assert.equal(normalizeDiffPanelTab("gitDiff"), "gitDiff");
  assert.equal(normalizeDiffPanelTab("unknown"), "changedSince");
});

test("createDiffReviewerDraft creates attach_existing reviewer draft with changed-since context", async () => {
  const calls = [];
  const result = await createDiffReviewerDraft({
    diffReview: {
      ...review(),
      providerCapabilities: { providerReview: true },
      providerThreadId: "thread_1",
    },
    trustedLocalMode: {},
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ draft: { id: "draft_123" } }, { status: 201 });
    },
  });
  assert.equal(result.draft.id, "draft_123");
  assert.equal(calls[0][0], "/api/run-session/draft");
  assert.equal(calls[0][1].method, "POST");
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.source, "attach");
  assert.equal(body.mode, "attach_existing");
  assert.equal(body.attachExistingSessionId, "ses_1");
  assert.equal(body.attachTaskId, "task-1");
  assert.equal(body.profileId, "reviewer");
  assert.equal(body.contextPackKind, "changed_since");
  assert.equal(body.contextFromJobId, "job_1");
  assert.equal(body.baseRev, 2);
  assert.equal(body.currentRev, 5);
});

test("createDiffReviewerDraft uses native provider review when trusted and advertised", async () => {
  const calls = [];
  const result = await createDiffReviewerDraft({
    diffReview: {
      ...review(),
      id: "diff:ses_1:2",
      providerReview: { available: true },
      providerCapabilities: { providerReview: true },
      providerThreadId: "thread_1",
    },
    trustedLocalMode: { allowProviderReviewFromUI: true },
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ ok: true, action: "review", result: { reviewId: "rev_1" } });
    },
  });
  assert.equal(result.mode, "provider_review");
  assert.equal(result.threadId, "thread_1");
  assert.equal(calls[0][0], "/api/sessions/ses_1/provider/review");
  assert.equal(calls[0][1].method, "POST");
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.threadId, "thread_1");
  assert.match(body.prompt, /Review the changed-since diff/);
  assert.equal(body.scope.diffReviewId, "diff:ses_1:2");
  assert.equal(body.scope.projectSlug, "demo");
  assert.equal(body.scope.taskId, "task-1");
  assert.equal(body.scope.jobId, "job_1");
  assert.equal(body.scope.baseRev, 2);
  assert.equal(body.scope.currentRev, 5);
});

test("runDiffVerify requires trusted UI mode and runs command items", async () => {
  await assert.rejects(
    () => runDiffVerify({ diffReview: review(), trustedLocalMode: {}, fetchImpl: async () => jsonResponse({}) }),
    /disabled/,
  );

  const calls = [];
  const result = await runDiffVerify({
    diffReview: review(),
    trustedLocalMode: { allowVerifyCommandRunFromUI: true },
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      if (init.method === "GET") {
        return jsonResponse({
          items: [
            { id: "cmd.ok", kind: "command" },
            { id: "approve", kind: "human_approval" },
            { id: "", kind: "command" },
          ],
        });
      }
      return jsonResponse({ ok: true, itemId: "cmd.ok" });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(calls[0][0], "/api/jobs/job_1/verify-pack");
  assert.equal(calls[1][0], "/api/jobs/job_1/verify-pack/items/cmd.ok/run");
  assert.deepEqual(JSON.parse(calls[1][1].body), { source: "ui" });
});

test("markDiffCloseoutPending starts closeout skill run with diff evidence", async () => {
  const calls = [];
  const result = await markDiffCloseoutPending({
    diffReview: review(),
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ skillRunId: "skr_1" }, { status: 201 });
    },
  });
  assert.equal(result.skillRunId, "skr_1");
  assert.equal(calls[0][0], "/api/jobs/job_1/skill-runs");
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.skillId, "lt.closeout_sweep");
  assert.equal(body.source, "ui");
  assert.equal(body.evidence.sessionId, "ses_1");
  assert.equal(body.evidence.baseRev, 2);
});

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText || "",
    async json() {
      return body;
    },
  };
}
