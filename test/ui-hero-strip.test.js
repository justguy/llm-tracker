import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHeroReason,
  buildHeroSummary,
  formatHeroPath,
  pctForTasks
} from "../ui/lib/hero-strip.js";

test("pctForTasks matches tracker progress semantics", () => {
  assert.equal(
    pctForTasks([
      { status: "complete" },
      { status: "in_progress" },
      { status: "not_started" },
      { status: "deferred" }
    ]),
    50
  );
});

test("formatHeroPath shortens shared-workspace and repo-local tracker paths", () => {
  assert.equal(
    formatHeroPath({ file: "/Users/alice/.llm-tracker/trackers/demo.json" }, "demo"),
    "~/.llm-tracker"
  );
  assert.equal(
    formatHeroPath(
      { file: "/Users/alice/Documents/dev/llm-project-tracker/.llm-tracker/trackers/llm-tracker.json" },
      "llm-tracker"
    ),
    "~/Documents/dev/llm-project-tracker"
  );
});

test("buildHeroSummary reuses derived pct and computes open from blocked tasks", () => {
  const summary = buildHeroSummary(
    {
      file: "/Users/alice/Documents/dev/llm-project-tracker/.llm-tracker/trackers/llm-tracker.json",
      data: {
        meta: { name: "llm-tracker", swimlanes: [{ id: "redesign" }], updatedAt: null },
        tasks: [{ status: "complete" }, { status: "in_progress" }, { status: "not_started" }, { status: "deferred" }]
      },
      derived: {
        total: 4,
        pct: 63,
        counts: { complete: 1, in_progress: 1, not_started: 1, deferred: 1 },
        blocked: { t9: ["t8"], t10: ["t8"] }
      }
    },
    "llm-tracker"
  );

  assert.equal(summary.pct, 63);
  assert.equal(summary.blockedCount, 2);
  assert.equal(summary.openCount, 2);
  assert.equal(summary.statusTiles.find((tile) => tile.key === "open")?.count, 2);
  assert.equal(summary.trackerPath, "~/Documents/dev/llm-project-tracker");
});

test("buildHeroReason composes readiness, priority, deps, status, and approvals", () => {
  assert.equal(
    buildHeroReason({
      ready: true,
      priorityId: "p1",
      blocking_on: [],
      status: "in_progress",
      requires_approval: ["product", "design"]
    }),
    "highest-ranked ready task · p1 · dependencies satisfied · already in progress · requires product, design approval"
  );
});
