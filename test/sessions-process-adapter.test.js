// test/sessions-process-adapter.test.js — SH-2-03 (TDD v0.5 §7.1, §7.2, §23.2 #28)
//
// Acceptance suite for ProcessSessionAdapter.
//
// Scope:
//   - Stop sequence ordering (mocked child for determinism).
//   - Stop sequence graceful exit skips SIGKILL.
//   - forceKill: audit + skip-grace + actor required.
//   - writeStdin gated by userInitiated.
//   - Real-spawn happy path (lastOutputAt updates).
//   - Lint regression: source contains no regex / .includes / .match / .test
//     / .indexOf — the only ways heuristic parsing on stdio bytes can be
//     implemented in JS (DoD #5 / TDD §7.2 "Forbidden").
//   - validateRuntimeEvent integration: today's §6.6 schema enum admits
//     `session.stopped` but does NOT yet list `session.stop.requested`,
//     `process.signal_sent`, or `process.exited`. We exercise the validator
//     on the type the schema admits and document the gap explicitly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ProcessSessionAdapter } from "../hub/sessions/adapters/process.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";
import { validateRuntimeEvent } from "../hub/runtime/events.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = path.resolve(HERE, "..", "hub", "sessions", "adapters", "process.js");

/** Tiny throwaway runtime store: just collect every appended event. */
function makeCollectingStore() {
  /** @type {object[]} */
  const events = [];
  return {
    events,
    append(event) {
      events.push(event);
      return Promise.resolve({ ok: true, eventId: "evt_x", rev: events.length });
    },
  };
}

/**
 * Build a fake child process. Defaults to "ignores SIGINT, exits on SIGKILL"
 * so the test can drive the §23.2 #28 escalation deterministically.
 *
 * @param {{ pid?: number, exitOn?: ("SIGINT"|"SIGKILL")[], exitCode?: number | null }} [opts]
 */
function makeFakeChild(opts) {
  const o = opts || {};
  const pid = typeof o.pid === "number" ? o.pid : 99999;
  const exitOn = Array.isArray(o.exitOn) ? o.exitOn : ["SIGKILL"];
  const exitCode = o.exitCode === undefined ? null : o.exitCode;

  const child = new EventEmitter();
  /** @type {any} */ (child).pid = pid;
  /** @type {any} */ (child).stdout = new EventEmitter();
  /** @type {any} */ (child).stderr = new EventEmitter();
  /** @type {any} */ (child).stdin = { write: () => {} };

  /** @type {string[]} */
  const killCalls = [];
  /** @type {any} */ (child).killCalls = killCalls;
  /** @type {any} */ (child).kill = (signal) => {
    killCalls.push(signal);
    if (exitOn.some((s) => s === signal)) {
      // Defer one tick so the caller (stop()) is awaiting _waitForExit
      // before the exit observer fires.
      setImmediate(() => child.emit("exit", exitCode, signal));
    }
    return true;
  };

  return child;
}

function makeAdapter(child, overrides) {
  const o = overrides || {};
  const runtimeStore = o.runtimeStore || makeCollectingStore();
  /** @type {Record<string, any>} */
  const deps = {
    runtimeStore,
    workspace: o.workspace || "/tmp/ws",
    makeRuntimeId,
    now: o.now || (() => new Date()),
    sigintGraceMs: typeof o.sigintGraceMs === "number" ? o.sigintGraceMs : 50,
    validateRuntimeEvent: o.validateRuntimeEvent,
  };
  if (child !== null) {
    deps.spawn = () => child;
  }
  const adapter = new ProcessSessionAdapter(deps);
  return { adapter, runtimeStore };
}

const SESSION_ID = "ses_00000000000000000000000000";

// --- stop sequence: SIGINT-ignored → SIGKILL escalation ---------------------

test("stop sequence: SIGINT ignored, escalates to SIGKILL after grace", async () => {
  const child = makeFakeChild({ exitOn: ["SIGKILL"] });
  const { adapter, runtimeStore } = makeAdapter(child);

  adapter.start({ sessionId: SESSION_ID, command: "/bin/fake" });
  await adapter.stop(SESSION_ID);

  const types = runtimeStore.events.map((e) => e.type);
  assert.deepEqual(types, [
    "session.stop.requested",
    "process.signal_sent",
    "process.signal_sent",
    "process.exited",
    "session.stopped",
  ]);

  // SIGINT first, SIGKILL second; SIGKILL carries reason.
  const sigintEvt = runtimeStore.events[1];
  assert.equal(sigintEvt.signal, "SIGINT");
  assert.equal(sigintEvt.pid, 99999);
  assert.equal(sigintEvt.reason, undefined);

  const sigkillEvt = runtimeStore.events[2];
  assert.equal(sigkillEvt.signal, "SIGKILL");
  assert.equal(sigkillEvt.reason, "sigint_grace_expired");

  assert.deepEqual(child.killCalls, ["SIGINT", "SIGKILL"]);

  // process.exited carries observed exit signal.
  const exited = runtimeStore.events[3];
  assert.equal(exited.signal, "SIGKILL");

  // All events stamp the base RuntimeEvent shape.
  for (const evt of runtimeStore.events) {
    assert.equal(evt.schemaVersion, 1);
    assert.equal(typeof evt.ts, "string");
    assert.equal(evt.source, "system");
    assert.equal(evt.workspace, "/tmp/ws");
    assert.equal(evt.sessionId, SESSION_ID);
  }
});

// --- stop sequence: graceful exit on SIGINT, no SIGKILL ---------------------

test("stop sequence: graceful SIGINT exit skips SIGKILL", async () => {
  const child = makeFakeChild({ exitOn: ["SIGINT"], exitCode: 0 });
  const { adapter, runtimeStore } = makeAdapter(child);

  adapter.start({ sessionId: SESSION_ID, command: "/bin/fake" });
  await adapter.stop(SESSION_ID);

  const types = runtimeStore.events.map((e) => e.type);
  assert.deepEqual(types, [
    "session.stop.requested",
    "process.signal_sent",
    "process.exited",
    "session.stopped",
  ]);
  assert.equal(runtimeStore.events[1].signal, "SIGINT");
  assert.deepEqual(child.killCalls, ["SIGINT"]);
});

// --- forceKill --------------------------------------------------------------

test("forceKill: rejects missing userActor", async () => {
  const child = makeFakeChild({ exitOn: ["SIGKILL"] });
  const { adapter } = makeAdapter(child);
  adapter.start({ sessionId: SESSION_ID, command: "/bin/fake" });

  await assert.rejects(() => adapter.forceKill(SESSION_ID, {}), /userActor required/);
  await assert.rejects(
    () => adapter.forceKill(SESSION_ID, { userActor: "" }),
    /userActor required/,
  );
});

test("forceKill: skips grace, audits actor, emits SIGKILL only", async () => {
  const child = makeFakeChild({ exitOn: ["SIGKILL"], exitCode: 137 });
  const { adapter, runtimeStore } = makeAdapter(child);
  adapter.start({ sessionId: SESSION_ID, command: "/bin/fake" });

  await adapter.forceKill(SESSION_ID, { userActor: "ui-detail-dock" });

  const types = runtimeStore.events.map((e) => e.type);
  assert.deepEqual(types, [
    "session.stop.requested",
    "process.signal_sent",
    "process.exited",
    "session.stopped",
  ]);

  const stopReq = runtimeStore.events[0];
  assert.equal(stopReq.force, true);
  assert.equal(stopReq.actor, "ui-detail-dock");

  const sigkill = runtimeStore.events[1];
  assert.equal(sigkill.signal, "SIGKILL");
  assert.equal(sigkill.reason, "force_kill_requested");
  assert.equal(sigkill.actor, "ui-detail-dock");

  // No SIGINT was sent.
  assert.deepEqual(child.killCalls, ["SIGKILL"]);

  const exited = runtimeStore.events[2];
  assert.equal(exited.signal, "SIGKILL");
});

// --- writeStdin -------------------------------------------------------------

test("writeStdin: throws unless userInitiated:true", () => {
  const child = makeFakeChild();
  const { adapter } = makeAdapter(child);
  adapter.start({ sessionId: SESSION_ID, command: "/bin/fake" });

  /** @type {string[]} */
  const written = [];
  /** @type {any} */ (child).stdin = {
    write: (chunk) => {
      written.push(String(chunk));
    },
  };

  assert.throws(
    () => adapter.writeStdin(SESSION_ID, "hi", {}),
    /stdin pass-through requires explicit user action/,
  );
  assert.throws(
    () => adapter.writeStdin(SESSION_ID, "hi", { userInitiated: false }),
    /stdin pass-through requires explicit user action/,
  );
  assert.throws(
    () => adapter.writeStdin(SESSION_ID, "hi", { userInitiated: "true" }),
    /stdin pass-through requires explicit user action/,
  );

  adapter.writeStdin(SESSION_ID, "hi", { userInitiated: true });
  assert.deepEqual(written, ["hi\n"]);
});

// --- real-spawn happy path --------------------------------------------------

test("real spawn: captures stdout and updates lastOutputAt", async (t) => {
  const { adapter } = makeAdapter(null, {
    // For real-spawn we DON'T pass a fake spawn; we let the adapter use the
    // node:child_process default.
  });

  // Stash the configured child once start() returns, so the test can clean up.
  const handle = adapter.start({
    sessionId: SESSION_ID,
    command: process.execPath,
    args: [
      "-e",
      "console.log('hello'); setTimeout(()=>{}, 30000);",
    ],
  });
  assert.equal(typeof handle.pid, "number");

  // Make sure we never leak a zombie out of this test.
  const child = adapter.children.get(SESSION_ID).child;
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {}
  });

  // Wait briefly for "hello\n" to be observed.
  const deadline = Date.now() + 1500;
  while (adapter.getLastOutputAt(SESSION_ID) === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const lastOut = adapter.getLastOutputAt(SESSION_ID);
  assert.ok(lastOut instanceof Date, "lastOutputAt is a Date after stdout chunk");
  assert.ok(Date.now() - lastOut.getTime() < 2000, "lastOutputAt is recent");
});

// Override makeAdapter to allow null child + real spawn for the happy-path test.
// Re-exported as a local helper above; nothing to do here.

// --- lint regression --------------------------------------------------------

test("ProcessSessionAdapter source contains no output-pattern heuristics (regexp/includes/match/test/indexOf)", () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");

  // Coarse but robust: forbid the substrings outright. The adapter must not
  // implement any heuristic on stdio content (DoD #5 / TDD §7.2 "Forbidden").
  /** @type {string[]} */
  const forbiddenSubstrings = [".includes(", ".match(", ".indexOf(", ".test("];
  for (const needle of forbiddenSubstrings) {
    const idx = src.indexOf(needle);
    assert.equal(
      idx,
      -1,
      `adapter source contains forbidden substring ${JSON.stringify(needle)} ` +
        `at offset ${idx} — heuristic parsing on stdio is forbidden (DoD #5).`,
    );
  }

  // Forbid regex literals. Strip line + block comments first so a literal
  // appearing inside a comment string would NOT pass — but no such case
  // exists in the adapter today.
  const stripped = stripJsCommentsAndStrings(src);
  // Detect /…/flags patterns. Look for a `/` that is followed by at least one
  // non-`/` char and a closing `/`. This is intentionally coarse: a single
  // `/` in `a / b` won't match because the closing `/` isn't followed by an
  // allowed flag-or-EOL terminator.
  let cursor = 0;
  let foundRegex = false;
  while (cursor < stripped.length) {
    const slash = stripped.indexOf("/", cursor);
    if (slash === -1) break;
    // Look for a matching `/` later on the same line.
    const nl = stripped.indexOf("\n", slash + 1);
    const end = nl === -1 ? stripped.length : nl;
    const close = stripped.indexOf("/", slash + 1);
    if (close !== -1 && close < end) {
      // Plausible regex literal: a `/…/` pair on the same line with non-empty
      // body. Skip the obvious division-operator false positives by checking
      // that the char before `/` is NOT one of: identifier char, `)`, `]`,
      // digit (those contexts mean division).
      const prev = slash === 0 ? "" : stripped[slash - 1];
      const looksLikeDivision = isDivisionPrev(prev);
      if (!looksLikeDivision && close > slash + 1) {
        foundRegex = true;
        break;
      }
    }
    cursor = slash + 1;
  }
  assert.equal(foundRegex, false, "adapter source contains a regex literal — heuristic parsing on stdio is forbidden (DoD #5).");
});

function isDivisionPrev(ch) {
  if (ch === "") return false;
  const code = ch.charCodeAt(0);
  // word char
  if (code >= 48 && code <= 57) return true; // 0-9
  if (code >= 65 && code <= 90) return true; // A-Z
  if (code >= 97 && code <= 122) return true; // a-z
  if (ch === "_" || ch === "$") return true;
  if (ch === ")" || ch === "]") return true;
  return false;
}

/**
 * Strip JS line + block comments and replace string-literal bodies with
 * spaces, so the regex-literal scan above doesn't trip on `/` chars that
 * appear inside strings or comments.
 *
 * @param {string} src
 * @returns {string}
 */
function stripJsCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      // line comment to EOL
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      // Pad with spaces so offsets stay aligned.
      out += " ".repeat(end - i);
      i = end;
    } else if (c === "/" && n === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      out += " ".repeat(end - i);
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      // Skip the string body. (Template literals can contain `${...}` but we
      // don't care for this scan — we just blank the whole literal.)
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === c) {
          out += c;
          i += 1;
          break;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// --- runtime-events validator integration -----------------------------------
//
// Today's `schema/runtime-events.schema.json` enum admits `session.stopped`
// but does NOT list `session.stop.requested`, `process.signal_sent`, or
// `process.exited` (per TDD §6.6 they are first-class runtime event types;
// the schema-update task is downstream). We exercise the validator on the
// type the schema admits, and assert the others CURRENTLY fail with a clear
// type-enum complaint so a future schema-tightening task makes this test
// flip from "documents the gap" to "validates the full sequence".

test("validateRuntimeEvent: session.stopped event passes today's schema", async () => {
  const child = makeFakeChild({ exitOn: ["SIGKILL"] });
  // Capture events into our own array first; then validate the session.stopped
  // entry through the real validator.
  const { adapter, runtimeStore } = makeAdapter(child);
  adapter.start({ sessionId: SESSION_ID, command: "/bin/fake" });
  await adapter.stop(SESSION_ID);

  const stopped = runtimeStore.events.find((e) => e.type === "session.stopped");
  assert.ok(stopped, "session.stopped event was emitted");
  // The validator needs an `id` field; stamp one to mirror what the store
  // does at append time.
  assert.equal(validateRuntimeEvent({ ...stopped, id: makeRuntimeId("evt") }), true);
});

test("validateRuntimeEvent: documents §6.6 enum gap for process.*/session.stop.requested", () => {
  // Today the schema enum does NOT list these types. When the schema is
  // extended (downstream task), this test should flip to a passing assertion.
  const ts = new Date().toISOString();
  const make = (type) => ({
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts,
    type,
    source: "system",
    workspace: "/tmp/ws",
    sessionId: SESSION_ID,
  });
  for (const type of ["session.stop.requested", "process.signal_sent", "process.exited"]) {
    assert.throws(
      () => validateRuntimeEvent(make(type)),
      /RuntimeEvent invalid/,
      `expected ${type} to be rejected by today's §6.6 enum (gap to be closed downstream)`,
    );
  }
});
