// test/run-session-endpoints.test.js — sh-3-03 (TDD v0.5 §6.7, §8A.1, §12.0)
//
// Acceptance tests for the Run Session HTTP routes. Each test stands up a
// fresh Express app on a kernel-assigned port wired to a stub Store + real
// in-memory draftStore + stub RuntimeProjection. We deliberately do NOT
// boot the full daemon to keep these tests fast and free of the flaky
// daemon-start race tracked in sh-0-09.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { registerRunSessionRoutes } from "../hub/api/run-session.js";
import { createDraftStore } from "../hub/run-session/drafts.js";

function makeStoreStub(projects) {
  const map = new Map();
  for (const [slug, entry] of Object.entries(projects ?? {})) {
    map.set(slug, entry);
  }
  return {
    get(slug) {
      return map.get(slug) ?? null;
    },
  };
}

function makeProjectionStub(sessions = []) {
  return {
    toSnapshots() {
      return { sessions };
    },
  };
}

async function startMiniApp({ projects = {}, sessions = [] } = {}) {
  const store = makeStoreStub(projects);
  const draftStore = createDraftStore();
  const projection = makeProjectionStub(sessions);
  const app = express();
  app.use(express.json());
  registerRunSessionRoutes(app, { store, draftStore, projection });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    draftStore,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function patchJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function task(overrides) {
  return {
    id: overrides.id,
    status: "not_started",
    placement: { swimlaneId: overrides.swimlaneId ?? "lane-a", priorityId: "p1" },
    dependencies: [],
    repos: {
      primary: { root: "/tmp/repo", worktree: "/tmp/wt", allowed_paths: ["src/**"] },
    },
    verify: { items: [{ kind: "test", command: "node --test" }] },
    ...overrides,
  };
}

// --- GET /api/run-candidates --------------------------------------------------

test("GET /api/run-candidates returns scored candidates for a project", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: { tasks: [task({ id: "t1" }), task({ id: "t2" })] },
        rev: 17,
      },
    },
  });
  try {
    const r = await getJson(app.base, "/api/run-candidates?projectSlug=proj");
    assert.equal(r.status, 200);
    assert.equal(r.body.projectSlug, "proj");
    assert.equal(r.body.laneId, null);
    assert.equal(r.body.rev, 17);
    assert.equal(r.body.candidates.length, 2);
    for (const c of r.body.candidates) {
      assert.equal(c.projectSlug, "proj");
      assert.ok(Array.isArray(c.reasons));
      assert.ok(Array.isArray(c.penalties));
    }
  } finally {
    await app.close();
  }
});

test("GET /api/run-candidates with laneId surfaces the +100 lane bonus", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: {
          tasks: [
            task({ id: "t1", swimlaneId: "lane-a" }),
            task({ id: "t2", swimlaneId: "lane-b" }),
          ],
        },
        rev: 1,
      },
    },
  });
  try {
    const r = await getJson(app.base, "/api/run-candidates?projectSlug=proj&laneId=lane-a");
    assert.equal(r.status, 200);
    assert.equal(r.body.laneId, "lane-a");
    const t1 = r.body.candidates.find((c) => c.taskId === "t1");
    const t2 = r.body.candidates.find((c) => c.taskId === "t2");
    assert.ok(t1.score > t2.score, "lane-a task should outscore lane-b task");
    assert.ok(t1.reasons.some((r) => r.includes("in selected lane")));
  } finally {
    await app.close();
  }
});

test("GET /api/run-candidates filters non-runnable tasks", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: {
          tasks: [
            task({ id: "alive" }),
            task({ id: "done", status: "complete" }),
            task({ id: "gone", archived: true }),
          ],
        },
        rev: 1,
      },
    },
  });
  try {
    const r = await getJson(app.base, "/api/run-candidates?projectSlug=proj");
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.candidates.map((c) => c.taskId),
      ["alive"],
    );
  } finally {
    await app.close();
  }
});

test("GET /api/run-candidates rejects missing projectSlug", async () => {
  const app = await startMiniApp();
  try {
    const r = await getJson(app.base, "/api/run-candidates");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_QUERY");
  } finally {
    await app.close();
  }
});

test("GET /api/run-candidates rejects unknown query fields", async () => {
  const app = await startMiniApp({ projects: { proj: { data: { tasks: [] }, rev: 0 } } });
  try {
    const r = await getJson(app.base, "/api/run-candidates?projectSlug=proj&bogus=1");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "UNKNOWN_FIELDS");
    assert.deepEqual(r.body.error.details.unknown, ["bogus"]);
  } finally {
    await app.close();
  }
});

test("GET /api/run-candidates rejects empty laneId", async () => {
  const app = await startMiniApp({ projects: { proj: { data: { tasks: [] }, rev: 0 } } });
  try {
    const r = await getJson(app.base, "/api/run-candidates?projectSlug=proj&laneId=");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_QUERY");
  } finally {
    await app.close();
  }
});

test("GET /api/run-candidates returns 404 for unknown project", async () => {
  const app = await startMiniApp();
  try {
    const r = await getJson(app.base, "/api/run-candidates?projectSlug=missing");
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "UNKNOWN_PROJECT");
  } finally {
    await app.close();
  }
});

// --- POST /api/run-session/draft ---------------------------------------------

test("POST /api/run-session/draft creates a task_backed draft", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    assert.equal(r.status, 201);
    assert.match(r.body.draft.id, /^draft_[0-9a-f]{24}$/);
    assert.equal(r.body.draft.source, "task_card");
    assert.equal(r.body.draft.mode, "task_backed");
    assert.equal(r.body.draft.taskId, "t1");
    assert.equal(r.body.draft.taskLocked, true);
    assert.ok(typeof r.body.draft.expiresAt === "string");
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/draft creates an untasked draft", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/draft", {
      source: "global_new_session",
      mode: "untasked",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.draft.mode, "untasked");
    assert.equal(r.body.draft.taskId, null);
    assert.equal(r.body.draft.taskLocked, false);
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/draft rejects non-object body", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/draft", [1, 2]);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/draft rejects unknown source", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/draft", {
      source: "telepathy",
      mode: "untasked",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
    assert.ok(Array.isArray(r.body.error.details.allowedSources));
    assert.ok(Array.isArray(r.body.error.details.allowedModes));
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/draft rejects task_backed without taskId", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/draft rejects client-supplied id/createdAt", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/draft", {
      id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      source: "cli",
      mode: "untasked",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});

// --- GET /api/run-session/drafts/:draftId ------------------------------------

test("GET /api/run-session/drafts/:id returns a stored draft", async () => {
  const app = await startMiniApp();
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "hub_run",
      mode: "untasked",
    });
    const r = await getJson(app.base, `/api/run-session/drafts/${created.body.draft.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.draft.id, created.body.draft.id);
  } finally {
    await app.close();
  }
});

test("GET /api/run-session/drafts/:id rejects malformed ids", async () => {
  const app = await startMiniApp();
  try {
    const r = await getJson(app.base, "/api/run-session/drafts/not-a-draft");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_DRAFT_ID");
  } finally {
    await app.close();
  }
});

test("GET /api/run-session/drafts/:id returns 404 for unknown draft", async () => {
  const app = await startMiniApp();
  try {
    const r = await getJson(
      app.base,
      "/api/run-session/drafts/draft_aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "UNKNOWN_DRAFT");
  } finally {
    await app.close();
  }
});

// --- PATCH /api/run-session/drafts/:draftId ----------------------------------

test("PATCH /api/run-session/drafts/:id updates mutable fields", async () => {
  const app = await startMiniApp();
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
    });
    const r = await patchJson(app.base, `/api/run-session/drafts/${created.body.draft.id}`, {
      runtime: "codex_app_server",
      providerId: "anthropic",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.draft.runtime, "codex_app_server");
    assert.equal(r.body.draft.providerId, "anthropic");
    assert.equal(r.body.draft.id, created.body.draft.id);
    assert.equal(r.body.draft.createdAt, created.body.draft.createdAt);
  } finally {
    await app.close();
  }
});

test("PATCH /api/run-session/drafts/:id rejects immutable id mutation", async () => {
  const app = await startMiniApp();
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
    });
    const r = await patchJson(app.base, `/api/run-session/drafts/${created.body.draft.id}`, {
      id: "draft_bbbbbbbbbbbbbbbbbbbbbbbb",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});

test("PATCH /api/run-session/drafts/:id returns 404 for unknown draft", async () => {
  const app = await startMiniApp();
  try {
    const r = await patchJson(
      app.base,
      "/api/run-session/drafts/draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      { runtime: "manual" },
    );
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "UNKNOWN_DRAFT");
  } finally {
    await app.close();
  }
});

test("PATCH /api/run-session/drafts/:id rejects malformed ids", async () => {
  const app = await startMiniApp();
  try {
    const r = await patchJson(app.base, "/api/run-session/drafts/abc", { runtime: "manual" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_DRAFT_ID");
  } finally {
    await app.close();
  }
});

// --- POST /api/run-session/launch (stub) -------------------------------------

test("POST /api/run-session/launch returns 501 LAUNCH_NOT_AVAILABLE for a valid body", async () => {
  const app = await startMiniApp();
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
      expectedTrackerRev: 12,
      claimMode: "fail_if_active",
    });
    assert.equal(r.status, 501);
    assert.equal(r.body.error.code, "LAUNCH_NOT_AVAILABLE");
    assert.ok(Array.isArray(r.body.error.details.pendingTasks));
    assert.ok(r.body.error.details.pendingTasks.includes("sh-3-05"));
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch rejects a missing draftId", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/launch", {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch rejects an invalid claimMode", async () => {
  const app = await startMiniApp();
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "cli",
      mode: "untasked",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
      claimMode: "yolo",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
    assert.ok(r.body.error.details.allowed.includes("force"));
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch rejects unknown body fields", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      whyNot: true,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "UNKNOWN_FIELDS");
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch returns 404 for unknown draft", async () => {
  const app = await startMiniApp();
  try {
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "UNKNOWN_DRAFT");
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch rejects non-integer expectedTrackerRev", async () => {
  const app = await startMiniApp();
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "cli",
      mode: "untasked",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
      expectedTrackerRev: "twelve",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});
