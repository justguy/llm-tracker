import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SwimlaneRunNextButton,
  bestRunCandidateForLane,
  buildRunNextIntent,
  fetchRunCandidatesForLane,
  runCandidateReason,
} from "./SwimlaneRunNextButton.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

test("bestRunCandidateForLane returns highest scoring candidate in the selected lane", () => {
  const candidates = [
    { taskId: "outside", laneId: "other", score: 999 },
    { taskId: "lane-low", laneId: "track-2", score: 10 },
    { taskId: "lane-high", laneId: "track-2", score: 42 },
  ];
  assert.equal(bestRunCandidateForLane(candidates, "track-2").taskId, "lane-high");
});

test("runCandidateReason concatenates reasons and penalties", () => {
  assert.equal(
    runCandidateReason({
      reasons: ["+100 in selected lane", "+80 dependencies satisfied"],
      penalties: ["-40 missing allowed_paths"],
    }),
    "+100 in selected lane; +80 dependencies satisfied; -40 missing allowed_paths",
  );
});

test("buildRunNextIntent opens wizard with task and reason string", () => {
  const intent = buildRunNextIntent({
    projectSlug: "llm-tracker",
    lane: { id: "track-2" },
    candidates: [
      {
        taskId: "sh-3-07",
        laneId: "track-2",
        score: 180,
        reasons: ["+100 in selected lane", "+80 dependencies satisfied"],
      },
    ],
  });
  assert.equal(intent.source, "swimlane_next");
  assert.equal(intent.projectSlug, "llm-tracker");
  assert.equal(intent.swimlaneId, "track-2");
  assert.equal(intent.taskId, "sh-3-07");
  assert.match(intent.reason, /selected lane/);
});

test("SwimlaneRunNextButton invokes onRunNext with the selected intent", () => {
  let opened = null;
  const vnode = SwimlaneRunNextButton({
    projectSlug: "demo",
    lane: { id: "lane-a" },
    candidates: [{ taskId: "t1", laneId: "lane-a", score: 5, reasons: ["best fit"] }],
    onRunNext: (intent) => {
      opened = intent;
    },
  });

  assert.equal(collectVNodeText(vnode).trim(), "[+ NEXT IN LANE]");
  assert.equal(vnode.props.disabled, false);
  assert.equal(vnode.props["data-task-id"], "t1");
  assert.equal(vnode.props["data-reason"], "best fit");
  vnode.props.onClick();
  assert.equal(opened.taskId, "t1");
  assert.equal(opened.reason, "best fit");
});

test("fetchRunCandidatesForLane calls run-candidates endpoint with laneId", async () => {
  const calls = [];
  const result = await fetchRunCandidatesForLane({
    projectSlug: "demo",
    laneId: "lane-a",
    fetcher: async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ taskId: "t1", score: 9 }],
          projectSlug: "demo",
          laneId: "lane-a",
          rev: 7,
        }),
      };
    },
  });
  assert.deepEqual(calls, ["/api/run-candidates?projectSlug=demo&laneId=lane-a"]);
  assert.equal(result.candidates[0].taskId, "t1");
  assert.equal(result.rev, 7);
});
