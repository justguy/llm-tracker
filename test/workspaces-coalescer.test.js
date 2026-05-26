import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COALESCE_MS,
  RepoChangeCoalescer,
  collapseWatcherEvent,
  coalesceRepoChangeEvent,
  repoChangeCoalescerKey,
} from "../hub/workspaces/coalescer.js";

function repoEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    id: overrides.id || "evt_default",
    ts: overrides.ts || "2026-05-26T16:00:00.000Z",
    type: "repo.change",
    source: "watcher",
    workspace: "/workspace",
    projectSlug: "demo",
    repoRoot: "/repo",
    path: "src/app.js",
    event: "change",
    activeSessionIds: [],
    possibleSessionIds: [],
    attribution: "unknown",
    relatedTaskIds: [],
    ...overrides,
  };
}

function manualTimers() {
  let nextHandle = 1;
  const timers = new Map();
  const cleared = [];
  return {
    setTimer(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearTimer(handle) {
      cleared.push(handle);
      timers.delete(handle);
    },
    async fireAll() {
      for (const handle of Array.from(timers.keys())) {
        const timer = timers.get(handle);
        timers.delete(handle);
        await timer.fn();
      }
    },
    get size() {
      return timers.size;
    },
    get delays() {
      return Array.from(timers.values()).map((timer) => timer.ms);
    },
    get cleared() {
      return cleared.slice();
    },
  };
}

test("RepoChangeCoalescer debounces per path using the default 200 ms window", async () => {
  const timers = manualTimers();
  const emitted = [];
  const coalescer = new RepoChangeCoalescer({
    emit: (event) => emitted.push(event),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.receive(repoEvent({ id: "evt_1" }));

  assert.equal(DEFAULT_COALESCE_MS, 200);
  assert.equal(coalescer.coalesceMs, 200);
  assert.deepEqual(timers.delays, [200]);
  assert.equal(coalescer.pendingCount(), 1);
  assert.deepEqual(emitted, []);

  await timers.fireAll();

  assert.equal(coalescer.pendingCount(), 0);
  assert.deepEqual(
    emitted.map((event) => event.id),
    ["evt_1"],
  );
});

test("later same-key events reset the timer and emit only one latest event", async () => {
  const timers = manualTimers();
  const emitted = [];
  const coalescer = new RepoChangeCoalescer({
    coalesceMs: 50,
    emit: (event) => emitted.push(event),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.receive(repoEvent({ id: "evt_1", event: "change", ts: "2026-05-26T16:00:00.000Z" }));
  coalescer.receive(repoEvent({ id: "evt_2", event: "change", ts: "2026-05-26T16:00:00.050Z" }));

  assert.equal(timers.size, 1);
  assert.deepEqual(timers.cleared, [1]);
  assert.equal(coalescer.pendingCount(), 1);

  await timers.fireAll();

  assert.deepEqual(
    emitted.map((event) => [event.id, event.event, event.ts]),
    [["evt_2", "change", "2026-05-26T16:00:00.050Z"]],
  );
});

test("collapseWatcherEvent applies add/change/unlink collapse rules", () => {
  assert.equal(collapseWatcherEvent("change", "change"), "change");
  assert.equal(collapseWatcherEvent("change", "unlink"), "unlink");
  assert.equal(collapseWatcherEvent("add", "unlink"), "unlink");
  assert.equal(collapseWatcherEvent("unlink", "add"), "add");
  assert.equal(collapseWatcherEvent("add", "change"), "add");
  assert.equal(collapseWatcherEvent("change", "add"), "add");
});

test("coalesceRepoChangeEvent keeps latest metadata while preserving collapsed event", () => {
  const previous = repoEvent({ id: "evt_add", event: "add", activeSessionIds: ["ses_old"] });
  const next = repoEvent({ id: "evt_change", event: "change", activeSessionIds: ["ses_new"] });

  assert.deepEqual(coalesceRepoChangeEvent(previous, next), {
    ...next,
    event: "add",
  });

  assert.equal(coalesceRepoChangeEvent(next, repoEvent({ id: "evt_unlink", event: "unlink" })).event, "unlink");
  assert.equal(coalesceRepoChangeEvent(repoEvent({ event: "unlink" }), repoEvent({ event: "add" })).event, "add");
});

test("events are keyed by both repoRoot and path", async () => {
  const timers = manualTimers();
  const emitted = [];
  const coalescer = new RepoChangeCoalescer({
    emit: (event) => emitted.push(event),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const samePathOtherRepo = repoEvent({ id: "evt_other_repo", repoRoot: "/repo-2" });
  const otherPath = repoEvent({ id: "evt_other_path", path: "src/other.js" });

  assert.equal(repoChangeCoalescerKey(samePathOtherRepo), "/repo-2\0src/app.js");
  coalescer.receive(repoEvent({ id: "evt_base" }));
  coalescer.receive(samePathOtherRepo);
  coalescer.receive(otherPath);

  assert.equal(coalescer.pendingCount(), 3);
  await coalescer.flush();

  assert.deepEqual(
    emitted.map((event) => event.id),
    ["evt_base", "evt_other_repo", "evt_other_path"],
  );
});

test("close can flush or discard pending events", async () => {
  const timers = manualTimers();
  const emitted = [];
  const coalescer = new RepoChangeCoalescer({
    emit: (event) => emitted.push(event),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.receive(repoEvent({ id: "evt_flush" }));
  assert.deepEqual((await coalescer.close()).map((event) => event.id), ["evt_flush"]);
  assert.deepEqual(emitted.map((event) => event.id), ["evt_flush"]);

  coalescer.receive(repoEvent({ id: "evt_discard" }));
  assert.deepEqual(await coalescer.close({ flush: false }), []);
  assert.equal(coalescer.pendingCount(), 0);
  assert.deepEqual(emitted.map((event) => event.id), ["evt_flush"]);
});

test("invalid configuration and events fail closed", () => {
  assert.throws(() => new RepoChangeCoalescer({ emit: () => {}, coalesceMs: -1 }), /coalesceMs/);
  assert.throws(() => new RepoChangeCoalescer(), /emit function required/);
  const coalescer = new RepoChangeCoalescer({ emit: () => {} });
  assert.throws(() => coalescer.receive({ type: "repo.burst" }), /repo.change/);
  assert.throws(() => coalescer.receive(repoEvent({ event: "rename" })), /add, change, or unlink/);
});
