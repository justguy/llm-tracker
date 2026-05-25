// test/run-session-drafts.test.js — sh-3-01 (TDD v0.5 §6.7, §23.2 #33)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDraftStore,
  makeDraftId,
  isRunSessionDraftId,
  DRAFT_ID_PATTERN,
  RUN_SESSION_DRAFT_SOURCES,
  RUN_SESSION_DRAFT_MODES,
  RUN_SESSION_DRAFT_SANDBOXES,
  RUN_SESSION_DRAFT_CLAIM_MODES,
} from "../hub/run-session/drafts.js";
import { defaultProviderCapabilities } from "../hub/providers/capabilities.js";

function fixedClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  now.set = (ms) => {
    t = ms;
    return t;
  };
  return now;
}

const TASK_BACKED = Object.freeze({
  source: "task_card",
  mode: "task_backed",
  taskId: "sh-3-01",
});

test("source/mode enums match TDD §6.7 v0.7 shape", () => {
  assert.deepEqual(
    [...RUN_SESSION_DRAFT_SOURCES],
    ["task_card", "swimlane_next", "hub_run", "global_new_session", "attach", "cli"],
  );
  assert.deepEqual([...RUN_SESSION_DRAFT_MODES], ["task_backed", "untasked", "attach_existing"]);
});

test("extended enum constants match v0.7 RunSessionDraft fields", () => {
  assert.deepEqual([...RUN_SESSION_DRAFT_SANDBOXES], ["readonly", "workspace-write", "autoedit", "full-auto"]);
  assert.deepEqual([...RUN_SESSION_DRAFT_CLAIM_MODES], ["fail_if_active", "join", "force"]);
});

test("makeDraftId returns a value that matches DRAFT_ID_PATTERN", () => {
  const id = makeDraftId();
  assert.match(id, DRAFT_ID_PATTERN);
  assert.equal(isRunSessionDraftId(id), true);
});

test("isRunSessionDraftId rejects non-strings and malformed ids", () => {
  for (const bad of [null, undefined, 42, "", "draft_", "draft_short", "ses_abc", { id: "draft_x" }]) {
    assert.equal(isRunSessionDraftId(bad), false);
  }
});

test("create returns a frozen draft with id, createdAt, expiresAt + 30 min default", () => {
  const now = fixedClock();
  const store = createDraftStore({ now });
  const draft = store.create(TASK_BACKED);

  assert.match(draft.id, DRAFT_ID_PATTERN);
  assert.equal(draft.source, "task_card");
  assert.equal(draft.mode, "task_backed");
  assert.equal(draft.taskId, "sh-3-01");
  assert.equal(draft.createdAt, new Date(now()).toISOString());
  assert.equal(Date.parse(draft.expiresAt) - Date.parse(draft.createdAt), 30 * 60 * 1000);
  assert.equal(draft.providerId, null);
  assert.equal(draft.model, null);
  assert.equal(draft.sandbox, null);
  assert.equal(draft.worktreePath, null);
  assert.equal(draft.branch, null);
  assert.equal(draft.capabilityPreview, null);
  assert.equal(draft.claimMode, "fail_if_active");
  assert.equal(draft.expectedTrackerRev, null);
  assert.equal(draft.refreshContext, false);
  assert.equal(draft.newTaskFormDraft, null);
  assert.equal(Object.isFrozen(draft), true);
});

test("create accepts and freezes v0.7 provider/worktree/preflight fields", () => {
  const store = createDraftStore({ now: fixedClock() });
  const capabilityPreview = { ...defaultProviderCapabilities(), rawStdio: true, directContextInjection: true };
  const draft = store.create({
    ...TASK_BACKED,
    providerId: "codex_cli",
    model: "gpt-5-codex",
    sandbox: "workspace-write",
    worktreePath: "/tmp/lt-worktree",
    branch: "feature/run-session",
    capabilityPreview,
    claimMode: "join",
    expectedTrackerRev: 273,
    refreshContext: true,
  });

  assert.equal(draft.providerId, "codex_cli");
  assert.equal(draft.model, "gpt-5-codex");
  assert.equal(draft.sandbox, "workspace-write");
  assert.equal(draft.worktreePath, "/tmp/lt-worktree");
  assert.equal(draft.branch, "feature/run-session");
  assert.equal(draft.capabilityPreview.rawStdio, true);
  assert.equal(draft.capabilityPreview.directContextInjection, true);
  assert.equal(Object.isFrozen(draft.capabilityPreview), true);
  assert.equal(draft.claimMode, "join");
  assert.equal(draft.expectedTrackerRev, 273);
  assert.equal(draft.refreshContext, true);

  capabilityPreview.rawStdio = false;
  assert.equal(store.get(draft.id).capabilityPreview.rawStdio, true);
});

test("create defaults taskLocked=true for task_card+task_backed, false otherwise", () => {
  const store = createDraftStore({ now: fixedClock() });
  const fromCard = store.create({ source: "task_card", mode: "task_backed", taskId: "t1" });
  const fromSwimlane = store.create({ source: "swimlane_next", mode: "task_backed", taskId: "t2" });
  const untasked = store.create({ source: "hub_run", mode: "untasked" });
  const attach = store.create({ source: "attach", mode: "attach_existing" });

  assert.equal(fromCard.taskLocked, true);
  assert.equal(fromSwimlane.taskLocked, false);
  assert.equal(untasked.taskLocked, false);
  assert.equal(attach.taskLocked, false);
});

test("create honors an explicit taskLocked override", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create({ ...TASK_BACKED, taskLocked: false });
  assert.equal(draft.taskLocked, false);
});

test("create rejects bad source/mode/input shapes", () => {
  const store = createDraftStore({ now: fixedClock() });
  assert.throws(() => store.create(null), /must be an object/);
  assert.throws(() => store.create({}), /source must be one of/);
  assert.throws(() => store.create({ source: "task_card" }), /mode must be one of/);
  assert.throws(
    () => store.create({ source: "task_card", mode: "task_backed" }),
    /taskId is required when mode === "task_backed"/,
  );
  assert.throws(
    () => store.create({ source: "task_card", mode: "untasked", taskId: "t1" }),
    /taskId must be null\/absent/,
  );
  assert.throws(
    () => store.create({ source: "blog_post", mode: "task_backed", taskId: "t1" }),
    /source must be one of/,
  );
  assert.throws(
    () => store.create({ source: "task_card", mode: "task_backed", taskId: "" }),
    /taskId is required/,
  );
});

test("create rejects invalid v0.7 provider/worktree/preflight fields", () => {
  const store = createDraftStore({ now: fixedClock() });
  assert.throws(() => store.create({ ...TASK_BACKED, providerId: "" }), /providerId/);
  assert.throws(() => store.create({ ...TASK_BACKED, model: "" }), /model/);
  assert.throws(() => store.create({ ...TASK_BACKED, sandbox: "wide-open" }), /sandbox must be one of/);
  assert.throws(() => store.create({ ...TASK_BACKED, worktreePath: "" }), /worktreePath/);
  assert.throws(() => store.create({ ...TASK_BACKED, branch: "" }), /branch/);
  assert.throws(
    () => store.create({ ...TASK_BACKED, capabilityPreview: { rawStdio: "yes" } }),
    /rawStdio must be boolean/,
  );
  assert.throws(() => store.create({ ...TASK_BACKED, claimMode: "steal" }), /claimMode must be one of/);
  assert.throws(() => store.create({ ...TASK_BACKED, expectedTrackerRev: -1 }), /expectedTrackerRev/);
  assert.throws(() => store.create({ ...TASK_BACKED, expectedTrackerRev: 1.5 }), /expectedTrackerRev/);
  assert.throws(() => store.create({ ...TASK_BACKED, refreshContext: "yes" }), /refreshContext/);
});

test("get returns null for unknown / malformed ids", () => {
  const store = createDraftStore({ now: fixedClock() });
  assert.equal(store.get("draft_does_not_exist"), null);
  assert.equal(store.get("not-a-draft-id"), null);
  assert.equal(store.get(null), null);
});

test("get round-trips a created draft", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create(TASK_BACKED);
  assert.deepEqual(store.get(draft.id), draft);
});

test("get returns null past expiresAt and evicts from the store", () => {
  const now = fixedClock();
  const store = createDraftStore({ now, ttlMs: 1000 });
  const draft = store.create(TASK_BACKED);
  now.advance(1000);
  assert.equal(store.get(draft.id), null);
  assert.equal(store.size, 0);
});

test("get returns the draft right before expiry", () => {
  const now = fixedClock();
  const store = createDraftStore({ now, ttlMs: 1000 });
  const draft = store.create(TASK_BACKED);
  now.advance(999);
  assert.equal(store.get(draft.id)?.id, draft.id);
});

test("update merges patch and re-validates the v0.7 invariants", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create(TASK_BACKED);
  const next = store.update(draft.id, { profileId: "fast", warnings: [{ kind: "verify_pack_empty", severity: "medium" }] });
  assert.equal(next.id, draft.id);
  assert.equal(next.createdAt, draft.createdAt);
  assert.equal(next.expiresAt, draft.expiresAt);
  assert.equal(next.profileId, "fast");
  assert.equal(next.warnings.length, 1);
  assert.equal(Object.isFrozen(next.warnings), true);
  assert.throws(
    () => next.warnings.push({ kind: "missing_repo_metadata", severity: "medium" }),
    /Cannot|read only|not extensible/,
  );
  assert.equal(store.get(draft.id).warnings.length, 1);
  assert.equal(Object.isFrozen(next), true);
});

test("update can set, clear, and revalidate extended launch fields", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create(TASK_BACKED);
  const updated = store.update(draft.id, {
    providerId: "generic_pty",
    model: "local",
    sandbox: "readonly",
    worktreePath: "/tmp/repo-wt",
    branch: "review/sh-3-17",
    capabilityPreview: { rawStdio: true },
    claimMode: "force",
    expectedTrackerRev: 42,
    refreshContext: true,
  });

  assert.equal(updated.providerId, "generic_pty");
  assert.equal(updated.model, "local");
  assert.equal(updated.sandbox, "readonly");
  assert.equal(updated.worktreePath, "/tmp/repo-wt");
  assert.equal(updated.branch, "review/sh-3-17");
  assert.deepEqual(updated.capabilityPreview, { rawStdio: true });
  assert.equal(updated.claimMode, "force");
  assert.equal(updated.expectedTrackerRev, 42);
  assert.equal(updated.refreshContext, true);

  const cleared = store.update(draft.id, {
    providerId: null,
    model: null,
    sandbox: null,
    worktreePath: null,
    branch: null,
    capabilityPreview: null,
    expectedTrackerRev: null,
    refreshContext: false,
  });
  assert.equal(cleared.providerId, null);
  assert.equal(cleared.model, null);
  assert.equal(cleared.sandbox, null);
  assert.equal(cleared.worktreePath, null);
  assert.equal(cleared.branch, null);
  assert.equal(cleared.capabilityPreview, null);
  assert.equal(cleared.claimMode, "force");
  assert.equal(cleared.expectedTrackerRev, null);
  assert.equal(cleared.refreshContext, false);

  assert.throws(() => store.update(draft.id, { sandbox: "wide-open" }), /sandbox must be one of/);
});

test("update can transition task_backed -> untasked when taskId is cleared", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create(TASK_BACKED);
  const next = store.update(draft.id, { mode: "untasked", taskId: null });
  assert.equal(next.mode, "untasked");
  assert.equal(next.taskId, null);
});

test("update rejects illegal mode/taskId combinations", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create(TASK_BACKED);
  assert.throws(
    () => store.update(draft.id, { mode: "untasked" }),
    /taskId must be null\/absent/,
  );
  assert.throws(
    () => store.update(draft.id, { mode: "task_backed", taskId: null }),
    /taskId is required/,
  );
});

test("update rejects mutations of id/createdAt/expiresAt", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create(TASK_BACKED);
  assert.throws(() => store.update(draft.id, { id: "draft_xxxxxxxxxxxxxxxxxxxxxxxx" }), /immutable/);
  assert.throws(() => store.update(draft.id, { createdAt: "1970-01-01T00:00:00.000Z" }), /immutable/);
  assert.throws(() => store.update(draft.id, { expiresAt: "1970-01-01T00:00:00.000Z" }), /immutable/);
});

test("update throws for unknown/malformed/expired ids", () => {
  const now = fixedClock();
  const store = createDraftStore({ now, ttlMs: 1000 });
  assert.throws(() => store.update("not-a-draft", {}), /invalid draft id/);
  assert.throws(() => store.update("draft_aaaaaaaaaaaaaaaaaaaaaaaa", {}), /not found/);
  const draft = store.create(TASK_BACKED);
  now.advance(1001);
  assert.throws(() => store.update(draft.id, { profileId: "x" }), /expired/);
});

test("delete removes a draft and is idempotent", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create(TASK_BACKED);
  assert.equal(store.delete(draft.id), true);
  assert.equal(store.delete(draft.id), false);
  assert.equal(store.get(draft.id), null);
  assert.equal(store.delete("not-a-draft"), false);
});

test("sweep removes only expired drafts and reports the count", () => {
  const now = fixedClock();
  const store = createDraftStore({ now, ttlMs: 1000 });
  const a = store.create(TASK_BACKED);
  now.advance(500);
  const b = store.create({ source: "hub_run", mode: "untasked" });
  now.advance(600); // a expired (1100ms after creation), b still alive (600ms in)
  const removed = store.sweep();
  assert.equal(removed, 1);
  assert.equal(store.get(a.id), null);
  assert.equal(store.get(b.id)?.id, b.id);
});

test("store instances are independent (no shared module-level state)", () => {
  const s1 = createDraftStore({ now: fixedClock() });
  const s2 = createDraftStore({ now: fixedClock() });
  const d1 = s1.create(TASK_BACKED);
  assert.equal(s2.get(d1.id), null);
  assert.equal(s2.size, 0);
  assert.equal(s1.size, 1);
});

test("createDraftStore rejects bad ttlMs / now overrides", () => {
  assert.throws(() => createDraftStore({ ttlMs: 0 }), /ttlMs must be a positive number/);
  assert.throws(() => createDraftStore({ ttlMs: -1 }), /ttlMs must be a positive number/);
  assert.throws(() => createDraftStore({ ttlMs: Number.NaN }), /ttlMs must be a positive number/);
  assert.throws(() => createDraftStore({ now: "not-a-fn" }), /now must be a function/);
});

test("attach_existing draft works without taskId", () => {
  const store = createDraftStore({ now: fixedClock() });
  const draft = store.create({ source: "attach", mode: "attach_existing" });
  assert.equal(draft.mode, "attach_existing");
  assert.equal(draft.taskId, null);
  assert.equal(draft.taskLocked, false);
});

test("NewTaskFormDraft slot is frozen and blocks task_backed launch shape until promoted", () => {
  const store = createDraftStore({ now: fixedClock() });
  const input = {
    source: "global_new_session",
    mode: "untasked",
    newTaskFormDraft: {
      title: "Add launch task",
      projectSlug: "llm-tracker",
      lane: "track-2-run-session",
      priority: "p1",
      dod: ["Create durable task before launch"],
    },
  };
  const draft = store.create(input);

  assert.deepEqual(draft.newTaskFormDraft, input.newTaskFormDraft);
  assert.equal(Object.isFrozen(draft.newTaskFormDraft), true);
  assert.equal(Object.isFrozen(draft.newTaskFormDraft.dod), true);
  input.newTaskFormDraft.dod.push("mutate caller");
  assert.equal(store.get(draft.id).newTaskFormDraft.dod.length, 1);

  assert.throws(
    () => store.create({ ...TASK_BACKED, newTaskFormDraft: input.newTaskFormDraft }),
    /must be promoted to a durable taskId/,
  );
  assert.throws(
    () => store.update(draft.id, { mode: "task_backed", taskId: "sh-3-24" }),
    /must be promoted to a durable taskId/,
  );

  const promoted = store.update(draft.id, {
    mode: "task_backed",
    taskId: "sh-3-24",
    newTaskFormDraft: null,
  });
  assert.equal(promoted.mode, "task_backed");
  assert.equal(promoted.taskId, "sh-3-24");
  assert.equal(promoted.newTaskFormDraft, null);
});

test("NewTaskFormDraft rejects invalid transient task forms", () => {
  const store = createDraftStore({ now: fixedClock() });
  const base = { source: "global_new_session", mode: "untasked" };
  assert.throws(() => store.create({ ...base, newTaskFormDraft: [] }), /must be an object/);
  assert.throws(() => store.create({ ...base, newTaskFormDraft: { projectSlug: "llm-tracker" } }), /title/);
  assert.throws(() => store.create({ ...base, newTaskFormDraft: { title: "x" } }), /projectSlug/);
  assert.throws(
    () => store.create({ ...base, newTaskFormDraft: { title: "x", projectSlug: "llm-tracker", dod: "ship" } }),
    /dod must be an array of strings/,
  );
});

test("warnings array is always present and defensively copied", () => {
  const store = createDraftStore({ now: fixedClock() });
  const input = { ...TASK_BACKED, warnings: [{ kind: "missing_repo_metadata", severity: "medium" }] };
  const draft = store.create(input);
  input.warnings.push({ kind: "verify_pack_empty", severity: "medium" });
  assert.equal(draft.warnings.length, 1);
  assert.equal(Object.isFrozen(draft.warnings), true);
  assert.equal(Object.isFrozen(draft.warnings[0]), true);
  assert.throws(
    () => draft.warnings.push({ kind: "verify_pack_empty", severity: "medium" }),
    /Cannot|read only|not extensible/,
  );
  assert.throws(
    () => {
      draft.warnings[0].severity = "high";
    },
    /Cannot|read only|not extensible/,
  );
  assert.equal(store.get(draft.id).warnings.length, 1);
  assert.equal(store.get(draft.id).warnings[0].severity, "medium");

  const noWarnings = store.create({ source: "hub_run", mode: "untasked" });
  assert.deepEqual(noWarnings.warnings, []);
});

test("warnings reject malformed preflight warning input", () => {
  const store = createDraftStore({ now: fixedClock() });

  assert.throws(() => store.create({ ...TASK_BACKED, warnings: "warn" }), /warnings must be an array/);
  assert.throws(() => store.create({ ...TASK_BACKED, warnings: [null] }), /warnings\[0\] must be an object/);
  assert.throws(
    () => store.create({ ...TASK_BACKED, warnings: [{ kind: "missing_repo_metadata" }] }),
    /severity is invalid/,
  );
  assert.throws(
    () => store.create({ ...TASK_BACKED, warnings: [{ kind: "missing_repo_metadata", severity: "high" }] }),
    /must be one of medium/,
  );
  assert.throws(
    () =>
      store.create({
        ...TASK_BACKED,
        warnings: [{ kind: "shared_worktree", severity: "medium", worktreePath: "/repo" }],
      }),
    /sessionIds/,
  );
  assert.throws(
    () => store.create({ ...TASK_BACKED, warnings: [{ kind: "provider_unavailable", severity: "high" }] }),
    /providerId/,
  );
  assert.throws(
    () =>
      store.create({
        ...TASK_BACKED,
        warnings: [{ kind: "attach_context_overflow", severity: "medium", currentUsed: 100, estBriefTokens: 20 }],
      }),
    /capacity/,
  );
});
