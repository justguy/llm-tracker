// test/sessions-registry.test.js — SH-2-01 (TDD v0.5 §6.1, §6.2, §6.6, §23.2 #29)
//
// Acceptance suite for SessionRegistry. Each test wires a real RuntimeStore +
// RuntimeProjection so we exercise the full append → onAppend → projection
// pipeline (no mocks at the integration boundary).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SessionRegistry,
  ALLOWED_TIERS,
  ALLOWED_SANDBOX,
  FORBIDDEN_INPUT_FIELDS,
  computeTierFromAdapter,
  assertNoForbiddenFields,
} from "../hub/sessions/registry.js";
import { RuntimeStore } from "../hub/runtime/store.js";
import { RuntimeProjection } from "../hub/runtime/projection.js";
import { makeRuntimeId, SESSION_ID_RE } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

function startEnv() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-sessions-registry-"));
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    onAppend: (event) => {
      appendedEvents.push(event);
      projection.apply(event);
    },
  });
  const registry = new SessionRegistry({
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
  });
  return {
    registry,
    runtimeStore,
    projection,
    workspaceRoot,
    appendedEvents,
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

// --- create ----------------------------------------------------------------

test("SessionRegistry.create: emits session.started; list/get return the record", async () => {
  const env = startEnv();
  try {
    const before = env.registry.list();
    assert.equal(before.length, 0, "fresh registry starts empty");

    const created = await env.registry.create({ name: "smoke", tier: "manual" });
    assert.ok(SESSION_ID_RE.test(created.sessionId), "sessionId is a ses_ ulid");
    assert.equal(typeof created.eventId, "string");
    assert.equal(typeof created.rev, "number");
    assert.ok(created.session, "create returns the projected session");
    assert.equal(created.session.id, created.sessionId);
    assert.equal(created.session.name, "smoke");
    assert.equal(created.session.tier, "manual");

    assert.equal(env.registry.list().length, 1);
    assert.deepEqual(env.registry.get(created.sessionId), created.session);
    assert.equal(env.registry.get("ses_doesnotexist"), null);
    assert.equal(env.registry.get(undefined), null);

    const startedEvts = env.appendedEvents.filter((e) => e.type === "session.started");
    assert.equal(startedEvts.length, 1);
    assert.equal(startedEvts[0].session.id, created.sessionId);
    assert.equal(startedEvts[0].source, "system");
  } finally {
    env.close();
  }
});

test("SessionRegistry.create: validates name + tier + adapter resolution", async () => {
  const env = startEnv();
  try {
    await assert.rejects(env.registry.create({}), /name required/);
    await assert.rejects(env.registry.create({ name: "" }), /name required/);
    await assert.rejects(env.registry.create({ name: "x", tier: "bogus" }), /not in/);

    // Tier inferred from adapter when omitted.
    const inferred = await env.registry.create({ name: "from-adapter", adapter: { kind: "manual" } });
    assert.equal(inferred.session.tier, "manual");
  } finally {
    env.close();
  }
});

test("SessionRegistry.create: v0.7 fields ride through into the session.started event", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create({
      name: "rich",
      tier: "codex_app_server",
      projectSlug: "demo",
      taskId: "t-1",
      sandbox: "workspace-write",
      ctxMax: 200000,
      agent: "codex",
      provider: "codex-app-server",
      model: "gpt-5-1m",
      cwd: "/tmp/demo",
      repoRoot: "/tmp/demo",
      branch: "main",
    });

    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    assert.ok(evt);
    assert.equal(evt.session.sandbox, "workspace-write");
    assert.equal(evt.session.ctxMax, 200000);
    assert.equal(evt.session.agent, "codex");
    assert.equal(evt.session.provider, "codex-app-server");
    assert.equal(evt.session.model, "gpt-5-1m");
    assert.equal(evt.session.cwd, "/tmp/demo");
    assert.equal(evt.session.repoRoot, "/tmp/demo");
    assert.equal(evt.session.branch, "main");
    // projection currently carries the v0.5 subset; v0.7 absorption lands in
    // later tasks (SH-2-21 / SH-2-24). Confirm what is observable today:
    assert.equal(created.session.projectSlug, "demo");
    assert.equal(created.session.taskId, "t-1");
  } finally {
    env.close();
  }
});

test("SessionRegistry.create: rejects activeJobIds (TDD §23.2 #29)", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({ name: "x", tier: "manual", activeJobIds: ["job_xxx"] }),
      (err) => err.code === "FORBIDDEN_FIELD" && err.details.field === "activeJobIds",
    );
    // No event was appended.
    assert.equal(env.appendedEvents.length, 0);
  } finally {
    env.close();
  }
});

test("SessionRegistry.create: rejects boundTasks / now / spark", async () => {
  const env = startEnv();
  try {
    for (const field of ["boundTasks", "now", "spark"]) {
      await assert.rejects(
        env.registry.create({ name: "x", tier: "manual", [field]: field === "spark" ? [1, 2] : { foo: "bar" } }),
        (err) => err.code === "FORBIDDEN_FIELD" && err.details.field === field,
        `expected ${field} to be rejected with FORBIDDEN_FIELD`,
      );
    }
    assert.equal(env.appendedEvents.length, 0);
  } finally {
    env.close();
  }
});

test("SessionRegistry.create: sandbox enum + ctxMax + JobId validation", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.create({ name: "x", tier: "manual", sandbox: "wide-open" }),
      (err) => err.code === "INVALID_SANDBOX",
    );
    await assert.rejects(
      env.registry.create({ name: "x", tier: "manual", ctxMax: 0 }),
      (err) => err.code === "INVALID_CTX_MAX",
    );
    await assert.rejects(
      env.registry.create({ name: "x", tier: "manual", ctxMax: 1.5 }),
      (err) => err.code === "INVALID_CTX_MAX",
    );
    await assert.rejects(
      env.registry.create({ name: "x", tier: "manual", activeJobId: "not-a-job-id" }),
      (err) => err.code === "INVALID_ACTIVE_JOB_ID",
    );
    await assert.rejects(
      env.registry.create({ name: "x", tier: "manual", queuedJobIds: "nope" }),
      (err) => err.code === "INVALID_QUEUED_JOB_IDS",
    );
    await assert.rejects(
      env.registry.create({ name: "x", tier: "manual", queuedJobIds: [42] }),
      (err) => err.code === "INVALID_QUEUED_JOB_IDS",
    );
  } finally {
    env.close();
  }
});

// --- regression: derived fields never reach storage ------------------------

test("SessionRegistry.create: never persists now / spark / activeJobIds in projection or event", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create({
      name: "regression",
      tier: "manual",
      projectSlug: "demo",
      activeJobId: "job_01h00000000000000000000000",
    });
    const session = env.registry.get(created.sessionId);
    assert.ok(session);
    for (const f of ["now", "spark", "activeJobIds", "boundTasks"]) {
      assert.equal(session[f], undefined, `projected SessionRecord must not carry ${f}`);
    }
    const evt = env.appendedEvents.find((e) => e.type === "session.started");
    for (const f of ["now", "spark", "activeJobIds", "boundTasks"]) {
      assert.equal(evt.session[f], undefined, `event.session must not carry ${f}`);
    }
  } finally {
    env.close();
  }
});

// --- updateStatus + archive ------------------------------------------------

test("SessionRegistry.updateStatus: emits session.status, projects new status", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create({ name: "u", tier: "manual" });
    const updated = await env.registry.updateStatus(created.sessionId, {
      status: "active",
      comment: "started typing",
    });
    assert.equal(updated.session.status, "active");
    assert.ok(updated.eventId);
    assert.ok(updated.rev > created.rev);

    const statusEvts = env.appendedEvents.filter((e) => e.type === "session.status");
    assert.equal(statusEvts.length, 1);
    assert.equal(statusEvts[0].sessionId, created.sessionId);
    assert.equal(statusEvts[0].status, "active");
    assert.equal(statusEvts[0].comment, "started typing");
  } finally {
    env.close();
  }
});

test("SessionRegistry.updateStatus: rejects unknown session + bad input", async () => {
  const env = startEnv();
  try {
    await assert.rejects(
      env.registry.updateStatus("ses_01h00000000000000000000000", { status: "active" }),
      (err) => err.code === "UNKNOWN_SESSION",
    );
    const created = await env.registry.create({ name: "u", tier: "manual" });
    await assert.rejects(
      env.registry.updateStatus(created.sessionId, {}),
      (err) => err.code === "INVALID_INPUT" && err.details.field === "status",
    );
    await assert.rejects(
      env.registry.updateStatus(created.sessionId, { status: "active", boundTasks: ["t-1"] }),
      (err) => err.code === "FORBIDDEN_FIELD",
    );
  } finally {
    env.close();
  }
});

test("SessionRegistry.archive: convenience wrapper for status=archived", async () => {
  const env = startEnv();
  try {
    const created = await env.registry.create({ name: "a", tier: "manual" });
    const result = await env.registry.archive(created.sessionId);
    assert.equal(result.session.status, "archived");
    const statusEvts = env.appendedEvents.filter((e) => e.type === "session.status");
    assert.equal(statusEvts.length, 1);
    assert.equal(statusEvts[0].status, "archived");
  } finally {
    env.close();
  }
});

// --- helpers ---------------------------------------------------------------

test("computeTierFromAdapter: explicit tier wins", () => {
  for (const tier of ALLOWED_TIERS) {
    assert.equal(computeTierFromAdapter({ tier }), tier);
  }
  assert.throws(
    () => computeTierFromAdapter({ tier: "bogus" }),
    (err) => err.code === "INVALID_TIER",
  );
});

test("computeTierFromAdapter: capability heuristics map cleanly", () => {
  assert.equal(computeTierFromAdapter(), "dumb_terminal");
  assert.equal(computeTierFromAdapter({}), "dumb_terminal");
  assert.equal(computeTierFromAdapter({ kind: "manual" }), "manual");
  assert.equal(
    computeTierFromAdapter({ capabilities: { explicitTrackerMcp: true } }),
    "mcp_tracked",
  );
  assert.equal(
    computeTierFromAdapter({ capabilities: { rawStdio: true } }),
    "dumb_terminal",
  );
  assert.equal(
    computeTierFromAdapter({ capabilities: { structuredTurns: true } }),
    "codex_app_server",
  );
  assert.equal(
    computeTierFromAdapter({ capabilities: { structuredTurns: true, rawStdio: true } }),
    "hybrid",
  );
});

test("assertNoForbiddenFields: throws for each forbidden field; no-ops for safe inputs", () => {
  // No-ops for objects without forbidden keys, non-objects, arrays, null.
  for (const safe of [null, undefined, "str", 42, [], {}, { name: "ok" }]) {
    assertNoForbiddenFields(safe, "test");
  }
  for (const f of FORBIDDEN_INPUT_FIELDS) {
    assert.throws(
      () => assertNoForbiddenFields({ [f]: "x" }, "test"),
      (err) => err.code === "FORBIDDEN_FIELD" && err.details.field === f,
    );
  }
});

test("ALLOWED_TIERS / ALLOWED_SANDBOX exposed for callers", () => {
  assert.ok(Object.isFrozen(ALLOWED_TIERS));
  assert.ok(Object.isFrozen(ALLOWED_SANDBOX));
  assert.deepEqual([...ALLOWED_TIERS].sort(), [
    "codex_app_server",
    "dumb_terminal",
    "hybrid",
    "manual",
    "mcp_tracked",
  ]);
  assert.deepEqual([...ALLOWED_SANDBOX].sort(), [
    "autoedit",
    "full-auto",
    "readonly",
    "workspace-write",
  ]);
});
