// hub/sessions/adapters/process.js — SH-2-03 (TDD v0.5 §7.1, §7.2, §23.2 #28)
//
// ProcessSessionAdapter — a `dumb_terminal`-tier SessionAdapter that spawns a
// child via node:child_process.spawn, captures stdout/stderr, optionally
// persists raw bytes to a log file, and stops via the §23.2 #28 sequence:
//
//     session.stop.requested
//       → SIGINT
//       → process.signal_sent { signal: "SIGINT" }
//       → wait sigintGraceMs (default 5000)
//       → (still alive?) SIGKILL
//                       → process.signal_sent { signal: "SIGKILL",
//                                               reason: "sigint_grace_expired" }
//       → process.exited
//       → session.stopped
//
// `forceKill()` is the UI session-detail-dock-only escape hatch: it skips the
// SIGINT grace window, requires a `userActor` (audit trail), and emits the
// signal sent with reason `force_kill_requested`. Per §23.2 #28 it must never
// be wired to the small-card stop control.
//
// What this adapter forbids (DoD #5 / TDD §7.2 "Forbidden"):
//   - Parsing approvals / commands / progress / MCP usage / skill runs.
//   - Inferring task status from stdio bytes.
//   - Any heuristic that reads the content of stdout/stderr chunks.
//
// The lint rule that enforces #5 lives in the test (see
// `test/sessions-process-adapter.test.js`): the source file must contain zero
// regex literals and zero membership/scan method calls — those are the only
// ways heuristic parsing can be implemented in JS. This constrains the
// adapter's own implementation (no regex-based ID checks, no array
// membership scans on stdio) which is intentional.
//
// The streaming-iterator surface (`getRawStdio`, `getStructuredEvents`) is
// declared so the SessionAdapter shape is complete, but the actual stdio
// capture lands in SH-2-04. Today those iterators yield nothing.
//
// Schema-enum gap (acknowledged): the runtime-events schema enum in
// `schema/runtime-events.schema.json` does not yet list `session.stop.requested`,
// `process.signal_sent`, or `process.exited`. Per TDD §6.6 these are
// first-class runtime events; the schema-update task is downstream. This
// adapter emits the spec-mandated type strings; only `session.stopped`
// validates against today's schema. The test file documents the gap.

import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * @typedef {"SIGINT" | "SIGKILL"} EscalationSignal
 */

/**
 * @typedef {object} ProcessSessionAdapterDeps
 * @property {{ append: (event: object) => any }} runtimeStore
 *   The runtime store sink. Must expose `append(event)`. Stop paths await
 *   appends so audit sequencing failures are visible to callers.
 * @property {string} workspace
 *   Workspace path. Stamped into every emitted event's `workspace` field.
 * @property {(prefix: "evt"|"ses"|"job"|"skr"|"ctx"|"att") => string} makeRuntimeId
 *   Runtime ID factory (typically `hub/runtime/ids.js#makeRuntimeId`).
 * @property {(event: object) => true} [validateRuntimeEvent]
 *   Optional schema validator. When provided, the adapter calls it on every
 *   emitted event. NOTE: today's schema enum (§6.6) does not list
 *   `session.stop.requested`, `process.signal_sent`, or `process.exited`;
 *   passing this validator will reject those events. Inject only when you
 *   want strict gating (and have a schema that admits the types).
 * @property {(command: string, args?: string[], options?: object) => any} [spawn]
 *   Child-process factory. Defaults to node:child_process.spawn. Injected for
 *   deterministic tests.
 * @property {() => Date} [now]
 *   Date factory. Defaults to `() => new Date()`. Injected for tests.
 * @property {number} [sigintGraceMs=5000]
 *   §23.2 #28 grace window between SIGINT and SIGKILL.
 */

/**
 * Build an audit-trail-shaped RuntimeEvent payload with the base fields every
 * §6.6 event requires. The `id` field is left undefined so the runtime store
 * stamps the canonical `evt_` id at append time (the pattern other emitters
 * in this repo use; see hub/sessions/registry.js).
 *
 * @param {object} args
 * @param {string} args.type
 * @param {string} args.workspace
 * @param {string} args.sessionId
 * @param {string} args.ts
 * @returns {Record<string, any>}
 */
function baseEvent({ type, workspace, sessionId, ts }) {
  return {
    schemaVersion: 1,
    id: undefined,
    ts,
    type,
    source: "system",
    workspace,
    sessionId,
  };
}

/**
 * ProcessSessionAdapter — spawn-based `dumb_terminal` SessionAdapter.
 *
 * Lifecycle methods:
 *   - `start({ sessionId, command, args?, env?, cwd?, captureToLog?, logPath? })`
 *     spawns the child, wires stdio observers, returns `{ sessionId, pid }`.
 *   - `writeStdin(sessionId, input, { userInitiated })` — DoD #2: requires
 *     `userInitiated === true`. Throws otherwise.
 *   - `stop(sessionId)` — §23.2 #28 SIGINT → grace → SIGKILL sequence.
 *   - `forceKill(sessionId, { userActor })` — UI session-detail-dock-only;
 *     skips the grace window. Throws if `userActor` is missing.
 *   - `getLastOutputAt(sessionId)` — most recent stdio Date (or null).
 *
 * Streaming iterators (`getRawStdio`, `getStructuredEvents`) are declared so
 * the SessionAdapter shape is complete; the implementation lands in SH-2-04.
 */
export class ProcessSessionAdapter {
  /**
   * @param {ProcessSessionAdapterDeps} deps
   */
  constructor(deps) {
    const {
      runtimeStore,
      workspace,
      makeRuntimeId,
      validateRuntimeEvent,
      spawn,
      now,
      sigintGraceMs,
    } = deps || {};

    if (!runtimeStore || typeof runtimeStore.append !== "function") {
      throw new Error("ProcessSessionAdapter: runtimeStore (with append) required");
    }
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("ProcessSessionAdapter: workspace required (non-empty string)");
    }
    if (typeof makeRuntimeId !== "function") {
      throw new Error("ProcessSessionAdapter: makeRuntimeId function required");
    }

    this.kind = "dumb_terminal";
    this.capabilities = Object.freeze({
      rawStdio: true,
      structuredThread: false,
      structuredTurns: false,
      structuredItems: false,
      structuredApprovals: false,
      explicitTrackerMcp: false,
    });

    this.runtimeStore = runtimeStore;
    this.workspace = workspace;
    this.makeRuntimeId = makeRuntimeId;
    this.validateRuntimeEvent =
      typeof validateRuntimeEvent === "function" ? validateRuntimeEvent : null;
    this.spawn = typeof spawn === "function" ? spawn : nodeSpawn;
    this.now = typeof now === "function" ? now : () => new Date();
    this.sigintGraceMs = Number.isInteger(sigintGraceMs) && sigintGraceMs >= 0
      ? sigintGraceMs
      : 5000;

    /** @type {Map<string, { child: any, lastOutputAt: Date | null, logPath: string | null, captureToLog: boolean, exited: boolean, exitInfo: { code: number | null, signal: string | null } | null, stopPromise: Promise<void> | null, stoppedEmitted: boolean }>} */
    this.children = new Map();
  }

  /**
   * Emit a RuntimeEvent through the configured store. When a validator was
   * injected, validate before append (validator throws on rejection).
   *
   * @param {Record<string, any>} event
   * @returns {Promise<any>}
   */
  _emit(event) {
    if (this.validateRuntimeEvent) {
      // Validator requires a fully-formed event; stamp a placeholder id for
      // the validation pass and strip it again before append so the store
      // assigns the canonical `evt_` id (same dance SessionRegistry uses).
      const placeholderId = this.makeRuntimeId("evt");
      this.validateRuntimeEvent({ ...event, id: placeholderId });
    }
    const { id, ...rest } = event;
    void id;
    return Promise.resolve(this.runtimeStore.append(rest));
  }

  /**
   * Spawn the child process for `sessionId`.
   *
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {string} opts.command
   * @param {string[]} [opts.args]
   * @param {NodeJS.ProcessEnv} [opts.env]
   * @param {string} [opts.cwd]
   * @param {boolean} [opts.captureToLog=false]
   * @param {string} [opts.logPath]   required when captureToLog is true
   * @returns {{ sessionId: string, pid: number | undefined }}
   */
  start(opts) {
    const o = opts || {};
    const { sessionId, command } = o;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("ProcessSessionAdapter.start: sessionId required");
    }
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("ProcessSessionAdapter.start: command required");
    }
    if (this.children.has(sessionId)) {
      throw new Error(`ProcessSessionAdapter.start: sessionId '${sessionId}' already started`);
    }
    const args = Array.isArray(o.args) ? o.args : [];
    const captureToLog = !!o.captureToLog;
    const logPath = typeof o.logPath === "string" ? o.logPath : null;
    if (captureToLog && !logPath) {
      throw new Error("ProcessSessionAdapter.start: captureToLog requires logPath");
    }

    /** @type {Record<string, any>} */
    const spawnOpts = { stdio: ["pipe", "pipe", "pipe"] };
    if (o.cwd) spawnOpts.cwd = o.cwd;
    if (o.env) spawnOpts.env = o.env;

    const child = this.spawn(command, args, spawnOpts);

    /** @type {any} */
    const state = {
      child,
      lastOutputAt: null,
      logPath,
      captureToLog,
      exited: false,
      exitInfo: null,
      stopPromise: null,
      stoppedEmitted: false,
    };
    this.children.set(sessionId, state);

    const observe = (chunk) => {
      // DoD #1: update lastOutputAt; optionally persist raw bytes. The chunk
      // is never inspected (DoD #5 / TDD §7.2 "Forbidden").
      state.lastOutputAt = this.now();
      if (captureToLog && logPath) {
        try {
          appendFileSync(logPath, chunk);
        } catch (_err) {
          // Log-persist errors are swallowed: the adapter must not crash on
          // a disk hiccup. SH-2-04 owns the durable capture pipeline.
        }
      }
    };

    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", observe);
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", observe);
    }

    child.on("exit", (code, signal) => {
      state.exited = true;
      state.exitInfo = {
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null,
      };
    });

    return { sessionId, pid: child.pid };
  }

  /**
   * Most recent stdio chunk timestamp for `sessionId`, or `null` if no chunk
   * has been observed.
   *
   * @param {string} sessionId
   * @returns {Date | null}
   */
  getLastOutputAt(sessionId) {
    const state = this.children.get(sessionId);
    return state ? state.lastOutputAt : null;
  }

  /**
   * Write `input + "\n"` to the child's stdin. DoD #2: stdin pass-through is
   * gated by **explicit user action** — callers MUST pass
   * `{ userInitiated: true }` or this method throws.
   *
   * @param {string} sessionId
   * @param {string} input
   * @param {{ userInitiated: boolean }} flags
   * @returns {void}
   */
  writeStdin(sessionId, input, flags) {
    if (!flags || flags.userInitiated !== true) {
      throw new Error("stdin pass-through requires explicit user action");
    }
    const state = this.children.get(sessionId);
    if (!state) {
      throw new Error(`ProcessSessionAdapter.writeStdin: unknown sessionId '${sessionId}'`);
    }
    if (typeof input !== "string") {
      throw new Error("ProcessSessionAdapter.writeStdin: input must be a string");
    }
    const stdin = state.child && state.child.stdin;
    if (!stdin || typeof stdin.write !== "function") {
      throw new Error("ProcessSessionAdapter.writeStdin: child stdin is not writable");
    }
    stdin.write(`${input}\n`);
  }

  /**
   * Stop the child via the §23.2 #28 escalation sequence. Resolves once
   * `process.exited` and `session.stopped` have been emitted.
   *
   * Sequence:
   *   1. emit `session.stop.requested`
   *   2. SIGINT + `process.signal_sent { signal: "SIGINT" }`
   *   3. wait `sigintGraceMs` for exit
   *   4. still alive? SIGKILL + `process.signal_sent {
   *        signal: "SIGKILL", reason: "sigint_grace_expired" }`
   *   5. on exit, `process.exited` + `session.stopped`
   *
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async stop(sessionId) {
    const state = this.children.get(sessionId);
    if (!state) {
      throw new Error(`ProcessSessionAdapter.stop: unknown sessionId '${sessionId}'`);
    }
    if (state.stoppedEmitted) return;
    if (state.stopPromise) return state.stopPromise;

    state.stopPromise = this._stopSequence(sessionId, state);
    try {
      await state.stopPromise;
    } finally {
      if (!state.stoppedEmitted) state.stopPromise = null;
    }
  }

  async _stopSequence(sessionId, state) {
    await this._emit({
      ...baseEvent({
        type: "session.stop.requested",
        workspace: this.workspace,
        sessionId,
        ts: this.now().toISOString(),
      }),
    });

    // Step 2: SIGINT.
    await this._sendSignal(state, sessionId, "SIGINT");

    // Step 3: wait for exit or grace expiry.
    const exitedInGrace = await this._waitForExit(state, this.sigintGraceMs);

    // Step 4: escalate to SIGKILL when SIGINT didn't take.
    if (!exitedInGrace) {
      await this._sendSignal(state, sessionId, "SIGKILL", { reason: "sigint_grace_expired" });
      // A small upper bound guards against pathological hosts where no exit
      // event arrives even after SIGKILL.
      const exitedAfterKill = await this._waitForExit(state, this.sigintGraceMs);
      if (!exitedAfterKill) {
        throw new Error(
          `ProcessSessionAdapter.stop: child did not exit after SIGKILL for sessionId '${sessionId}'`,
        );
      }
    }

    await this._emitExitAndStopped(state, sessionId);
  }

  /**
   * Force-kill the child WITHOUT the SIGINT grace window. Exposed only in the
   * session detail dock per §23.2 #28 — the small card stop control must
   * route to `stop()` instead. Every invocation is audited via the
   * `session.stop.requested { force: true }` event and the subsequent
   * `process.signal_sent { actor }` event.
   *
   * @param {string} sessionId
   * @param {{ userActor: string }} opts
   * @returns {Promise<void>}
   */
  async forceKill(sessionId, opts) {
    const userActor = opts && typeof opts.userActor === "string" ? opts.userActor : "";
    if (userActor.length === 0) {
      throw new Error("ProcessSessionAdapter.forceKill: userActor required (UI detail dock only)");
    }
    const state = this.children.get(sessionId);
    if (!state) {
      throw new Error(`ProcessSessionAdapter.forceKill: unknown sessionId '${sessionId}'`);
    }
    if (state.stoppedEmitted) return;
    if (state.stopPromise) return state.stopPromise;

    state.stopPromise = this._forceKillSequence(sessionId, state, userActor);
    try {
      await state.stopPromise;
    } finally {
      if (!state.stoppedEmitted) state.stopPromise = null;
    }
  }

  async _forceKillSequence(sessionId, state, userActor) {
    await this._emit({
      ...baseEvent({
        type: "session.stop.requested",
        workspace: this.workspace,
        sessionId,
        ts: this.now().toISOString(),
      }),
      force: true,
      actor: userActor,
    });

    await this._sendSignal(state, sessionId, "SIGKILL", {
      reason: "force_kill_requested",
      actor: userActor,
    });

    const exited = await this._waitForExit(state, this.sigintGraceMs);
    if (!exited) {
      throw new Error(
        `ProcessSessionAdapter.forceKill: child did not exit after SIGKILL for sessionId '${sessionId}'`,
      );
    }
    await this._emitExitAndStopped(state, sessionId);
  }

  /**
   * AsyncIterable surface for raw stdio chunks. SH-2-04 wires the durable
   * capture pipeline; today this yields nothing so the SessionAdapter shape
   * is complete and downstream consumers can plug in.
   *
   * @param {string} _sessionId
   * @returns {AsyncIterable<{ stream: "stdout" | "stderr", bytes: Uint8Array, ts: string }>}
   */
  // eslint-disable-next-line require-yield
  async *getRawStdio(_sessionId) {
    // TODO sh-2-04: yield captured stdio chunks.
    return;
  }

  /**
   * AsyncIterable surface for structured session events. `dumb_terminal` tier
   * does not produce structured events — this is here so the
   * `codex_app_server` / `hybrid` adapters can share the SessionAdapter type
   * shape. Always empty.
   *
   * @param {string} _sessionId
   * @returns {AsyncIterable<object>}
   */
  // eslint-disable-next-line require-yield
  async *getStructuredEvents(_sessionId) {
    return;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Send `signal` to the child and emit a `process.signal_sent` runtime event.
   * Swallows `kill()` errors: the downstream `process.exited` observation is
   * the source of truth, and a signal-send error here usually means the child
   * is already gone. Runtime-store append failures still propagate.
   *
   * @param {any} state
   * @param {string} sessionId
   * @param {EscalationSignal} signal
   * @param {{ reason?: string, actor?: string }} [extras]
   * @returns {Promise<any>}
   */
  _sendSignal(state, sessionId, signal, extras) {
    const pid = state.child ? state.child.pid : undefined;
    try {
      if (state.child && typeof state.child.kill === "function") {
        state.child.kill(signal);
      }
    } catch (_err) {
      // Swallow: ESRCH (already exited) is the common case during escalation.
    }
    /** @type {Record<string, any>} */
    const evt = {
      ...baseEvent({
        type: "process.signal_sent",
        workspace: this.workspace,
        sessionId,
        ts: this.now().toISOString(),
      }),
      signal,
    };
    if (typeof pid === "number") evt.pid = pid;
    if (extras && extras.reason) evt.reason = extras.reason;
    if (extras && extras.actor) evt.actor = extras.actor;
    return this._emit(evt);
  }

  /**
   * Wait up to `timeoutMs` for the child to exit. Resolves `true` when the
   * exit observer fires inside the window, `false` when the window elapses.
   *
   * @param {any} state
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  _waitForExit(state, timeoutMs) {
    if (state.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (state.child && typeof state.child.removeListener === "function") {
          state.child.removeListener("exit", onExit);
        }
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      if (state.child && typeof state.child.once === "function") {
        state.child.once("exit", onExit);
      } else {
        // No listener surface — fall back to the timeout.
      }
    });
  }

  /**
   * Emit `process.exited` (with whatever exit info we observed) followed by
   * `session.stopped`. Idempotent: subsequent calls are no-ops.
   *
   * @param {any} state
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async _emitExitAndStopped(state, sessionId) {
    if (state.stoppedEmitted) return;
    /** @type {Record<string, any>} */
    const exited = {
      ...baseEvent({
        type: "process.exited",
        workspace: this.workspace,
        sessionId,
        ts: this.now().toISOString(),
      }),
    };
    if (state.exitInfo) {
      if (state.exitInfo.code !== null) exited.code = state.exitInfo.code;
      if (state.exitInfo.signal !== null) exited.signal = state.exitInfo.signal;
    }
    await this._emit(exited);

    await this._emit({
      ...baseEvent({
        type: "session.stopped",
        workspace: this.workspace,
        sessionId,
        ts: this.now().toISOString(),
      }),
    });
    state.stoppedEmitted = true;
  }
}
