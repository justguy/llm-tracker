import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WORKSPACE_LANE_CHIPS,
  RunCandidatePickerView,
  buildCrossProjectRunSelection,
  fetchWorkspaceRunCandidates,
  multiLaunchLimit,
  topWorkspaceRunCandidates,
} from "./RunCandidatePicker.js";

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

function response(body, ok = true) {
  return {
    ok,
    statusText: ok ? "OK" : "Bad Request",
    async json() {
      return body;
    },
  };
}

test("topWorkspaceRunCandidates flattens projects and returns top scored candidates", () => {
  const candidates = topWorkspaceRunCandidates([
    {
      projectSlug: "alpha",
      candidates: [
        { taskId: "a-low", score: 5, reasons: ["ready"] },
        { taskId: "a-high", score: 50, reasons: ["primary"] },
      ],
    },
    {
      projectSlug: "beta",
      candidates: [{ taskId: "b-mid", score: 25, penalties: ["active session"] }],
    },
  ], { limit: 2 });

  assert.deepEqual(candidates.map((candidate) => candidate.key), ["alpha:a-high", "beta:b-mid"]);
  assert.equal(candidates[0].reasons[0], "primary");
  assert.equal(candidates[1].penalties[0], "active session");
});

test("RunCandidatePickerView renders workspace lane chips and candidate reasons", () => {
  const vnode = RunCandidatePickerView({
    candidates: [
      { key: "alpha:t1", projectSlug: "alpha", taskId: "t1", score: 42, reasons: ["unblocked"] },
    ],
    selectedKeys: ["alpha:t1"],
  });
  const text = collectVNodeText(vnode);
  for (const chip of WORKSPACE_LANE_CHIPS) {
    assert.match(text, new RegExp(chip.label));
  }
  assert.match(text, /alpha/);
  assert.match(text, /t1/);
  assert.match(text, /unblocked/);
  assert.match(text, /42/);
  assert.equal(nodesByClassName(vnode, "run-candidate-picker__row")[0].props["data-candidate-key"], "alpha:t1");
});

test("buildCrossProjectRunSelection caps multi-launches at three and requires confirmation", () => {
  const candidates = ["t1", "t2", "t3", "t4"].map((taskId, index) => ({
    key: `alpha:${taskId}`,
    projectSlug: "alpha",
    taskId,
    score: 100 - index,
  }));
  const selection = buildCrossProjectRunSelection({
    candidates,
    selectedKeys: candidates.map((candidate) => candidate.key),
    crossProjectQueue: {
      requireHumanConfirmForMultiLaunch: true,
      maxInitialLaunches: 9,
    },
  });

  assert.equal(multiLaunchLimit({ maxInitialLaunches: 9 }), 3);
  assert.equal(selection.scope, "workspace-local");
  assert.deepEqual(selection.taskIds, ["t1", "t2", "t3"]);
  assert.equal(selection.requiresConfirmation, true);
  assert.match(selection.confirmationReason, /Confirm launch of 3/);
});

test("RunCandidatePickerView launches selected candidates through intent only", () => {
  let launched = null;
  const vnode = RunCandidatePickerView({
    candidates: [
      { key: "alpha:t1", projectSlug: "alpha", taskId: "t1", score: 30, reasons: ["ready"] },
      { key: "beta:t2", projectSlug: "beta", taskId: "t2", score: 20, reasons: ["unblocked"] },
    ],
    selectedKeys: ["alpha:t1", "beta:t2"],
    crossProjectQueue: { requireHumanConfirmForMultiLaunch: true, maxInitialLaunches: 3 },
    onLaunch: (selection) => {
      launched = selection;
    },
  });
  const launch = nodesByClassName(vnode, "run-candidate-picker__launch")[0];
  assert.equal(launch.props["data-requires-confirmation"], "true");
  launch.props.onClick();
  assert.deepEqual(launched.projectSlugs, ["alpha", "beta"]);
  assert.equal(launched.requiresConfirmation, true);
});

test("fetchWorkspaceRunCandidates requests each workspace project without scheduling", async () => {
  const calls = [];
  const result = await fetchWorkspaceRunCandidates({
    projects: [{ slug: "alpha" }, { projectSlug: "beta" }],
    limit: 3,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("alpha")) {
        return response({ projectSlug: "alpha", candidates: [{ taskId: "a", score: 10, reasons: ["ready"] }] });
      }
      return response({ projectSlug: "beta", candidates: [{ taskId: "b", score: 20, reasons: ["ready"] }] });
    },
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/run-candidates?projectSlug=alpha",
    "/api/run-candidates?projectSlug=beta",
  ]);
  assert.ok(calls.every((call) => call.options === undefined));
  assert.equal(result.scope, "workspace-local");
  assert.deepEqual(result.candidates.map((candidate) => candidate.key), ["beta:b", "alpha:a"]);
});
