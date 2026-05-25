// test/layouts.test.js — SH-2-08 (TDD v0.5 §6.11, §23.1, §23.2 #13)
//
// Schema lint, default-on-corrupt fallback, save/load round-trip, per-project
// subsection in same file, HTTP envelope, and regression that save() leaves
// runtime-events.jsonl byte-identical + source files reference no event-log
// symbols.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import express from "express";

import {
  DEFAULT_LAYOUT,
  CARD_SIZES,
  HUB_GROUP_BY,
  TRIAGE_SORT_BY,
  LayoutStore,
  layoutFilePath,
  assertValidLayout,
} from "../hub/runtime/layouts.js";
import { registerLayoutsRoutes } from "../hub/api/layouts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// 26-char Crockford Base32 (lower-case, no i/l/o/u). Pre-baked because tests
// shouldn't depend on ULID generators.
const VALID_SESSION_ID_A = "ses_01h0000000000000000000000a";
const VALID_SESSION_ID_B = "ses_01h0000000000000000000000b";

async function makeWorkspace() {
  return mkdtemp(path.join(tmpdir(), "lt-layouts-"));
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startMiniApp(workspaceRoot) {
  const app = express();
  app.use(express.json());
  registerLayoutsRoutes(app, { workspaceRoot });
  const port = await findFreePort();
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("assertValidLayout accepts DEFAULT_LAYOUT", () => {
  // Clone — assertValidLayout shouldn't care about frozen-ness, but make the
  // intent explicit (load() returns mutable clones).
  const layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  assert.doesNotThrow(() => assertValidLayout(layout));
});

test("assertValidLayout exports match TDD §6.11 enums", () => {
  assert.deepEqual([...CARD_SIZES], ["compact", "normal", "large"]);
  assert.deepEqual([...HUB_GROUP_BY], ["project", "urgency", "custom", "provider", "repo_worktree", "swimlane"]);
  assert.deepEqual([...TRIAGE_SORT_BY], ["severity", "createdAt"]);
});

test("assertValidLayout rejects wrong version", () => {
  assert.throws(() => assertValidLayout({ version: 2, global: { cardSizeDefault: "normal" }, views: {} }), /version/);
});

test("assertValidLayout rejects bad cardSizeDefault", () => {
  assert.throws(
    () => assertValidLayout({ version: 1, global: { cardSizeDefault: "huge" }, views: {} }),
    /cardSizeDefault/,
  );
});

test("assertValidLayout rejects unknown top-level key", () => {
  assert.throws(
    () => assertValidLayout({ version: 1, global: { cardSizeDefault: "normal" }, views: {}, extra: 1 }),
    /unknown top-level key 'extra'/,
  );
});

test("assertValidLayout rejects unknown views.hub key", () => {
  assert.throws(
    () =>
      assertValidLayout({
        version: 1,
        global: { cardSizeDefault: "normal" },
        views: { hub: { somethingNew: true } },
      }),
    /views\.hub: unknown key 'somethingNew'/,
  );
});

test("assertValidLayout rejects malformed pinnedSessionIds", () => {
  assert.throws(
    () =>
      assertValidLayout({
        version: 1,
        global: { cardSizeDefault: "normal" },
        views: { hub: { pinnedSessionIds: ["not-a-ses"] } },
      }),
    /pinnedSessionIds/,
  );
});

test("assertValidLayout rejects bad visibleKinds", () => {
  assert.throws(
    () =>
      assertValidLayout({
        version: 1,
        global: { cardSizeDefault: "normal" },
        views: { triage: { visibleKinds: ["totally_made_up"] } },
      }),
    /visibleKinds/,
  );
});

test("assertValidLayout rejects bad sortBy", () => {
  assert.throws(
    () =>
      assertValidLayout({
        version: 1,
        global: { cardSizeDefault: "normal" },
        views: { triage: { sortBy: "alphabetical" } },
      }),
    /sortBy/,
  );
});

test("assertValidLayout rejects non-positive dockWidth", () => {
  assert.throws(
    () =>
      assertValidLayout({
        version: 1,
        global: { cardSizeDefault: "normal", dockWidth: 0 },
        views: {},
      }),
    /dockWidth/,
  );
});

test("assertValidLayout rejects bad cardSizeOverride entries", () => {
  assert.throws(
    () =>
      assertValidLayout({
        version: 1,
        global: { cardSizeDefault: "normal" },
        views: { hub: { cardSizeOverride: { "not-a-ses": "compact" } } },
      }),
    /cardSizeOverride/,
  );
  assert.throws(
    () =>
      assertValidLayout({
        version: 1,
        global: { cardSizeDefault: "normal" },
        views: { hub: { cardSizeOverride: { [VALID_SESSION_ID_A]: "gigantic" } } },
      }),
    /cardSizeOverride/,
  );
});

// ---------------------------------------------------------------------------
// LayoutStore.load — defaults & corrupt fallback
// ---------------------------------------------------------------------------

test("LayoutStore.load returns mutable clone of DEFAULT_LAYOUT when no file exists", async () => {
  const ws = await makeWorkspace();
  try {
    const store = new LayoutStore({ workspaceRoot: ws });
    const loaded = await store.load();
    assert.deepEqual(loaded, JSON.parse(JSON.stringify(DEFAULT_LAYOUT)));
    // Mutating the returned object MUST NOT propagate to DEFAULT_LAYOUT.
    loaded.global.cardSizeDefault = "compact";
    assert.equal(DEFAULT_LAYOUT.global.cardSizeDefault, "normal");
    // And a second load is still pristine.
    const again = await store.load();
    assert.equal(again.global.cardSizeDefault, "normal");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("LayoutStore.load falls back to DEFAULT_LAYOUT on corrupt JSON (DoD #4)", async () => {
  const ws = await makeWorkspace();
  try {
    const fp = layoutFilePath(ws);
    await mkdir(path.dirname(fp), { recursive: true });
    await writeFile(fp, "{not json", "utf8");

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const store = new LayoutStore({ workspaceRoot: ws });
      const loaded = await store.load();
      assert.deepEqual(loaded, JSON.parse(JSON.stringify(DEFAULT_LAYOUT)));
      assert.ok(
        warnings.some((w) => w.includes("corrupt JSON") && w.includes(fp)),
        `expected a corrupt-JSON warning; got ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("LayoutStore.load falls back when on-disk JSON is well-formed but invalid", async () => {
  const ws = await makeWorkspace();
  try {
    const fp = layoutFilePath(ws);
    await mkdir(path.dirname(fp), { recursive: true });
    await writeFile(fp, JSON.stringify({ version: 99, global: {}, views: {} }), "utf8");
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const store = new LayoutStore({ workspaceRoot: ws });
      const loaded = await store.load();
      assert.deepEqual(loaded, JSON.parse(JSON.stringify(DEFAULT_LAYOUT)));
    } finally {
      console.warn = origWarn;
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// LayoutStore.save / round-trip / atomic overwrite
// ---------------------------------------------------------------------------

test("LayoutStore.save → load round-trip preserves data", async () => {
  const ws = await makeWorkspace();
  try {
    const store = new LayoutStore({ workspaceRoot: ws });
    const populated = {
      version: 1,
      global: { cardSizeDefault: "compact", dockWidth: 320 },
      views: {
        hub: {
          groupBy: "urgency",
          collapsedGroups: ["g1"],
          pinnedSessionIds: [VALID_SESSION_ID_A],
          cardSizeOverride: { [VALID_SESSION_ID_B]: "large" },
        },
        triage: { visibleKinds: ["blocked", "approval_needed"], sortBy: "severity" },
        project: {},
      },
    };
    await store.save(populated);
    const loaded = await store.load();
    assert.deepEqual(loaded, populated);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("LayoutStore.save second write atomically overwrites the first", async () => {
  const ws = await makeWorkspace();
  try {
    const store = new LayoutStore({ workspaceRoot: ws });
    const a = { version: 1, global: { cardSizeDefault: "compact" }, views: {} };
    const b = { version: 1, global: { cardSizeDefault: "large", dockWidth: 280 }, views: {} };
    await store.save(a);
    await store.save(b);
    const loaded = await store.load();
    assert.deepEqual(loaded, b);
    // No .tmp leftovers in the layouts dir.
    const entries = await readdir(path.dirname(layoutFilePath(ws)));
    assert.deepEqual(entries.filter((e) => e.includes(".tmp")), []);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("layoutFilePath is workspace-local (.runtime/layouts/session-hub.json) — DoD #1", () => {
  const ws = "/tmp/some-ws";
  const fp = layoutFilePath(ws);
  assert.ok(fp.endsWith(path.join(".runtime", "layouts", "session-hub.json")), `got ${fp}`);
  assert.ok(fp.startsWith(ws), `expected ${fp} to start with ${ws}`);
});

// ---------------------------------------------------------------------------
// Per-project subsections live in the SAME file — DoD #3
// ---------------------------------------------------------------------------

test("per-project sections persist inside the single layout file (DoD #3)", async () => {
  const ws = await makeWorkspace();
  try {
    const store = new LayoutStore({ workspaceRoot: ws });
    const layout = {
      version: 1,
      global: { cardSizeDefault: "normal" },
      views: {
        project: {
          foo: { collapsed: true },
          bar: { pinnedSessionIds: [VALID_SESSION_ID_A] },
        },
      },
    };
    await store.save(layout);
    const loaded = await store.load();
    assert.equal(loaded.views.project.foo.collapsed, true);
    assert.deepEqual(loaded.views.project.bar.pinnedSessionIds, [VALID_SESSION_ID_A]);
    // No other JSON files written under .runtime/layouts/.
    const entries = await readdir(path.dirname(layoutFilePath(ws)));
    const jsonFiles = entries.filter((e) => e.endsWith(".json"));
    assert.deepEqual(jsonFiles, ["session-hub.json"], `unexpected layout files: ${JSON.stringify(entries)}`);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

test("GET /api/layouts/session-hub returns 200 with DEFAULT_LAYOUT when no file exists", async () => {
  const ws = await makeWorkspace();
  const { base, close } = await startMiniApp(ws);
  try {
    const res = await fetch(`${base}/api/layouts/session-hub`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.layout, JSON.parse(JSON.stringify(DEFAULT_LAYOUT)));
  } finally {
    await close();
    await rm(ws, { recursive: true, force: true });
  }
});

test("PUT /api/layouts/session-hub accepts a valid layout and GET returns it", async () => {
  const ws = await makeWorkspace();
  const { base, close } = await startMiniApp(ws);
  try {
    const layout = {
      version: 1,
      global: { cardSizeDefault: "large" },
      views: { hub: { groupBy: "swimlane" } },
    };
    const put = await fetch(`${base}/api/layouts/session-hub`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(layout),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.deepEqual(putBody.layout, layout);

    const get = await fetch(`${base}/api/layouts/session-hub`);
    assert.equal(get.status, 200);
    const getBody = await get.json();
    assert.deepEqual(getBody.layout, layout);
  } finally {
    await close();
    await rm(ws, { recursive: true, force: true });
  }
});

test("PUT /api/layouts/session-hub returns 400 LAYOUT_INVALID on bad layout", async () => {
  const ws = await makeWorkspace();
  const { base, close } = await startMiniApp(ws);
  try {
    const res = await fetch(`${base}/api/layouts/session-hub`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, global: { cardSizeDefault: "normal" }, views: {} }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "LAYOUT_INVALID");
    assert.match(body.error.message, /version/);
  } finally {
    await close();
    await rm(ws, { recursive: true, force: true });
  }
});

test("PATCH /api/layouts/session-hub deep-merges partial into existing layout", async () => {
  const ws = await makeWorkspace();
  const { base, close } = await startMiniApp(ws);
  try {
    // Seed with a PUT.
    const seed = {
      version: 1,
      global: { cardSizeDefault: "normal" },
      views: { hub: { groupBy: "project", collapsedGroups: ["g1"] } },
    };
    await fetch(`${base}/api/layouts/session-hub`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seed),
    });

    // PATCH a single deep field.
    const patchRes = await fetch(`${base}/api/layouts/session-hub`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ global: { dockWidth: 360 }, views: { hub: { groupBy: "urgency" } } }),
    });
    assert.equal(patchRes.status, 200);
    const merged = (await patchRes.json()).layout;
    assert.equal(merged.global.cardSizeDefault, "normal", "siblings preserved");
    assert.equal(merged.global.dockWidth, 360, "new key added");
    assert.equal(merged.views.hub.groupBy, "urgency", "leaf overwritten");
    assert.deepEqual(merged.views.hub.collapsedGroups, ["g1"], "sibling sub-key preserved");
  } finally {
    await close();
    await rm(ws, { recursive: true, force: true });
  }
});

test("PATCH /api/layouts/session-hub returns 400 when merge would produce invalid layout", async () => {
  const ws = await makeWorkspace();
  const { base, close } = await startMiniApp(ws);
  try {
    const res = await fetch(`${base}/api/layouts/session-hub`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ global: { cardSizeDefault: "huge" } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "LAYOUT_INVALID");
  } finally {
    await close();
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: layout writes MUST NOT touch runtime-events.jsonl — DoD #5
// ---------------------------------------------------------------------------

test("LayoutStore.save leaves .runtime/runtime-events.jsonl byte-identical (DoD #5)", async () => {
  const ws = await makeWorkspace();
  try {
    const runtimeDir = path.join(ws, ".runtime");
    await mkdir(runtimeDir, { recursive: true });
    const eventsPath = path.join(runtimeDir, "runtime-events.jsonl");
    const seed =
      JSON.stringify({ type: "session.started", id: "evt_seed1", ts: "2024-01-01T00:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "session.status", id: "evt_seed2", ts: "2024-01-01T00:00:01.000Z" }) + "\n";
    await writeFile(eventsPath, seed, "utf8");
    const beforeRaw = await readFile(eventsPath);

    const store = new LayoutStore({ workspaceRoot: ws });
    await store.save({
      version: 1,
      global: { cardSizeDefault: "normal" },
      views: { project: { foo: { collapsed: true } } },
    });

    const afterRaw = await readFile(eventsPath);
    assert.ok(beforeRaw.equals(afterRaw), "runtime-events.jsonl was modified by a layout save");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("layout source files reference no runtime-event-log symbols (DoD #5)", async () => {
  const files = [
    path.join(REPO_ROOT, "hub", "runtime", "layouts.js"),
    path.join(REPO_ROOT, "hub", "api", "layouts.js"),
  ];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    // Strip line/block comments before scanning — TDD-citation comments
    // legitimately mention §23.1 / LayoutUpdatedEvent rationale.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const banned of ["runtime-events.jsonl", "runtimeStore", "appendEvent"]) {
      assert.ok(
        !stripped.includes(banned),
        `${file} must not reference '${banned}' (event-log wiring is forbidden per §23.1)`,
      );
    }
  }
});
