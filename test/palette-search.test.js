import { test } from "node:test";
import assert from "node:assert/strict";
import { rankPaletteTaskMatches } from "../ui/palette.js";

test("rankPaletteTaskMatches prioritizes task id, then title, then details", () => {
  const tasks = [
    {
      id: "title-hit",
      title: "wf-loop-001 repair",
      status: "not_started",
      placement: { swimlaneId: "liveuse", priorityId: "p0" }
    },
    {
      id: "details-hit",
      title: "Workflow loop",
      goal: "Mentions wf-loop-001 in details.",
      status: "not_started",
      placement: { swimlaneId: "liveuse", priorityId: "p0" }
    },
    {
      id: "wf-loop-001",
      title: "Exact read-for-edit slices",
      status: "complete",
      placement: { swimlaneId: "liveuse", priorityId: "p0" }
    }
  ];

  const matches = rankPaletteTaskMatches(tasks, "wf-loop-001", 10);

  assert.deepEqual(matches.map((task) => task.id), [
    "wf-loop-001",
    "title-hit",
    "details-hit"
  ]);
  assert.deepEqual(matches.map((task) => task.matchedOn[0]), [
    "id",
    "title",
    "details"
  ]);
});

