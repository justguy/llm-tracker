// test/sessions-warnings.test.js — SH-2-02 (TDD v0.5 §8.3, §23.1)
//
// Acceptance suite for the SessionWarning vocabulary + per-kind factories +
// the session.warning / session.warning_cleared event factories.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WARNING_KINDS,
  DEPRECATED_WARNING_KINDS,
  assertValidWarning,
  quietTerminalWarning,
  missingHeartbeatWarning,
  approvalNeededWarning,
  fileConflictWarning,
  contextHighWarning,
  skillGateMissingWarning,
  disconnectedWarning,
  stdioCaptureOversizedWarning,
} from "../hub/sessions/warnings.js";
import {
  createSessionWarningEvent,
  createSessionWarningClearedEvent,
  validateRuntimeEvent,
} from "../hub/runtime/events.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const WORKSPACE = "/tmp/lt-sessions-warnings-test";

// --- per-kind factories ----------------------------------------------------

test("WARNING_KINDS lists the 8 §8.3 kinds and is frozen", () => {
  assert.ok(Object.isFrozen(WARNING_KINDS));
  assert.deepEqual([...WARNING_KINDS].sort(), [
    "approval_needed",
    "context_high",
    "disconnected",
    "file_conflict",
    "missing_heartbeat",
    "quiet_terminal",
    "skill_gate_missing",
    "stdio_capture_oversized",
  ]);
});

test("DEPRECATED_WARNING_KINDS includes 'quiet' (renamed to 'quiet_terminal' per §23.1)", () => {
  assert.ok(Object.isFrozen(DEPRECATED_WARNING_KINDS));
  assert.deepEqual([...DEPRECATED_WARNING_KINDS], ["quiet"]);
});

test("quietTerminalWarning sets the §8.3 literal message", () => {
  const w = quietTerminalWarning({ minutes: 7 });
  assert.equal(w.kind, "quiet_terminal");
  assert.equal(w.minutes, 7);
  assert.equal(w.message, "No raw output recently; check terminal.");
  assertValidWarning(w);
});

test("missingHeartbeatWarning sets the §8.3 literal message", () => {
  const w = missingHeartbeatWarning({ minutes: 3 });
  assert.equal(w.kind, "missing_heartbeat");
  assert.equal(w.minutes, 3);
  assert.equal(w.message, "No structured heartbeat recently.");
  assertValidWarning(w);
});

test("approvalNeededWarning accepts all three sources and optional actionId", () => {
  for (const source of ["app_server", "mcp", "human"]) {
    const w = approvalNeededWarning({ source });
    assert.equal(w.kind, "approval_needed");
    assert.equal(w.source, source);
    assert.equal(w.actionId, undefined);
    assertValidWarning(w);
  }
  const withAction = approvalNeededWarning({ source: "human", actionId: "act-1" });
  assert.equal(withAction.actionId, "act-1");
  assertValidWarning(withAction);
});

test("fileConflictWarning carries a conflictId", () => {
  const w = fileConflictWarning({ conflictId: "conf-42" });
  assert.equal(w.kind, "file_conflict");
  assert.equal(w.conflictId, "conf-42");
  assertValidWarning(w);
});

test("contextHighWarning requires source and accepts optional percent", () => {
  for (const source of ["app_server", "mcp"]) {
    const w = contextHighWarning({ source });
    assert.equal(w.kind, "context_high");
    assert.equal(w.source, source);
    assert.equal(w.percent, undefined);
    assertValidWarning(w);
  }
  const withPct = contextHighWarning({ source: "mcp", percent: 87.5 });
  assert.equal(withPct.percent, 87.5);
  assertValidWarning(withPct);
});

test("skillGateMissingWarning carries a skillId", () => {
  const w = skillGateMissingWarning({ skillId: "skill-verify-build" });
  assert.equal(w.kind, "skill_gate_missing");
  assert.equal(w.skillId, "skill-verify-build");
  assertValidWarning(w);
});

test("disconnectedWarning requires source + sinceMs", () => {
  for (const source of ["app_server", "mcp"]) {
    const w = disconnectedWarning({ source, sinceMs: 12345 });
    assert.equal(w.kind, "disconnected");
    assert.equal(w.source, source);
    assert.equal(w.sinceMs, 12345);
    assertValidWarning(w);
  }
});

test("stdioCaptureOversizedWarning requires non-negative rotatedSegments", () => {
  const w = stdioCaptureOversizedWarning({ rotatedSegments: 0 });
  assert.equal(w.kind, "stdio_capture_oversized");
  assert.equal(w.rotatedSegments, 0);
  assertValidWarning(w);

  const w2 = stdioCaptureOversizedWarning({ rotatedSegments: 5 });
  assert.equal(w2.rotatedSegments, 5);
  assertValidWarning(w2);
});

// --- assertValidWarning rejects ----------------------------------------------

test("assertValidWarning rejects non-objects, missing kind, unknown kind", () => {
  for (const bad of [null, undefined, "str", 42, []]) {
    assert.throws(() => assertValidWarning(bad), /must be a plain object|kind must be a string/);
  }
  assert.throws(() => assertValidWarning({}), /kind must be a string/);
  assert.throws(() => assertValidWarning({ kind: 7 }), /kind must be a string/);
  assert.throws(
    () => assertValidWarning({ kind: "unknown_kind" }),
    /not in/,
  );
});

test("assertValidWarning rejects deprecated 'quiet' kind (regression: DoD #3)", () => {
  assert.throws(
    () => assertValidWarning({ kind: "quiet", minutes: 5 }),
    (err) => /deprecated/.test(err.message) && /quiet_terminal/.test(err.message),
  );
});

test("assertValidWarning rejects missing required fields per kind", () => {
  // quiet_terminal missing minutes
  assert.throws(
    () => assertValidWarning({ kind: "quiet_terminal", message: "No raw output recently; check terminal." }),
    /minutes must be a finite number/,
  );
  // quiet_terminal wrong message literal
  assert.throws(
    () => assertValidWarning({ kind: "quiet_terminal", minutes: 1, message: "wrong" }),
    /message must be the §8.3 literal/,
  );
  // missing_heartbeat missing minutes
  assert.throws(
    () => assertValidWarning({ kind: "missing_heartbeat", message: "No structured heartbeat recently." }),
    /minutes must be a finite number/,
  );
  // file_conflict missing conflictId
  assert.throws(
    () => assertValidWarning({ kind: "file_conflict" }),
    /conflictId must be a non-empty string/,
  );
  // skill_gate_missing missing skillId
  assert.throws(
    () => assertValidWarning({ kind: "skill_gate_missing" }),
    /skillId must be a non-empty string/,
  );
  // disconnected missing sinceMs
  assert.throws(
    () => assertValidWarning({ kind: "disconnected", source: "mcp" }),
    /sinceMs must be a finite number/,
  );
  // stdio_capture_oversized negative
  assert.throws(
    () => assertValidWarning({ kind: "stdio_capture_oversized", rotatedSegments: -1 }),
    /rotatedSegments must be a non-negative integer/,
  );
  // stdio_capture_oversized non-integer
  assert.throws(
    () => assertValidWarning({ kind: "stdio_capture_oversized", rotatedSegments: 1.5 }),
    /rotatedSegments must be a non-negative integer/,
  );
});

test("assertValidWarning rejects bad source enum values per kind", () => {
  // approval_needed disallows arbitrary sources
  assert.throws(
    () => assertValidWarning({ kind: "approval_needed", source: "watcher" }),
    /source must be one of app_server\|mcp\|human/,
  );
  // context_high disallows "human"
  assert.throws(
    () => assertValidWarning({ kind: "context_high", source: "human" }),
    /source must be one of app_server\|mcp/,
  );
  // disconnected disallows "human"
  assert.throws(
    () => assertValidWarning({ kind: "disconnected", source: "human", sinceMs: 1 }),
    /source must be one of app_server\|mcp/,
  );
});

// --- event factories -------------------------------------------------------

test("createSessionWarningEvent builds a schema-valid event with defaults", () => {
  const sessionId = makeRuntimeId("ses");
  const warning = quietTerminalWarning({ minutes: 4 });
  const evt = createSessionWarningEvent({ sessionId, warning, workspace: WORKSPACE });
  assert.equal(evt.type, "session.warning");
  assert.equal(evt.schemaVersion, 1);
  assert.equal(evt.source, "system", "default source is 'system'");
  assert.equal(evt.sessionId, sessionId);
  assert.deepEqual(evt.warning, warning);
  assert.equal(evt.id, undefined, "id is left for the runtime store to stamp");
  assert.ok(typeof evt.ts === "string" && evt.ts.length > 0);

  // Once the store stamps an id, validateRuntimeEvent must accept it.
  validateRuntimeEvent({ ...evt, id: makeRuntimeId("evt") });
});

test("createSessionWarningEvent honors explicit id / ts / source / idempotencyKey", () => {
  const sessionId = makeRuntimeId("ses");
  const id = makeRuntimeId("evt");
  const warning = approvalNeededWarning({ source: "mcp", actionId: "act-7" });
  const evt = createSessionWarningEvent({
    sessionId,
    warning,
    workspace: WORKSPACE,
    source: "mcp",
    ts: "2026-05-24T12:00:00.000Z",
    id,
    idempotencyKey: "idem-1",
  });
  assert.equal(evt.id, id);
  assert.equal(evt.ts, "2026-05-24T12:00:00.000Z");
  assert.equal(evt.source, "mcp");
  assert.equal(evt.idempotencyKey, "idem-1");
  validateRuntimeEvent(evt);
});

test("createSessionWarningEvent rejects 'quiet' before schema validation (regression: DoD #3)", () => {
  const sessionId = makeRuntimeId("ses");
  assert.throws(
    () =>
      createSessionWarningEvent({
        sessionId,
        warning: { kind: "quiet", minutes: 5, message: "anything" },
        workspace: WORKSPACE,
      }),
    (err) => {
      // The message must point at the deprecation, not the schema.
      const msg = err.message || "";
      return /deprecated/.test(msg) && /quiet_terminal/.test(msg) && !/RuntimeEvent invalid/.test(msg);
    },
  );
});

test("createSessionWarningEvent validates required inputs", () => {
  const sessionId = makeRuntimeId("ses");
  const warning = quietTerminalWarning({ minutes: 1 });
  assert.throws(
    () => createSessionWarningEvent({ warning, workspace: WORKSPACE }),
    /sessionId required/,
  );
  assert.throws(
    () => createSessionWarningEvent({ sessionId, warning }),
    /workspace required/,
  );
  assert.throws(
    () => createSessionWarningEvent({ sessionId, workspace: WORKSPACE }),
    /must be a plain object/,
  );
});

test("createSessionWarningClearedEvent builds a schema-valid event with defaults", () => {
  const sessionId = makeRuntimeId("ses");
  const evt = createSessionWarningClearedEvent({
    sessionId,
    warningKind: "quiet_terminal",
    workspace: WORKSPACE,
  });
  assert.equal(evt.type, "session.warning_cleared");
  assert.equal(evt.warningKind, "quiet_terminal");
  assert.equal(evt.source, "system");
  assert.equal(evt.sessionId, sessionId);
  validateRuntimeEvent({ ...evt, id: makeRuntimeId("evt") });
});

test("createSessionWarningClearedEvent rejects 'quiet' kind (regression: DoD #3)", () => {
  const sessionId = makeRuntimeId("ses");
  assert.throws(
    () =>
      createSessionWarningClearedEvent({
        sessionId,
        warningKind: "quiet",
        workspace: WORKSPACE,
      }),
    (err) => /deprecated/.test(err.message) && /quiet_terminal/.test(err.message),
  );
});

test("createSessionWarningClearedEvent rejects unknown warningKind", () => {
  const sessionId = makeRuntimeId("ses");
  assert.throws(
    () =>
      createSessionWarningClearedEvent({
        sessionId,
        warningKind: "totally_made_up",
        workspace: WORKSPACE,
      }),
    /not in/,
  );
});

test("createSessionWarningClearedEvent validates required inputs", () => {
  const sessionId = makeRuntimeId("ses");
  assert.throws(
    () => createSessionWarningClearedEvent({ warningKind: "quiet_terminal", workspace: WORKSPACE }),
    /sessionId required/,
  );
  assert.throws(
    () => createSessionWarningClearedEvent({ sessionId, warningKind: "quiet_terminal" }),
    /workspace required/,
  );
  assert.throws(
    () => createSessionWarningClearedEvent({ sessionId, workspace: WORKSPACE }),
    /warningKind required/,
  );
});
