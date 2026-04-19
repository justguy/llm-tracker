import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHeroReason,
  buildHeroSummary,
  formatHeroPath,
  pctForTasks
} from "../ui/lib/hero-strip.js";
import {
  HeroStripView,
  loadNextRecommendation
} from "../ui/app.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) {
    return node.map((item) => collectVNodeText(item)).join(" ");
  }
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (typeof node.type === "function") {
    return collectVNodeText(node.type(node.props || {}));
  }
  return collectVNodeText(node.props?.children);
}

function flattenRenderedNodes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => flattenRenderedNodes(item, acc));
    return acc;
  }
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return acc;
  }
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function heroSummary(overrides = {}) {
  return {
    projectName: "llm-tracker",
    trackerPath: "~/Documents/dev/llm-project-tracker",
    swimlaneCount: 9,
    total: 56,
    updatedAt: "6:55:42 AM",
    pct: 94,
    complete: 49,
    completeW: 87.5,
    warnW: 1.8,
    statusTiles: [
      { label: "Complete", key: "complete", count: 49, color: "var(--ok)", strong: true },
      { label: "In progress", key: "in_progress", count: 1, color: "var(--warn)", strong: false },
      { label: "Not started", key: "not_started", count: 6, color: "var(--ink-3)", strong: false },
      { label: "Deferred", key: "deferred", count: 0, color: "var(--ink-3)", strong: false },
      { label: "Blocked", key: "blocked", count: 2, color: "var(--block)", strong: false },
      { label: "Open", key: "open", count: 54, color: "var(--ink-2)", strong: true }
    ],
    ...overrides
  };
}

function findButtonByLabel(vnode, label) {
  return flattenRenderedNodes(vnode).find(
    (node) =>
      node.type === "button" &&
      collectVNodeText(node.props?.children).replace(/\s+/g, " ").trim().includes(label)
  );
}

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

test("loadNextRecommendation reads the ranked shortlist and maps errors", async () => {
  let requestedUrl = "";
  const payload = { next: [{ id: "t23" }] };

  const body = await loadNextRecommendation("llm-tracker", async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      statusText: "OK",
      json: async () => payload
    };
  });

  assert.equal(requestedUrl, "/api/projects/llm-tracker/next?limit=1");
  assert.deepEqual(body, payload);

  await assert.rejects(
    () =>
      loadNextRecommendation("llm-tracker", async () => ({
        ok: false,
        statusText: "Bad Request",
        json: async () => ({ error: "ranking offline" })
      })),
    /ranking offline/
  );
});

test("HeroStripView renders the recommended task and wires PICK and READ actions", () => {
  const calls = [];
  const vnode = HeroStripView({
    summary: heroSummary(),
    slug: "llm-tracker",
    nextTask: {
      id: "t23",
      title: "Build hero strip",
      reason: ["highest-ranked ready task", "p0", "dependencies satisfied"]
    },
    onPickTask: (...args) => calls.push(["pick", ...args]),
    onOpenTask: (...args) => calls.push(["read", ...args])
  });

  const text = collectVNodeText(vnode).replace(/\s+/g, " ").trim();
  assert.match(text, /llm-tracker/);
  assert.match(text, /94/);
  assert.match(text, /49 of 56 tasks complete/);
  assert.match(text, /Build hero strip/);
  assert.match(text, /highest-ranked ready task · p0 · dependencies satisfied/);

  const pickBtn = findButtonByLabel(vnode, "PICK");
  const readBtn = findButtonByLabel(vnode, "READ");
  assert.ok(pickBtn);
  assert.ok(readBtn);
  assert.equal(pickBtn.props.disabled, false);
  assert.equal(readBtn.props.disabled, false);

  pickBtn.props.onClick();
  readBtn.props.onClick();

  assert.deepEqual(calls, [
    ["pick", "llm-tracker", "t23"],
    ["read", "llm-tracker", "t23", "brief"]
  ]);
});

test("HeroStripView renders loading, error, and empty states without a recommended task", () => {
  const loadingText = collectVNodeText(
    HeroStripView({
      summary: heroSummary(),
      slug: "llm-tracker",
      nextLoading: true
    })
  ).replace(/\s+/g, " ").trim();
  assert.match(loadingText, /Loading ranked shortlist/);
  assert.match(loadingText, /Fetching the current top-ranked task from \/next\./);

  const errorText = collectVNodeText(
    HeroStripView({
      summary: heroSummary(),
      slug: "llm-tracker",
      nextError: "ranking offline"
    })
  ).replace(/\s+/g, " ").trim();
  assert.match(errorText, /Recommendation unavailable/);
  assert.match(errorText, /ranking offline/);

  const emptyVnode = HeroStripView({
    summary: heroSummary(),
    slug: "llm-tracker"
  });
  const emptyText = collectVNodeText(emptyVnode).replace(/\s+/g, " ").trim();
  assert.match(emptyText, /No ready task/);
  assert.match(emptyText, /No ready task is available from the current ranking\./);
});
