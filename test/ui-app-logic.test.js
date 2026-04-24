import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fuzzyMatchMapForPane,
  nextTaskDrawerState,
  parsePortDraft,
  selectActiveSlugAfterProjectsChange,
  shouldSuspendGlobalShortcuts,
  taskDeleteUrl
} from "../ui/app.js";

test("parsePortDraft accepts only exact decimal port values", () => {
  assert.equal(parsePortDraft("4400"), 4400);
  assert.equal(parsePortDraft(" 8080 "), 8080);
  assert.equal(parsePortDraft("1e3"), null);
  assert.equal(parsePortDraft("123abc"), null);
  assert.equal(parsePortDraft("0"), null);
  assert.equal(parsePortDraft("65536"), null);
});

test("shouldSuspendGlobalShortcuts blocks mutating shortcuts behind modal surfaces", () => {
  assert.equal(shouldSuspendGlobalShortcuts({ helpOpen: true }), true);
  assert.equal(shouldSuspendGlobalShortcuts({ settingsOpen: true }), true);
  assert.equal(shouldSuspendGlobalShortcuts({ projectIntel: { slug: "demo" } }), true);
  assert.equal(shouldSuspendGlobalShortcuts({ drawerOpen: true, drawerPinned: false }), true);
  assert.equal(shouldSuspendGlobalShortcuts({ drawerOpen: true, drawerPinned: true }), false);
  assert.equal(shouldSuspendGlobalShortcuts({}), false);
});

test("selectActiveSlugAfterProjectsChange reselects when active project is removed", () => {
  assert.equal(
    selectActiveSlugAfterProjectsChange("removed", {
      beta: {},
      alpha: {}
    }),
    "alpha"
  );
  assert.equal(selectActiveSlugAfterProjectsChange("alpha", { alpha: {} }), "alpha");
  assert.equal(selectActiveSlugAfterProjectsChange("removed", {}), null);
});

test("fuzzyMatchMapForPane only returns matches for the queried project and query", () => {
  const map = new Map([["t1", { id: "t1" }]]);
  const fuzzyState = { slug: "active", query: "deploy", matches: [] };

  assert.equal(
    fuzzyMatchMapForPane({ searchMode: "fuzzy", fuzzyState, filter: "deploy", slug: "active", fuzzyMatchMap: map }),
    map
  );
  assert.equal(
    fuzzyMatchMapForPane({ searchMode: "fuzzy", fuzzyState, filter: "deploy", slug: "pinned", fuzzyMatchMap: map }),
    null
  );
  assert.equal(
    fuzzyMatchMapForPane({ searchMode: "fuzzy", fuzzyState, filter: "other", slug: "active", fuzzyMatchMap: map }),
    null
  );
  assert.equal(
    fuzzyMatchMapForPane({ searchMode: "filter", fuzzyState, filter: "deploy", slug: "active", fuzzyMatchMap: map }),
    null
  );
});

test("taskDeleteUrl encodes path-sensitive task ids", () => {
  assert.equal(
    taskDeleteUrl("demo project", "task/with?chars#hash"),
    "/api/projects/demo%20project/tasks/task%2Fwith%3Fchars%23hash"
  );
});

test("nextTaskDrawerState toggles only the exact same task and mode", () => {
  const current = { slug: "demo", taskId: "t1", mode: "brief" };
  assert.equal(nextTaskDrawerState(current, "demo", "t1", "brief"), null);
  assert.deepEqual(
    nextTaskDrawerState(current, "demo", "t1", "execute"),
    { slug: "demo", taskId: "t1", mode: "execute" }
  );
});
