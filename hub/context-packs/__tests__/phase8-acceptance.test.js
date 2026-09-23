import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSessionsRoutes } from "../../api/sessions.js";
import { buildRolloverPack } from "../rollover.js";
import { JobRegistry } from "../../jobs/registry.js";
import { makeRuntimeId } from "../../runtime/ids.js";
import { RuntimeProjection } from "../../runtime/projection.js";
import { RuntimeStore } from "../../runtime/store.js";
import { validateRuntimeEvent } from "../../runtime/events.js";
import { quietTerminalWarning, missingHeartbeatWarning } from "../../sessions/warnings.js";
import {
  buildRestartQuietRequest,
  buildRestartRequest,
  validateRestartQuietRequest,
  validateRestartRequest,
} from "../../../ui/session-hub/RestartModal.js";

test("TDD 20.6: rollover pack is deterministic without the old session object", () => {
  const calls = [];
  const pack = buildRolloverPack(
    {
      now: () => "2026-05-29T00:00:00.000Z",
      job: {
        id: "job_phase8",
        sessionId: "ses_old",
        projectSlug: "demo",
        taskId: "task-1",
        startRev: 42,
      },
      sessionId: "ses_old",
      advisoryHandoff: { oldSessionId: "ses_old", summary: "old-session claim" },
    },
    {
      workspace: "/repo",
      brief: ({ projectSlug, taskId }) => ({ projectSlug, taskId, title: "Task one" }),
      why: ({ projectSlug, taskId }) => ({ projectSlug, taskId, rationale: "important" }),
      execute: ({ projectSlug, taskId }) => ({ projectSlug, taskId, steps: ["do work"] }),
      verify: ({ projectSlug, taskId }) => ({ projectSlug, taskId, checks: ["node --test"] }),
      changed: ({ fromRev }) => {
        calls.push(["changed", fromRev]);
        return { fromRev, tasks: ["task-1"] };
      },
      sinceRev: ({ fromRev }) => {
        calls.push(["sinceRev", fromRev]);
        return { fromRev, events: [{ rev: 43 }] };
      },
      gitEvidence: ({ projectSlug, taskId }) => ({
        projectSlug,
        taskId,
        files: [{ path: "hub/context-packs/rollover.js", status: "M" }],
      }),
    },
  );

  assert.equal(pack.kind, "rollover");
  assert.equal(pack.source, "deterministic");
  assert.equal(pack.generatedAt, "2026-05-29T00:00:00.000Z");
  assert.equal(pack.sessionId, "ses_old");
  assert.deepEqual(calls, [["changed", 42], ["sinceRev", 42]]);

  const sectionById = new Map(pack.sections.map((section) => [section.id, section]));
  assert.equal(sectionById.get("brief").value.title, "Task one");
  assert.equal(sectionById.get("why").value.rationale, "important");
  assert.deepEqual(sectionById.get("execute").value.steps, ["do work"]);
  assert.deepEqual(sectionById.get("verify").value.checks, ["node --test"]);
  assert.equal(sectionById.get("changed").value.fromRev, 42);
  assert.equal(sectionById.get("since_rev").value.fromRev, 42);
  assert.deepEqual(sectionById.get("git").value.files, [
    { path: "hub/context-packs/rollover.js", status: "M" },
  ]);
  assert.equal(sectionById.get("advisory_handoff").sourceId, "tracker.handoff");
  assert.match(
    sectionById.get("advisory_handoff").value.advisoryHandoffLabel,
    /verify against tracker\/git evidence/,
  );
});

test("restart matrix: request builders validate model, sandbox, and quiet-scope presets", () => {
  const model = buildRestartRequest({
    preset: "model",
    model: "gpt-5.4",
    keepCtx: true,
    reason: " upgrade ",
  });
  assert.deepEqual(model, {
    preset: "model",
    keepCtx: true,
    model: "gpt-5.4",
    reason: "upgrade",
  });
  assert.equal(validateRestartRequest(model), null);

  const sandbox = buildRestartRequest({
    preset: "sandbox",
    sandbox: "readonly",
    keepCtx: false,
  });
  assert.deepEqual(sandbox, {
    preset: "sandbox",
    keepCtx: false,
    sandbox: "readonly",
  });
  assert.equal(validateRestartRequest(sandbox), null);
  assert.equal(validateRestartRequest({ preset: "model", model: "" }), "model is required");
  assert.equal(
    validateRestartRequest({ preset: "sandbox", sandbox: "write-everywhere" }),
    "sandbox is required",
  );

  const quiet = buildRestartQuietRequest({ dryRun: true, reason: " quiet only " });
  assert.deepEqual(quiet, { dryRun: true, reason: "quiet only" });
  assert.equal(validateRestartQuietRequest(quiet), null);
  assert.equal(validateRestartQuietRequest({ dryRun: "true" }), "dry run flag is required");
});

test("restart matrix: model and sandbox restarts create successors and roll over predecessors", async () => {
  const h = await makeHarness();
  try {
    const modelSessionId = await seedSession(h, {
      name: "model predecessor",
      model: "gpt-5.3-codex",
      projectSlug: "demo",
      taskId: "task-1",
    });
    const model = await invokeRoute(h.routes, "POST", `/api/sessions/${modelSessionId}/restart`, {
      preset: "model",
      model: "gpt-5.4",
      keepCtx: true,
      reason: "operator model upgrade",
    });
    assert.equal(model.statusCode, 201);
    assert.equal(model.body.ok, true);
    assert.equal(model.body.preset, "model");
    assert.equal(model.body.predecessor.status, "rolled_over");
    assert.equal(model.body.predecessor.successorSessionId, model.body.successorSessionId);
    assert.equal(model.body.successor.predecessorSessionId, modelSessionId);
    assert.equal(model.body.successor.model, "gpt-5.4");
    assert.equal(model.body.rolloverPack.kind, "rollover");
    assert.equal(model.body.rolloverPack.source, "deterministic");
    assert.ok(h.appendedEvents.some((event) =>
      event.type === "session.model_changed" &&
        event.sessionId === model.body.successorSessionId &&
        event.model === "gpt-5.4",
    ));

    const sandboxSessionId = await seedSession(h, {
      name: "sandbox predecessor",
      sandbox: "workspace-write",
      projectSlug: "demo",
      taskId: "task-2",
    });
    const sandbox = await invokeRoute(h.routes, "POST", `/api/sessions/${sandboxSessionId}/restart`, {
      preset: "sandbox",
      sandbox: "readonly",
    });
    assert.equal(sandbox.statusCode, 201);
    assert.equal(sandbox.body.ok, true);
    assert.equal(sandbox.body.preset, "sandbox");
    assert.equal(sandbox.body.predecessor.status, "rolled_over");
    assert.equal(sandbox.body.successor.predecessorSessionId, sandboxSessionId);
    assert.equal(sandbox.body.successor.sandbox, "readonly");
    assert.equal(sandbox.body.pendingApprovalsCarriedOver, false);
    assert.deepEqual(sandbox.body.warnings, [
      { kind: "pending_approvals_not_carried_over", severity: "medium" },
    ]);
    assert.ok(h.appendedEvents.some((event) =>
      event.type === "session.sandbox_changed" &&
        event.sessionId === sandbox.body.successorSessionId &&
        event.sandbox === "readonly",
    ));
  } finally {
    h.close();
  }
});

test("restart matrix: restart-all-quiet scopes only quiet_terminal sessions", async () => {
  const h = await makeHarness();
  try {
    const quietTerminal = await seedSession(h, {
      name: "quiet terminal",
      status: "quiet",
      warning: quietTerminalWarning({ minutes: 11 }),
      projectSlug: "demo",
      taskId: "task-quiet",
    });
    const quietHeartbeat = await seedSession(h, {
      name: "quiet heartbeat",
      tier: "mcp_tracked",
      status: "quiet",
      warning: missingHeartbeatWarning({ minutes: 13 }),
      projectSlug: "demo",
      taskId: "task-heartbeat",
    });
    const activeTerminal = await seedSession(h, {
      name: "active terminal",
      status: "active",
      warning: quietTerminalWarning({ minutes: 15 }),
      projectSlug: "demo",
      taskId: "task-active",
    });
    const contextHighTerminal = await seedSession(h, {
      name: "context high terminal",
      status: "context_high",
      warning: quietTerminalWarning({ minutes: 16 }),
      projectSlug: "demo",
      taskId: "task-context",
    });

    const dryRun = await invokeRoute(h.routes, "POST", "/api/sessions/scope/restart-quiet", {
      dryRun: true,
    });
    assert.equal(dryRun.statusCode, 200);
    assert.equal(dryRun.body.ok, true);
    assert.equal(dryRun.body.dryRun, true);
    assert.deepEqual(dryRun.body.affected.map((item) => item.sessionId), [quietTerminal]);
    assert.deepEqual(dryRun.body.restarted, []);

    const restarted = await invokeRoute(h.routes, "POST", "/api/sessions/scope/restart-quiet", {
      reason: "restart quiet terminals",
    });
    assert.equal(restarted.statusCode, 200);
    assert.equal(restarted.body.ok, true);
    assert.equal(restarted.body.dryRun, false);
    assert.equal(restarted.body.restarted.length, 1);
    assert.equal(restarted.body.restarted[0].sessionId, quietTerminal);
    assert.equal(restarted.body.restarted[0].predecessor.status, "rolled_over");
    assert.equal(restarted.body.restarted[0].successor.predecessorSessionId, quietTerminal);
    assert.equal(restarted.body.restarted[0].rolloverPack.kind, "rollover");

    assert.equal(h.projection.sessions.get(quietTerminal).status, "rolled_over");
    assert.equal(h.projection.sessions.get(quietHeartbeat).status, "quiet");
    assert.equal(h.projection.sessions.get(activeTerminal).status, "active");
    assert.equal(h.projection.sessions.get(contextHighTerminal).status, "context_high");
    assert.ok(!h.projection.sessions.get(quietHeartbeat).successorSessionId);
    assert.ok(!h.projection.sessions.get(activeTerminal).successorSessionId);
    assert.ok(!h.projection.sessions.get(contextHighTerminal).successorSessionId);
  } finally {
    h.close();
  }
});

async function makeHarness() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lt-phase8-"));
  const projection = new RuntimeProjection();
  const appendedEvents = [];
  const runtimeStore = new RuntimeStore({
    workspaceRoot,
    allowClientIds: true,
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
  const routes = [];
  registerSessionsRoutes(routeRecorder(routes), {
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace: workspaceRoot,
    jobRegistry,
    store: { get: () => null },
  });
  return {
    workspaceRoot,
    projection,
    runtimeStore,
    jobRegistry,
    routes,
    appendedEvents,
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

function routeRecorder(routes) {
  const add = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return {
    get: add("GET"),
    post: add("POST"),
    patch: add("PATCH"),
  };
}

async function invokeRoute(routes, method, path, body = {}) {
  const matched = routes
    .filter((route) => route.method === method)
    .map((route) => ({ route, params: matchRoute(route.path, path) }))
    .find((entry) => entry.params);
  assert.ok(matched, `route exists for ${method} ${path}`);

  const req = { params: matched.params, body };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  for (const handler of matched.route.handlers) {
    await new Promise((resolve, reject) => {
      try {
        const result = handler(req, res, (err) => (err ? reject(err) : resolve()));
        if (result && typeof result.then === "function") {
          result.then(resolve, reject);
        } else if (handler.length < 3) {
          resolve(result);
        }
      } catch (err) {
        reject(err);
      }
    });
  }
  return res;
}

function matchRoute(pattern, path) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

async function seedSession(h, {
  name,
  tier = "manual",
  status = "active",
  warning = null,
  projectSlug,
  taskId,
  model,
  sandbox,
} = {}) {
  const sessionId = makeRuntimeId("ses");
  const ts = "2026-05-29T12:00:00.000Z";
  await h.runtimeStore.append({
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts,
    type: "session.started",
    source: "test",
    workspace: h.workspaceRoot,
    session: {
      id: sessionId,
      name,
      tier,
      ...(projectSlug ? { projectSlug } : {}),
      ...(taskId ? { taskId } : {}),
      ...(model ? { model } : {}),
      ...(sandbox ? { sandbox } : {}),
    },
  });
  await h.runtimeStore.append({
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts,
    type: "session.status",
    source: "test",
    workspace: h.workspaceRoot,
    sessionId,
    status,
  });
  if (warning) {
    await h.runtimeStore.append({
      ...{
        schemaVersion: 1,
        id: makeRuntimeId("evt"),
        ts,
        type: "session.warning",
        source: "test",
        workspace: h.workspaceRoot,
        sessionId,
        warning,
      },
    });
  }
  return sessionId;
}
