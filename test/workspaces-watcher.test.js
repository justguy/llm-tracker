import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { ChokidarWatcherBackend } from "../hub/workspaces/backends/chokidar.js";
import { NodeFsWatchBackend } from "../hub/workspaces/backends/node-fs-watch.js";
import {
  ProjectWorkspaceWatcher,
  buildRepoChangeEvent,
  createIgnoreMatcher,
  createWatcherBackend,
  repoRelativePath,
  resolveProjectWatchRoots,
  watcherBackendOptions,
} from "../hub/workspaces/watcher.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

test("createWatcherBackend defaults to chokidar and honors node_fs_watch override", () => {
  assert.ok(createWatcherBackend() instanceof ChokidarWatcherBackend);
  assert.ok(
    createWatcherBackend({ watcherConfig: { backend: "node_fs_watch" } }) instanceof
      NodeFsWatchBackend,
  );
});

test("watcherBackendOptions forwards §25 backend tuning keys", () => {
  assert.deepEqual(
    watcherBackendOptions({
      usePolling: true,
      atomic: false,
      awaitWriteFinish: { stabilityThreshold: 50 },
    }),
    {
      usePolling: true,
      atomic: false,
      awaitWriteFinish: { stabilityThreshold: 50 },
    },
  );
});

test("ChokidarWatcherBackend normalizes raw chokidar events before handoff", () => {
  let allHandler;
  let closeCalled = false;
  let capturedPaths;
  let capturedOptions;
  const fakeChokidar = {
    watch(paths, options) {
      capturedPaths = paths;
      capturedOptions = options;
      return {
        on(name, handler) {
          assert.equal(name, "all");
          allHandler = handler;
          return this;
        },
        close() {
          closeCalled = true;
        },
      };
    },
  };
  const events = [];
  const backend = new ChokidarWatcherBackend({ chokidarModule: fakeChokidar });
  const handle = backend.watch(["/repo"], {
    usePolling: true,
    atomic: false,
    awaitWriteFinish: true,
    ignored: () => false,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(capturedPaths, ["/repo"]);
  assert.equal(capturedOptions.ignoreInitial, true);
  assert.equal(capturedOptions.usePolling, true);
  assert.equal(capturedOptions.atomic, false);
  assert.equal(capturedOptions.awaitWriteFinish, true);

  allHandler("addDir", "/repo/src");
  allHandler("change", "/repo/src/app.js");
  allHandler("unlinkDir", "/repo/src");
  allHandler("ready", "/repo");
  assert.deepEqual(
    events.map((event) => [event.backend, event.rawEvent, event.event, event.path]),
    [
      ["chokidar", "addDir", "add", "/repo/src"],
      ["chokidar", "change", "change", "/repo/src/app.js"],
      ["chokidar", "unlinkDir", "unlink", "/repo/src"],
    ],
  );
  handle.close();
  assert.equal(closeCalled, true);
});

test("NodeFsWatchBackend normalizes fs.watch rename using existence probe", () => {
  const callbacks = [];
  const closed = [];
  const backend = new NodeFsWatchBackend({
    watch(root, options, callback) {
      callbacks.push({ root, options, callback });
      return { close: () => closed.push(root) };
    },
    pathExists(filePath) {
      return filePath.endsWith("created.js");
    },
  });
  const events = [];
  const handle = backend.watch(["/repo"], { onEvent: (event) => events.push(event) });

  callbacks[0].callback("rename", "created.js");
  callbacks[0].callback("rename", "deleted.js");
  callbacks[0].callback("change", "changed.js");
  callbacks[0].callback("unknown", "ignored.js");

  assert.deepEqual(
    events.map((event) => [event.rawEvent, event.event, event.path]),
    [
      ["rename", "add", join("/repo", "created.js")],
      ["rename", "unlink", join("/repo", "deleted.js")],
      ["change", "change", join("/repo", "changed.js")],
    ],
  );
  assert.equal(callbacks[0].options.recursive, true);
  handle.close();
  assert.deepEqual(closed, ["/repo"]);
});

test("resolveProjectWatchRoots includes project repos, worktrees, sessions, and linked repo root", () => {
  const roots = resolveProjectWatchRoots(
    {
      slug: "demo",
      file: "/repo/.llm-tracker/trackers/demo.json",
      data: {
        tasks: [
          {
            id: "t-1",
            repos: {
              primary: { root: "/repo", worktree: "/repo-wt" },
              secondary: [{ root: "/docs" }],
            },
          },
        ],
      },
    },
    [
      { id: makeRuntimeId("ses"), projectSlug: "demo", cwd: "/repo", worktreePath: "/repo-wt-2" },
      { id: makeRuntimeId("ses"), projectSlug: "other", repoRoot: "/other-repo" },
    ],
  );

  assert.deepEqual(roots, ["/repo", "/repo-wt", "/docs", "/repo-wt-2"]);
});

test("createIgnoreMatcher applies §25 watcher ignore patterns against repo-relative paths", () => {
  const ignored = createIgnoreMatcher(["node_modules/**", ".git/**", "*.log", "tmp/**/*.json"], "/repo");
  assert.equal(ignored("/repo/node_modules/pkg/index.js"), true);
  assert.equal(ignored("/repo/.git/config"), true);
  assert.equal(ignored("/repo/debug.log"), true);
  assert.equal(ignored("/repo/tmp/a/b/data.json"), true);
  assert.equal(ignored("/repo/src/app.js"), false);
  assert.equal(repoRelativePath("/repo", "/repo/src/app.js"), "src/app.js");
  assert.equal(repoRelativePath("/repo", "/other/app.js"), null);
});

test("buildRepoChangeEvent emits valid repo.change event from normalized backend payload", () => {
  const sessionId = makeRuntimeId("ses");
  const event = buildRepoChangeEvent({
    workspace: "/workspace",
    repoRoot: "/repo",
    project: {
      slug: "demo",
      data: {
        tasks: [{ id: "t-1", repos: { primary: { root: "/repo" } } }],
      },
    },
    sessions: [{ id: sessionId, projectSlug: "demo", repoRoot: "/repo", status: "active" }],
    backendEvent: { event: "change", path: "/repo/src/app.js" },
    now: () => "2026-05-26T15:00:00.000Z",
    makeId: makeRuntimeId,
  });

  assert.equal(validateRuntimeEvent(event), true);
  assert.equal(event.type, "repo.change");
  assert.equal(event.source, "watcher");
  assert.equal(event.path, "src/app.js");
  assert.deepEqual(event.activeSessionIds, [sessionId]);
  assert.deepEqual(event.possibleSessionIds, [sessionId]);
  assert.equal(event.attribution, "single_active_session");
  assert.deepEqual(event.relatedTaskIds, ["t-1"]);
});

test("ProjectWorkspaceWatcher watches each root, applies ignores, and forwards events", async () => {
  const calls = [];
  const backend = {
    name: "fake",
    watch(root, options) {
      calls.push({ root, options });
      return { close() {} };
    },
  };
  const emitted = [];
  const watcher = new ProjectWorkspaceWatcher({
    workspaceRoot: "/workspace",
    backend,
    watcherConfig: {
      backend: "node_fs_watch",
      usePolling: true,
      atomic: false,
      awaitWriteFinish: false,
      ignore: ["dist/**"],
    },
    onEvent: (event) => emitted.push(event),
  });
  const project = {
    slug: "demo",
    data: {
      tasks: [{ id: "t-1", repos: { primary: { root: "/repo", worktree: "/repo-wt" } } }],
    },
  };

  watcher.watchProject(project, {
    sessions: [{ id: makeRuntimeId("ses"), projectSlug: "demo", repoRoot: "/repo", status: "active" }],
  });

  assert.deepEqual(
    calls.map((call) => call.root),
    ["/repo", "/repo-wt"],
  );
  assert.equal(calls[0].options.usePolling, true);
  assert.equal(calls[0].options.atomic, false);
  assert.equal(calls[0].options.awaitWriteFinish, false);
  assert.equal(calls[0].options.ignored("/repo/dist/bundle.js"), true);

  await watcher.receiveBackendEvent(project, "/repo", {
    event: "change",
    path: "/repo/src/app.js",
  });
  await watcher.receiveBackendEvent(project, "/repo", {
    event: "change",
    path: "/repo/dist/bundle.js",
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].path, "src/app.js");
});
