// test/sessions-activity.test.js — SH-2-10 (TDD v0.5 §8.2, §23.2 #4, §25)
//
// Acceptance suite for ActivityMonitor:
//   - §25 threshold defaults are frozen literals (regression net).
//   - Per-tier derivation matches §8.2 verbatim (terminal pass-through,
//     explicit-source pass-through, dumb_terminal → quiet_terminal,
//     mcp_tracked → missing_heartbeat).
//   - `deriveActivityWithSeverity` promotes dumb-terminal quiet to "high"
//     past the escalate threshold and NEVER produces `approval_needed`
//     (per §23.2 #4).
//   - `ActivityMonitor.tick` emits `session.status` ONLY on state change.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_THRESHOLDS,
  TERMINAL_STATES,
  ActivityMonitor,
  deriveActivity,
  deriveActivityWithSeverity,
  expectsHeartbeat,
  hasExplicitStructuredState,
  isInitialStartedState,
  processExited,
  minutesSince,
} from "../hub/sessions/activity.js";

const WORKSPACE = "/tmp/lt-sessions-activity-test";

// Fixed reference now-time used across the deterministic tests.
const NOW = new Date("2026-01-01T12:00:00.000Z");

/** Build an ISO timestamp `minutes` before NOW. */
function isoMinutesAgo(minutes) {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** Minimal session shape used by deriveActivity. */
function makeSession(overrides) {
  return {
    id: "ses_01h00000000000000000000000",
    name: "t",
    tier: "manual",
    status: "active",
    warnings: [],
    ...overrides,
  };
}

// --- thresholds ------------------------------------------------------------

test("DEFAULT_THRESHOLDS matches TDD §25 verbatim and is frozen", () => {
  assert.ok(Object.isFrozen(DEFAULT_THRESHOLDS));
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    heartbeatEveryMinutes: 5,
    missingHeartbeatAfterMinutes: 12,
    dumbTerminalQuietAfterMinutes: 10,
    dumbTerminalQuietEscalateAfterMinutes: 25,
    appServerDisconnectedWarningAfterSeconds: 60,
    contextHighPercent: 85,
  });
});

test("TERMINAL_STATES is frozen and lists archived/done/stopped", () => {
  assert.ok(Object.isFrozen(TERMINAL_STATES));
  assert.deepEqual([...TERMINAL_STATES].sort(), ["archived", "done", "stopped"]);
});

// --- helpers ---------------------------------------------------------------

test("expectsHeartbeat: true for mcp_tracked/codex_app_server/hybrid", () => {
  assert.equal(expectsHeartbeat({ tier: "mcp_tracked" }), true);
  assert.equal(expectsHeartbeat({ tier: "codex_app_server" }), true);
  assert.equal(expectsHeartbeat({ tier: "hybrid" }), true);
  assert.equal(expectsHeartbeat({ tier: "dumb_terminal" }), false);
  assert.equal(expectsHeartbeat({ tier: "manual" }), false);
  assert.equal(expectsHeartbeat(null), false);
  assert.equal(expectsHeartbeat({}), false);
});

test("processExited: true when processExited=true OR status='stopped'", () => {
  assert.equal(processExited({ processExited: true }), true);
  assert.equal(processExited({ status: "stopped" }), true);
  assert.equal(processExited({ status: "active" }), false);
  assert.equal(processExited({}), false);
  assert.equal(processExited(null), false);
});

test("hasExplicitStructuredState: true for mcp/adapter/ui/cli/http statusSource.kind", () => {
  for (const kind of ["mcp", "adapter", "ui", "cli", "http"]) {
    assert.equal(
      hasExplicitStructuredState({ statusSource: { kind } }),
      true,
      `expected ${kind} to count as explicit`,
    );
  }
  for (const kind of ["system", "watcher"]) {
    assert.equal(
      hasExplicitStructuredState({ statusSource: { kind } }),
      false,
      `expected ${kind} NOT to count as explicit`,
    );
  }
  assert.equal(hasExplicitStructuredState({}), false);
  assert.equal(hasExplicitStructuredState(null), false);
  // Bare-string statusSource (legacy callers) also accepted.
  assert.equal(hasExplicitStructuredState({ statusSource: "mcp" }), true);
  assert.equal(hasExplicitStructuredState({ statusSource: "system" }), false);
});

test("isInitialStartedState: only true for session.started provenance", () => {
  assert.equal(
    isInitialStartedState({ status: "starting", statusSource: { kind: "http", eventType: "session.started" } }),
    true,
  );
  assert.equal(
    isInitialStartedState({ status: "starting", statusSource: { kind: "http", eventType: "session.status" } }),
    false,
  );
  assert.equal(isInitialStartedState({ status: "active", statusSource: { eventType: "session.started" } }), false);
  assert.equal(isInitialStartedState({ status: "starting", statusSource: "http" }), false);
});

test("minutesSince: Infinity for null/undefined; correct minutes for known ts", () => {
  assert.equal(minutesSince(null, NOW), Infinity);
  assert.equal(minutesSince(undefined, NOW), Infinity);
  // Garbage string → Infinity (defensive).
  assert.equal(minutesSince("not-a-date", NOW), Infinity);
  // Known timestamp.
  assert.equal(minutesSince(isoMinutesAgo(7), NOW), 7);
  assert.equal(minutesSince(isoMinutesAgo(0.5), NOW), 0.5);
});

// --- deriveActivity --------------------------------------------------------

test("deriveActivity: archived/done pass through with no warnings", () => {
  for (const status of ["archived", "done"]) {
    const r = deriveActivity(makeSession({ status, warnings: [{ kind: "stale" }] }), NOW);
    assert.equal(r.state, status);
    assert.deepEqual(r.warnings, []);
  }
});

test("deriveActivity: processExited → state 'stopped', no warnings", () => {
  const r = deriveActivity(makeSession({ processExited: true, status: "active" }), NOW);
  assert.equal(r.state, "stopped");
  assert.deepEqual(r.warnings, []);
});

test("deriveActivity: explicit statusSource passes through status + existing warnings", () => {
  const existing = [{ kind: "file_conflict", conflictId: "c-1" }];
  const r = deriveActivity(
    makeSession({
      status: "waiting_for_approval",
      statusSource: { kind: "mcp" },
      warnings: existing,
    }),
    NOW,
  );
  assert.equal(r.state, "waiting_for_approval");
  assert.equal(r.warnings, existing, "warnings reference passed through unchanged");
});

test("deriveActivity: dumb_terminal 11 min idle → quiet + quiet_terminal warning", () => {
  const session = makeSession({
    tier: "dumb_terminal",
    lastOutputAt: isoMinutesAgo(11),
  });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "quiet");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].kind, "quiet_terminal");
  assert.equal(r.warnings[0].minutes, 11);
  assert.equal(r.warnings[0].message, "No raw output recently; check terminal.");
});

test("deriveActivity: dumb_terminal 9 min idle → active, zero warnings", () => {
  const session = makeSession({
    tier: "dumb_terminal",
    lastOutputAt: isoMinutesAgo(9),
  });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "active");
  assert.deepEqual(r.warnings, []);
});

test("deriveActivity: mcp_tracked 13 min no heartbeat → quiet + missing_heartbeat warning", () => {
  const session = makeSession({
    tier: "mcp_tracked",
    lastStructuredEventAt: isoMinutesAgo(13),
  });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "quiet");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].kind, "missing_heartbeat");
  assert.equal(r.warnings[0].minutes, 13);
  assert.equal(r.warnings[0].message, "No structured heartbeat recently.");
});

test("deriveActivity: mcp_tracked 11 min no heartbeat → active (under 12-min threshold)", () => {
  const session = makeSession({
    tier: "mcp_tracked",
    lastStructuredEventAt: isoMinutesAgo(11),
  });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "active");
  assert.deepEqual(r.warnings, []);
});

test("deriveActivity: dumb_terminal with no lastOutputAt → quiet (Infinity > 10), warning produced", () => {
  const session = makeSession({ tier: "dumb_terminal" });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "quiet");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].kind, "quiet_terminal");
  // Infinity gets clamped to MAX_SAFE_INTEGER so the §8.3 finite-number
  // invariant on `minutes` holds.
  assert.equal(r.warnings[0].minutes, Number.MAX_SAFE_INTEGER);
});

test("deriveActivity: startedAt fallback prevents immediate dumb_terminal quiet", () => {
  const session = makeSession({
    tier: "dumb_terminal",
    status: "starting",
    statusSource: { kind: "http", eventType: "session.started" },
    startedAt: isoMinutesAgo(2),
  });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "active");
  assert.deepEqual(r.warnings, []);
});

test("deriveActivity: startedAt fallback prevents immediate heartbeat quiet", () => {
  const session = makeSession({
    tier: "mcp_tracked",
    status: "starting",
    statusSource: { kind: "http", eventType: "session.started" },
    startedAt: isoMinutesAgo(2),
  });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "active");
  assert.deepEqual(r.warnings, []);
});

test("deriveActivity: explicit later status='starting' is preserved", () => {
  const session = makeSession({
    tier: "mcp_tracked",
    status: "starting",
    statusSource: { kind: "mcp", eventType: "session.status" },
    startedAt: isoMinutesAgo(30),
    lastActivityAt: isoMinutesAgo(15),
  });
  const r = deriveActivity(session, NOW);
  assert.equal(r.state, "starting");
  assert.deepEqual(r.warnings, []);
});

// --- deriveActivityWithSeverity --------------------------------------------

test("deriveActivityWithSeverity: dumb_terminal 11 min → severity 'medium'", () => {
  const r = deriveActivityWithSeverity(
    makeSession({ tier: "dumb_terminal", lastOutputAt: isoMinutesAgo(11) }),
    NOW,
  );
  assert.equal(r.warnings[0].kind, "quiet_terminal");
  assert.equal(r.warnings[0].severity, "medium");
});

test("deriveActivityWithSeverity: dumb_terminal 26 min → severity 'high' (escalate threshold = 25)", () => {
  const r = deriveActivityWithSeverity(
    makeSession({ tier: "dumb_terminal", lastOutputAt: isoMinutesAgo(26) }),
    NOW,
  );
  assert.equal(r.warnings[0].kind, "quiet_terminal");
  assert.equal(r.warnings[0].severity, "high");
});

test("deriveActivityWithSeverity: mcp_tracked missing_heartbeat always 'medium'", () => {
  const r = deriveActivityWithSeverity(
    makeSession({ tier: "mcp_tracked", lastStructuredEventAt: isoMinutesAgo(99) }),
    NOW,
  );
  assert.equal(r.warnings[0].kind, "missing_heartbeat");
  assert.equal(r.warnings[0].severity, "medium");
});

test("deriveActivityWithSeverity: warning.kind NEVER becomes 'approval_needed' (§23.2 #4)", () => {
  // Past the escalate threshold the severity bumps to "high" but the
  // warning's kind stays `quiet_terminal`. §23.2 #4 explicitly forbids
  // promoting it to `approval_needed` (which is a different kind entirely).
  for (const mins of [11, 25, 26, 60, 9999]) {
    const r = deriveActivityWithSeverity(
      makeSession({ tier: "dumb_terminal", lastOutputAt: isoMinutesAgo(mins) }),
      NOW,
    );
    assert.equal(r.warnings[0].kind, "quiet_terminal");
    assert.notEqual(r.warnings[0].kind, "approval_needed");
  }
});

// --- ActivityMonitor.tick --------------------------------------------------

/**
 * Build a tiny fake runtime store + projection so we can drive ticks
 * without spinning up the JSONL/snapshot pipeline.
 */
function makeFakeEnv({ initialSessions = [] } = {}) {
  const sessions = new Map();
  for (const s of initialSessions) sessions.set(s.id, s);
  const appended = [];
  let evtCounter = 0;
  const runtimeStore = {
    async append(event) {
      const eventId = `evt_${String(++evtCounter).padStart(26, "0")}`;
      const stamped = { ...event, id: eventId };
      appended.push(stamped);
      // Mimic the real pipeline: apply the new status to the projection.
      const existing = sessions.get(event.sessionId);
      if (existing && event.type === "session.status") {
        sessions.set(event.sessionId, { ...existing, status: event.status });
      }
      return { ok: true, eventId, rev: appended.length };
    },
  };
  const projection = { sessions };
  const makeRuntimeId = (prefix) => `${prefix}_${String(++evtCounter).padStart(26, "0")}`;
  return { runtimeStore, projection, appended, sessions, makeRuntimeId };
}

test("ActivityMonitor.tick: no event when derived state matches projected status", async () => {
  const env = makeFakeEnv({
    initialSessions: [
      {
        id: "ses_01h00000000000000000000001",
        name: "t",
        tier: "dumb_terminal",
        status: "active",
        warnings: [],
        lastOutputAt: isoMinutesAgo(2), // well under 10-min quiet threshold
      },
    ],
  });
  const monitor = new ActivityMonitor({
    runtimeStore: env.runtimeStore,
    projection: env.projection,
    workspace: WORKSPACE,
    makeRuntimeId: env.makeRuntimeId,
    now: () => NOW,
  });
  const r = await monitor.tick("ses_01h00000000000000000000001");
  assert.equal(r.changed, false);
  assert.equal(r.state, "active");
  assert.equal(env.appended.length, 0, "no event emitted when state unchanged");
});

test("ActivityMonitor.tick: emits exactly one session.status event on state change; second tick is a no-op", async () => {
  const sessionId = "ses_01h00000000000000000000002";
  // Start the session "active" but with lastOutputAt past the quiet threshold —
  // first tick should derive `quiet` and emit. Second tick (same clock) is a
  // no-op because the projection now reflects `quiet`.
  const env = makeFakeEnv({
    initialSessions: [
      {
        id: sessionId,
        name: "t",
        tier: "dumb_terminal",
        status: "active",
        warnings: [],
        lastOutputAt: isoMinutesAgo(11),
      },
    ],
  });
  const monitor = new ActivityMonitor({
    runtimeStore: env.runtimeStore,
    projection: env.projection,
    workspace: WORKSPACE,
    makeRuntimeId: env.makeRuntimeId,
    now: () => NOW,
  });

  const first = await monitor.tick(sessionId);
  assert.equal(first.changed, true);
  assert.equal(first.state, "quiet");
  assert.equal(env.appended.length, 1);
  assert.equal(env.appended[0].type, "session.status");
  assert.equal(env.appended[0].status, "quiet");
  assert.equal(env.appended[0].source, "system");
  assert.equal(env.appended[0].sessionId, sessionId);
  assert.equal(env.appended[0].workspace, WORKSPACE);

  // Second tick: state is now `quiet` in the projection; derived state still
  // `quiet`; no new event.
  const second = await monitor.tick(sessionId);
  assert.equal(second.changed, false);
  assert.equal(second.state, "quiet");
  assert.equal(env.appended.length, 1, "no additional events after state-stable tick");
});

test("ActivityMonitor.tick: unknown sessionId returns changed:false without throwing", async () => {
  const env = makeFakeEnv();
  const monitor = new ActivityMonitor({
    runtimeStore: env.runtimeStore,
    projection: env.projection,
    workspace: WORKSPACE,
    makeRuntimeId: env.makeRuntimeId,
    now: () => NOW,
  });
  const r = await monitor.tick("ses_doesnotexist");
  assert.equal(r.changed, false);
  assert.equal(env.appended.length, 0);
});

test("ActivityMonitor.tickAll: ticks every session in projection order", async () => {
  const env = makeFakeEnv({
    initialSessions: [
      {
        id: "ses_01h00000000000000000000003",
        name: "a",
        tier: "dumb_terminal",
        status: "active",
        warnings: [],
        lastOutputAt: isoMinutesAgo(2),
      },
      {
        id: "ses_01h00000000000000000000004",
        name: "b",
        tier: "dumb_terminal",
        status: "active",
        warnings: [],
        lastOutputAt: isoMinutesAgo(11),
      },
    ],
  });
  const monitor = new ActivityMonitor({
    runtimeStore: env.runtimeStore,
    projection: env.projection,
    workspace: WORKSPACE,
    makeRuntimeId: env.makeRuntimeId,
    now: () => NOW,
  });
  const results = await monitor.tickAll();
  assert.equal(results.length, 2);
  assert.equal(results[0].changed, false); // a: 2 min idle, still active
  assert.equal(results[1].changed, true);  // b: 11 min idle, quiet
  assert.equal(env.appended.length, 1);
  assert.equal(env.appended[0].sessionId, "ses_01h00000000000000000000004");
});
