// test/run-session-endpoints.test.js — sh-3-03 + sh-3-05 (TDD v0.5 §6.7, §8A.1, §12.0)
//
// Acceptance tests for the Run Session HTTP routes. Each test stands up a
// fresh Express app on a kernel-assigned port wired to a stub Store + real
// in-memory draftStore + RuntimeProjection. We deliberately do NOT
// boot the full daemon to keep these tests fast and free of the flaky
// daemon-start race tracked in sh-0-09.
//
// sh-3-05: the launch endpoint is now live (was 501 LAUNCH_NOT_AVAILABLE).
// startMiniApp grows a real RuntimeStore + JobRegistry + RunSessionService
// so the launch tests exercise the full HTTP→service path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { registerRunSessionRoutes } from "../hub/api/run-session.js";
import { createDraftStore } from "../hub/run-session/drafts.js";
import { RunSessionService } from "../hub/run-session/service.js";
import { JobRegistry } from "../hub/jobs/registry.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

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

function fixedClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  return now;
}

async function startMiniApp({ projects = {}, draftStoreOptions = {} } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-rs-endpoint-"));
  const store = makeStoreStub(projects);
  const draftStore = createDraftStore(draftStoreOptions);
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appendedEvents.push(event);
      projection.apply(event);
    },
  });
  const jobRegistry = new JobRegistry({
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  const runSessionService = new RunSessionService({
    store,
    draftStore,
    projection,
    jobRegistry,
    runtimeStore,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  const app = express();
  app.use(express.json());
  registerRunSessionRoutes(app, { store, draftStore, projection, jobRegistry, runSessionService });
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
    projection,
    jobRegistry,
    appendedEvents,
    close: async () => {
      await new Promise((r) => server.close(() => r()));
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
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
    verify: { items: [{ kind: "command", id: "lt.test", required: true, cmd: "node --test" }] },
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

test("GET /api/run-candidates includes active-job penalties from JobRegistry", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: { tasks: [task({ id: "t1" }), task({ id: "t2" })] },
        rev: 17,
      },
    },
  });
  try {
    const draft = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const launch = await postJson(app.base, "/api/run-session/launch", {
      draftId: draft.body.draft.id,
    });
    assert.equal(launch.status, 201);

    const r = await getJson(app.base, "/api/run-candidates?projectSlug=proj");
    assert.equal(r.status, 200);
    const t1 = r.body.candidates.find((c) => c.taskId === "t1");
    assert.ok(t1.penalties.some((p) => p.includes("task already has active job")));
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

test("GET /api/run-session/drafts/:id returns 404 for expired drafts", async () => {
  const now = fixedClock();
  const app = await startMiniApp({ draftStoreOptions: { now, ttlMs: 1000 } });
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "hub_run",
      mode: "untasked",
    });
    now.advance(1000);
    const r = await getJson(app.base, `/api/run-session/drafts/${created.body.draft.id}`);
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

test("PATCH /api/run-session/drafts/:id rejects non-object body", async () => {
  const app = await startMiniApp();
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
    });
    const r = await patchJson(app.base, `/api/run-session/drafts/${created.body.draft.id}`, [
      "bad",
    ]);
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

test("PATCH /api/run-session/drafts/:id returns 404 for expired drafts", async () => {
  const now = fixedClock();
  const app = await startMiniApp({ draftStoreOptions: { now, ttlMs: 1000 } });
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
    });
    now.advance(1000);
    const r = await patchJson(app.base, `/api/run-session/drafts/${created.body.draft.id}`, {
      runtime: "manual",
    });
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

// --- POST /api/run-session/launch (live, sh-3-05) ---------------------------

test("POST /api/run-session/launch — task_backed happy path returns 201 with mode=created and well-formed ids", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: { tasks: [task({ id: "t1" })] },
        rev: 0,
      },
    },
  });
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
      claimMode: "fail_if_active",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.mode, "created");
    assert.match(r.body.sessionId, /^ses_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.match(r.body.jobId, /^job_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(r.body.taskClaimed, true);

    // The session + job appear on the registry/projection.
    assert.equal(app.projection.sessions.get(r.body.sessionId)?.id, r.body.sessionId);
    assert.equal(app.jobRegistry.get(r.body.jobId)?.id, r.body.jobId);
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch — stale expectedTrackerRev returns 409 STALE_TRACKER_REV with currentRev", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: { tasks: [task({ id: "t1" })] },
        rev: 5,
      },
    },
  });
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
      expectedTrackerRev: 4,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "STALE_TRACKER_REV");
    assert.equal(r.body.error.details.currentRev, 5);
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch — fail_if_active with an active job returns 409 TASK_CLAIM_CONFLICT with activeJobId", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: { tasks: [task({ id: "t1" })] },
        rev: 0,
      },
    },
  });
  try {
    const first = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const seeded = await postJson(app.base, "/api/run-session/launch", {
      draftId: first.body.draft.id,
    });
    assert.equal(seeded.status, 201);

    const second = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: second.body.draft.id,
      claimMode: "fail_if_active",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "TASK_CLAIM_CONFLICT");
    assert.equal(r.body.error.details.activeJobId, seeded.body.jobId);
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch — claimMode=force with forceReason returns 201; sessions/jobs lists reflect both records", async () => {
  const app = await startMiniApp({
    projects: {
      proj: {
        data: { tasks: [task({ id: "t1" })] },
        rev: 0,
      },
    },
  });
  try {
    // Seed an active job so force has something to override.
    const firstDraft = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const seeded = await postJson(app.base, "/api/run-session/launch", {
      draftId: firstDraft.body.draft.id,
    });
    assert.equal(seeded.status, 201);

    const forceDraft = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: forceDraft.body.draft.id,
      claimMode: "force",
      forceReason: "operator override",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.mode, "created");

    // Registry sees both jobs; projection sees both sessions.
    assert.equal(app.jobRegistry.list().length, 2);
    assert.equal(app.projection.toSnapshots().sessions.length, 2);
    assert.equal(app.jobRegistry.get(seeded.body.jobId).status, "cancelled");
    assert.equal(app.jobRegistry.get(r.body.jobId).status, "running");
    assert.equal(app.jobRegistry.get(r.body.jobId).predecessorJobId, undefined);

    // human.override event was appended through the launch path.
    const overrides = app.appendedEvents.filter((e) => e.type === "human.override");
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].source, "http");
    assert.equal(app.appendedEvents.filter((e) => e.type === "job.queued").length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/run-session/launch — claimMode=force without forceReason returns 400 INVALID_BODY", async () => {
  const app = await startMiniApp({
    projects: { proj: { data: { tasks: [task({ id: "t1" })] }, rev: 0 } },
  });
  try {
    const draft = await postJson(app.base, "/api/run-session/draft", {
      source: "task_card",
      mode: "task_backed",
      taskId: "t1",
      projectSlug: "proj",
    });
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: draft.body.draft.id,
      claimMode: "force",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_BODY");
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

test("POST /api/run-session/launch returns 404 for expired drafts", async () => {
  const now = fixedClock();
  const app = await startMiniApp({ draftStoreOptions: { now, ttlMs: 1000 } });
  try {
    const created = await postJson(app.base, "/api/run-session/draft", {
      source: "cli",
      mode: "untasked",
    });
    now.advance(1000);
    const r = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
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
    const negative = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
      expectedTrackerRev: -1,
    });
    assert.equal(negative.status, 400);
    assert.equal(negative.body.error.code, "INVALID_BODY");
    const fractional = await postJson(app.base, "/api/run-session/launch", {
      draftId: created.body.draft.id,
      expectedTrackerRev: 1.5,
    });
    assert.equal(fractional.status, 400);
    assert.equal(fractional.body.error.code, "INVALID_BODY");
  } finally {
    await app.close();
  }
});
