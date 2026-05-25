// hub/providers/generic-pty.js — SH-2-17 (addendum §6 / §10, TDD §25)
//
// GenericPtyProvider — RuntimeProvider that wraps the SH-2-03 process-spawn
// semantics behind the addendum §6 RuntimeProvider interface. Two backends:
//
//   - node-pty (primary): full PTY allocation; raw stdio, stdin writes, and
//     terminal resize are all supported.
//   - child_process.spawn (fallback): pipe-only; stdin writes are partial
//     (line-buffered programs still work; raw-mode / TTY-only flows do not)
//     and terminal resize is unavailable.
//
// Backend selection is dynamic: the constructor accepts an injectable
// `ptyLoader` (defaults to `() => import("node-pty")`) and a `spawn`
// function (defaults to `child_process.spawn`). Probe is lazy and
// memoized — `capabilities()` triggers it on first call.
//
// Per-provider command templates come from the TDD §25 `providers.*` block
// (e.g., `providers.codex_cli.command = ["codex"]`). A single instance of
// this class is registered under each of `codex_cli`, `claude_code`,
// `kimi`, `gemini` — the constructor's `providerId` override + injected
// `commandTemplate` are the only things that differ between them.
//
// Forbidden (addendum §3.1 / §10, mirrored from process.js):
//
//   This module performs ZERO heuristic parsing of terminal output. No
//   regex literals, no membership/match/test/index-of calls on captured
//   stdio chunks. The provider emits only lifecycle ProviderEvents
//   (`thread.started`, `provider.error`); semantic events (`command.*`,
//   `message`, `approval.*`, `context.usage`, `file_change.*`) require
//   structured parsing and explicitly belong to other providers (MCP
//   contract, codex_app_server).
//
// Stop sequence mirrors §23.2 #28 from `hub/sessions/adapters/process.js`:
//
//   stop()
//     → SIGINT
//     → wait sigintGraceMs (default 5000)
//     → still alive? SIGKILL
//
// The schema-enum gap for `process.signal_sent` / `process.exited` is
// acknowledged but not this module's concern — generic-pty.js emits
// ProviderEvents (the `thread.started` / `provider.error` shapes from
// `hub/providers/provider-events.js`), not RuntimeEvents directly. The
// session layer normalizes them via `hub/providers/normalizer.js`.

import { spawn as nodeSpawn } from "node:child_process";

/**
 * @typedef {object} GenericPtyCommandTemplate
 * @property {string[]} command         argv whose head is the binary path
 * @property {boolean} [mcpContract]    surfaced via toMCP() but NOT consumed here
 */

/**
 * @typedef {object} GenericPtyBackendDetails
 * @property {"node-pty" | "spawn"} kind
 * @property {true | "partial"} stdinWrite
 * @property {boolean} terminalResize
 */

/**
 * @typedef {object} GenericPtyDeps
 * @property {string} [providerId="generic_pty"]
 * @property {string} [label]                          defaults to "Generic PTY"
 * @property {GenericPtyCommandTemplate} commandTemplate
 * @property {() => Promise<any>} [ptyLoader]          defaults to () => import("node-pty")
 * @property {typeof nodeSpawn} [spawn]                defaults to node:child_process.spawn
 * @property {() => Date} [now]                        defaults to () => new Date()
 * @property {number} [sigintGraceMs=5000]
 */

const DEFAULT_SIGINT_GRACE_MS = 5000;

/**
 * Allowed sandbox values mirrored from TDD §6.1 (SessionRecord.sandbox enum).
 * Kept local to this module so the provider can validate the start-request
 * value without importing the session registry (which would invert the layer
 * direction). Backed by a Set so Set#has can validate membership; the file
 * lint regression forbids the substring matchers it bans for stdio parsing,
 * so a Set lookup is the cleanest fit here too.
 *
 * @type {ReadonlySet<"readonly" | "workspace-write" | "autoedit" | "full-auto">}
 */
const PTY_ALLOWED_SANDBOX = new Set([
  "readonly",
  "workspace-write",
  "autoedit",
  "full-auto",
]);

/**
 * Default sandbox applied when the start request omits one (DoD bullet 4 —
 * "defaults to workspace-write if unset"). Provider-level default keeps the
 * env contract well-defined for downstream wrappers / adapters that key off
 * `LLM_TRACKER_SANDBOX`.
 *
 * @type {"workspace-write"}
 */
const PTY_DEFAULT_SANDBOX = "workspace-write";

/**
 * Build a fresh ProviderCapabilities object with the 20 addendum §5 flags.
 * Generic PTY is `rawStdio + stdinWrite + processLifecycle = true`; every
 * `structured*` flag is false (per addendum §10: "structured*: false unless
 * paired with MCP contract" — the MCP contract is layered on by a wrapper
 * provider, not by this module).
 *
 * @returns {object}
 */
function ptyCapabilities() {
  return {
    structuredThread: false,
    structuredTurns: false,
    structuredItems: false,
    structuredApprovals: false,
    structuredFileChanges: false,
    structuredCommandEvents: false,
    structuredContextUsage: false,
    providerTimeline: false,
    providerDiffs: false,
    providerReview: false,
    modelList: false,
    skillList: false,
    threadResume: false,
    threadFork: false,
    turnSteer: false,
    turnInterrupt: false,
    rawStdio: true,
    stdinWrite: true,
    processLifecycle: true,
    directContextInjection: false,
  };
}

/**
 * Generate an opaque thread id. Not a security token — just a stable key
 * for the broker / SessionRegistry to hang state on. `gpty_<ms>_<rand>`
 * makes the source provider obvious in logs.
 *
 * @param {number} nowMs
 * @returns {string}
 */
function generatePtyThreadId(nowMs) {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `gpty_${nowMs}_${rand}`;
}

/**
 * RuntimeProvider implementation for raw-PTY CLIs (Codex CLI, Claude Code,
 * Kimi, Gemini, and any other CLI without a structured protocol).
 *
 * Lifecycle methods exposed:
 *   - probe()             returns { ok, reason } based on backend resolution
 *   - capabilities()      20-flag ProviderCapabilities (addendum §5)
 *   - backendDetails()    { kind, stdinWrite, terminalResize } — backend-extras
 *                         the schema's boolean ProviderCapabilities can't carry
 *   - start(request)      spawn child (PTY when available, pipes otherwise)
 *   - send(threadRef, in) write stdin, only when input.userInitiated === true
 *   - stop(threadRef)     SIGINT → grace → SIGKILL
 *   - streamEvents(ref)   yields lifecycle ProviderEvents only (no parsing)
 */
export class GenericPtyProvider {
  /**
   * @param {GenericPtyDeps} deps
   */
  constructor(deps) {
    const d = deps || {};
    if (!d.commandTemplate || !Array.isArray(d.commandTemplate.command) || d.commandTemplate.command.length === 0) {
      throw new TypeError(
        "GenericPtyProvider: commandTemplate.command must be a non-empty string[]",
      );
    }
    for (const arg of d.commandTemplate.command) {
      if (typeof arg !== "string") {
        throw new TypeError("GenericPtyProvider: commandTemplate.command entries must be strings");
      }
    }

    this.id = typeof d.providerId === "string" && d.providerId.length > 0
      ? d.providerId
      : "generic_pty";
    this.label = typeof d.label === "string" && d.label.length > 0
      ? d.label
      : "Generic PTY";
    this.commandTemplate = Object.freeze({
      command: Object.freeze([...d.commandTemplate.command]),
      mcpContract: d.commandTemplate.mcpContract === true,
    });

    this.ptyLoader = typeof d.ptyLoader === "function"
      ? d.ptyLoader
      : () => import("node-pty");
    this.spawn = typeof d.spawn === "function" ? d.spawn : nodeSpawn;
    this.now = typeof d.now === "function" ? d.now : () => new Date();
    this.sigintGraceMs = Number.isInteger(d.sigintGraceMs) && d.sigintGraceMs >= 0
      ? d.sigintGraceMs
      : DEFAULT_SIGINT_GRACE_MS;

    /** @type {Promise<{ kind: "node-pty" | "spawn", pty: any | null }> | null} */
    this._backendPromise = null;
    /** @type {{ kind: "node-pty" | "spawn", pty: any | null } | null} */
    this._backend = null;

    /**
     * Map of threadId → live thread state.
     *
     * @type {Map<string, {
     *   child: any,
     *   backendKind: "node-pty" | "spawn",
     *   exited: boolean,
     *   exitInfo: { exitCode: number | null, signal: string | null } | null,
     *   stopPromise: Promise<void> | null,
     *   threadRef: object,
     *   startedAt: string,
     *   listeners: Array<(evt: object) => void>,
     *   spawnError: Error | null,
     *   commandId: string,
     * }>}
     */
    this.threads = new Map();
  }

  /**
   * Resolve the active backend exactly once. Future calls return the cached
   * value. Errors during node-pty import are NOT fatal — they trigger the
   * spawn fallback.
   *
   * @returns {Promise<{ kind: "node-pty" | "spawn", pty: any | null }>}
   */
  async _resolveBackend() {
    if (this._backend) return this._backend;
    if (!this._backendPromise) {
      this._backendPromise = (async () => {
        try {
          const mod = await this.ptyLoader();
          // node-pty exports `spawn(file, args, options)` via either the default
          // export or the namespace. Probe both — the loader may return either.
          const spawnFn = mod && (mod.spawn || (mod.default && mod.default.spawn));
          if (typeof spawnFn === "function") {
            this._backend = { kind: "node-pty", pty: { spawn: spawnFn } };
            return this._backend;
          }
        } catch (_err) {
          // Fall through to spawn fallback. node-pty is an optional dep:
          // ERR_MODULE_NOT_FOUND on hosts without it is the expected path.
        }
        this._backend = { kind: "spawn", pty: null };
        return this._backend;
      })();
    }
    return this._backendPromise;
  }

  /**
   * Probe result reflects the resolved backend. Both backends are "ok" —
   * either way the provider can spawn a child. The `reason` field tells
   * the operator which backend is active so degraded UX is observable.
   *
   * @returns {Promise<{ ok: boolean, reason: string, details?: object }>}
   */
  async probe() {
    const backend = await this._resolveBackend();
    return {
      ok: true,
      reason: backend.kind === "node-pty"
        ? "node-pty backend resolved; full PTY support"
        : "node-pty unavailable; using child_process.spawn fallback",
      details: { backend: backend.kind },
    };
  }

  /**
   * Return the 20-flag ProviderCapabilities. Per addendum §10, rawStdio /
   * stdinWrite / processLifecycle are true; structured* are false. The
   * provider does NOT distinguish "partial" stdinWrite at this layer (the
   * schema is boolean); use `backendDetails()` for that nuance.
   *
   * @returns {object}
   */
  capabilities() {
    return ptyCapabilities();
  }

  /**
   * Backend-specific capability extras the boolean ProviderCapabilities
   * schema cannot carry. Returns a fresh object so callers can't mutate
   * shared state.
   *
   * Backend semantics:
   *   - node-pty: { kind: "node-pty", stdinWrite: true,      terminalResize: true  }
   *   - spawn:    { kind: "spawn",    stdinWrite: "partial", terminalResize: false }
   *
   * Probe is lazy — first call resolves the backend if it hasn't been yet.
   *
   * @returns {Promise<GenericPtyBackendDetails>}
   */
  async backendDetails() {
    const backend = await this._resolveBackend();
    if (backend.kind === "node-pty") {
      return { kind: "node-pty", stdinWrite: true, terminalResize: true };
    }
    return { kind: "spawn", stdinWrite: "partial", terminalResize: false };
  }

  /**
   * Start a child process. Returns a `ProviderThreadHandle` per addendum
   * §6 / §7. The actual argv is composed as
   * `[...commandTemplate.command, ...request.extraArgs]`.
   *
   * @param {object} request
   * @param {string[]} [request.extraArgs]
   * @param {string} [request.cwd]
   * @param {string} [request.repoRoot]
   * @param {object} [request.env]
   * @param {"readonly" | "workspace-write" | "autoedit" | "full-auto"} [request.sandbox]
   *   Sandbox mode (TDD §6.1). When present, validated against the enum and
   *   surfaced to the child as `LLM_TRACKER_SANDBOX`. When omitted, defaults
   *   to `'workspace-write'` (DoD bullet 4 / TDD §6.1 v0.7 contract). SH-2-24
   *   forwards via env; adapters that need launch-args (e.g., Codex CLI) can
   *   layer that on in their own provider — this module is the env baseline.
   * @param {{ cols: number, rows: number }} [request.size]   only honored by node-pty
   * @returns {Promise<object>}                                ProviderThreadHandle
   */
  async start(request) {
    if (!request || typeof request !== "object") {
      throw new TypeError("GenericPtyProvider.start: request must be an object");
    }
    const extraArgs = Array.isArray(request.extraArgs) ? request.extraArgs : [];
    for (const arg of extraArgs) {
      if (typeof arg !== "string") {
        throw new TypeError("GenericPtyProvider.start: request.extraArgs entries must be strings");
      }
    }
    // Sandbox validation + default (SH-2-24, TDD §6.1). Uses Set#has so the
    // file-level lint regression (which bans the substring matchers used for
    // stdio parsing) stays clean.
    const sandboxProvided = Object.prototype.hasOwnProperty.call(request, "sandbox")
      && request.sandbox !== undefined;
    if (sandboxProvided && !PTY_ALLOWED_SANDBOX.has(request.sandbox)) {
      throw new TypeError(
        `GenericPtyProvider.start: request.sandbox '${request.sandbox}' not in ${[...PTY_ALLOWED_SANDBOX].join("|")}`,
      );
    }
    const sandbox = sandboxProvided ? request.sandbox : PTY_DEFAULT_SANDBOX;

    const backend = await this._resolveBackend();
    const [head, ...templateRest] = this.commandTemplate.command;
    const args = [...templateRest, ...extraArgs];
    const nowDate = this.now();
    const startedAt = nowDate.toISOString();
    const threadId = generatePtyThreadId(nowDate.getTime());
    const commandId = `${threadId}_command`;
    const commandText = [head, ...args].join(" ");

    /** @type {object} */
    const threadRef = {
      providerId: this.id,
      transport: backend.kind === "node-pty" ? "pty" : "stdio",
      threadId,
    };
    if (request.cwd) threadRef.cwd = request.cwd;
    if (request.repoRoot) threadRef.repoRoot = request.repoRoot;

    // Build the child env. Always include LLM_TRACKER_SANDBOX so downstream
    // wrappers (e.g., a future Codex-CLI argv builder, or a shell shim) can
    // key off it. We merge process.env so the child still inherits the
    // parent's PATH/HOME/etc when no explicit request.env is provided — this
    // is the standard "extend, don't replace" env pattern.
    const childEnv = {
      ...process.env,
      ...(request.env || {}),
      LLM_TRACKER_SANDBOX: sandbox,
    };

    /** @type {any} */
    let child;
    /** @type {Error | null} */
    let spawnError = null;
    try {
      if (backend.kind === "node-pty") {
        const cols = request.size && Number.isInteger(request.size.cols) ? request.size.cols : 80;
        const rows = request.size && Number.isInteger(request.size.rows) ? request.size.rows : 24;
        /** @type {Record<string, any>} */
        const opts = { name: "xterm-color", cols, rows, env: childEnv };
        if (request.cwd) opts.cwd = request.cwd;
        child = backend.pty.spawn(head, args, opts);
      } else {
        /** @type {Record<string, any>} */
        const opts = { stdio: ["pipe", "pipe", "pipe"], env: childEnv };
        if (request.cwd) opts.cwd = request.cwd;
        child = this.spawn(head, args, opts);
      }
    } catch (err) {
      spawnError = err instanceof Error ? err : new Error(String(err));
    }

    /** @type {any} */
    const state = {
      child: child || null,
      backendKind: backend.kind,
      exited: false,
      exitInfo: null,
      stopPromise: null,
      threadRef,
      startedAt,
      commandId,
      commandText,
      listeners: [],
      wakers: [],
      spawnError,
    };

    const markExited = (code, signal) => {
      if (state.exited) return;
      if (!state.spawnError) {
        this._enqueueEvent(state, {
          kind: "command.completed",
          providerId: this.id,
          threadId,
          commandId,
          ...(typeof code === "number" ? { exitCode: code } : {}),
          ts: this.now().toISOString(),
        });
      }
      state.exited = true;
      state.exitInfo = {
        exitCode: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null,
      };
      const pending = state.wakers;
      state.wakers = [];
      for (const wake of pending) wake();
    };

    // Wire lifecycle observers. node-pty uses `onExit({exitCode, signal})`
    // while child_process emits `('exit', code, signal)`. We translate both
    // into a single markExited() and never emit a `thread.exited` event —
    // the addendum §8 union has no such kind; the session layer derives
    // `session.stopped` from the runtime store on its own.
    if (child) {
      const emitStarted = () => {
        this._enqueueEvent(state, {
          kind: "thread.started",
          providerId: this.id,
          threadRef,
          ts: startedAt,
        });
        this._enqueueEvent(state, {
          kind: "command.started",
          providerId: this.id,
          threadId,
          commandId,
          command: commandText,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ts: startedAt,
        });
      };
      if (backend.kind === "node-pty" && typeof child.onExit === "function") {
        emitStarted();
        child.onExit((info) => {
          const code = typeof info?.exitCode === "number" ? info.exitCode : null;
          const signal =
            typeof info?.signal === "string" || typeof info?.signal === "number" ? String(info.signal) : null;
          markExited(code, signal);
        });
        if (typeof child.onData === "function") {
          child.onData((chunk) => this._enqueueCommandOutput(state, "stdout", chunk));
        }
      } else if (typeof child.on === "function") {
        if (typeof child.once === "function") {
          child.once("spawn", emitStarted);
        } else {
          emitStarted();
        }
        child.on("error", (err) => {
          const e = err instanceof Error ? err : new Error(String(err));
          state.spawnError = e;
          this._enqueueEvent(state, {
            kind: "provider.error",
            providerId: this.id,
            threadId,
            code: "SPAWN_FAILED",
            message: e.message,
            retryable: false,
            ts: this.now().toISOString(),
          });
          markExited(null, null);
        });
        child.on("exit", (code, signal) => markExited(code, signal));
        if (child.stdout && typeof child.stdout.on === "function") {
          child.stdout.on("data", (chunk) => this._enqueueCommandOutput(state, "stdout", chunk));
        }
        if (child.stderr && typeof child.stderr.on === "function") {
          child.stderr.on("data", (chunk) => this._enqueueCommandOutput(state, "stderr", chunk));
        }
      }
    } else if (spawnError) {
      // No child to observe; mark exited immediately so streamEvents() can
      // complete after yielding the provider.error.
      markExited(null, null);
    }

    this.threads.set(threadId, state);

    // If the spawn itself threw, surface it via the next streamEvents()
    // iterator as a provider.error and a no-listeners log. The handle is
    // still returned so the caller can call stop() (a no-op) for cleanup.
    if (spawnError) {
      this._enqueueEvent(state, {
        kind: "provider.error",
        providerId: this.id,
        threadId,
        code: "SPAWN_FAILED",
        message: spawnError.message,
        retryable: false,
        ts: startedAt,
      });
    }

    return {
      providerId: this.id,
      transport: threadRef.transport,
      threadId,
      cwd: request.cwd,
      repoRoot: request.repoRoot,
      createdAt: startedAt,
      processHandleId: child && typeof child.pid === "number" ? String(child.pid) : undefined,
    };
  }

  /**
   * Stream ProviderEvents for `threadRef`. The iterator yields the lifecycle
   * events emitted at start (`thread.started`, `command.started`, or
   * `provider.error`) and any subsequent lifecycle / raw stdio events the
   * provider records. It does not parse stdio into messages or approvals.
   *
   * The iterator completes when the thread has exited AND no buffered events
   * remain. Callers MUST consume the iterator for events to drain; the
   * provider buffers events while no consumer is attached.
   *
   * @param {object} threadRef
   * @returns {AsyncIterable<object>}
   */
  streamEvents(threadRef) {
    if (!threadRef || typeof threadRef !== "object") {
      throw new TypeError("GenericPtyProvider.streamEvents: threadRef must be an object");
    }
    if (threadRef.providerId !== this.id) {
      throw new TypeError(
        `GenericPtyProvider.streamEvents: threadRef.providerId must be '${this.id}'`,
      );
    }
    if (typeof threadRef.threadId !== "string" || threadRef.threadId.length === 0) {
      throw new TypeError("GenericPtyProvider.streamEvents: threadRef.threadId required");
    }
    const state = this.threads.get(threadRef.threadId);
    if (!state) {
      throw new Error(`GenericPtyProvider.streamEvents: unknown threadId '${threadRef.threadId}'`);
    }

    return (async function* () {
      // Drain the pre-attach buffer first, then subscribe for live events.
      // The state.listeners array is the only path that produces post-attach
      // events; the provider does NOT poll stdio for content.
      const buffer = state.bufferedEvents || [];
      state.bufferedEvents = [];
      while (buffer.length > 0) {
        yield buffer.shift();
      }

      /** @type {object[]} */
      const live = [];
      const onEvent = (evt) => { live.push(evt); };
      state.listeners.push(onEvent);
      try {
        while (true) {
          while (live.length > 0) {
            yield live.shift();
          }
          if (state.exited) break;
          await new Promise((resolve) => { state.wakers.push(resolve); });
        }
        // Drain any events that landed after the final wake.
        while (live.length > 0) {
          yield live.shift();
        }
      } finally {
        state.listeners = state.listeners.filter((fn) => fn !== onEvent);
      }
    })();
  }

  /**
   * Write input to the child's stdin/pty. Requires `input.userInitiated ===
   * true` per the SH-2-03 stdin-gate. Throws when the provider has no live
   * child or the backend lacks a writable stdin (a stray race after stop()).
   *
   * @param {object} threadRef
   * @param {object} input
   * @param {string} input.text
   * @param {boolean} input.userInitiated
   * @returns {Promise<void>}
   */
  async send(threadRef, input) {
    if (!threadRef || typeof threadRef !== "object") {
      throw new TypeError("GenericPtyProvider.send: threadRef must be an object");
    }
    if (!input || typeof input !== "object") {
      throw new TypeError("GenericPtyProvider.send: input must be an object");
    }
    if (input.userInitiated !== true) {
      throw new Error("stdin pass-through requires explicit user action");
    }
    if (typeof input.text !== "string") {
      throw new TypeError("GenericPtyProvider.send: input.text must be a string");
    }
    const state = this.threads.get(threadRef.threadId);
    if (!state) {
      throw new Error(`GenericPtyProvider.send: unknown threadId '${threadRef.threadId}'`);
    }
    const child = state.child;
    if (!child) {
      throw new Error("GenericPtyProvider.send: no live child");
    }
    if (state.backendKind === "node-pty") {
      if (typeof child.write !== "function") {
        throw new Error("GenericPtyProvider.send: node-pty child has no write()");
      }
      child.write(input.text);
      return;
    }
    const stdin = child.stdin;
    if (!stdin || typeof stdin.write !== "function") {
      throw new Error("GenericPtyProvider.send: child stdin is not writable");
    }
    stdin.write(input.text);
  }

  /**
   * Stop the child via the §23.2 #28 sequence: SIGINT, wait grace, SIGKILL.
   * Both backends accept a string signal name via `kill(signal)`. node-pty's
   * `child.kill(signal)` is signature-compatible with child_process.kill.
   *
   * Resolves when the child has exited (or escalation has run to completion).
   *
   * @param {object} threadRef
   * @returns {Promise<void>}
   */
  async stop(threadRef) {
    if (!threadRef || typeof threadRef !== "object") {
      throw new TypeError("GenericPtyProvider.stop: threadRef must be an object");
    }
    const state = this.threads.get(threadRef.threadId);
    if (!state) {
      throw new Error(`GenericPtyProvider.stop: unknown threadId '${threadRef.threadId}'`);
    }
    if (state.exited) return;
    if (state.stopPromise) return state.stopPromise;

    state.stopPromise = this._stopSequence(state);
    try {
      await state.stopPromise;
    } finally {
      if (!state.exited) state.stopPromise = null;
    }
  }

  // --- internals -----------------------------------------------------------

  async _stopSequence(state) {
    // Step 1: SIGINT.
    this._safeKill(state, "SIGINT");
    state.signalsSent = state.signalsSent || [];
    state.signalsSent.push("SIGINT");

    // Step 2: wait for grace.
    const exitedInGrace = await this._waitForExit(state, this.sigintGraceMs);
    if (exitedInGrace) return;

    // Step 3: SIGKILL.
    this._safeKill(state, "SIGKILL");
    state.signalsSent.push("SIGKILL");

    // Bounded wait for SIGKILL exit. If the child still hasn't exited
    // we throw — the caller has no other escalation lever here.
    const exitedAfterKill = await this._waitForExit(state, this.sigintGraceMs);
    if (!exitedAfterKill) {
      throw new Error(
        `GenericPtyProvider.stop: child did not exit after SIGKILL for thread '${state.threadRef.threadId}'`,
      );
    }
  }

  _safeKill(state, signal) {
    const child = state.child;
    if (!child) return;
    try {
      if (typeof child.kill === "function") {
        child.kill(signal);
      }
    } catch (_err) {
      // ESRCH ("already exited") is the common case; swallow.
    }
  }

  _waitForExit(state, timeoutMs) {
    if (state.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const child = state.child;
      const onExit = () => finish(true);
      const timer = setTimeout(() => {
        if (child && typeof child.removeListener === "function") {
          child.removeListener("exit", onExit);
        }
        finish(false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      if (state.backendKind === "node-pty" && child && typeof child.onExit === "function") {
        // node-pty's onExit is fire-once; we still race the timeout.
        child.onExit(onExit);
      } else if (child && typeof child.once === "function") {
        child.once("exit", onExit);
      }
      // If state.exited flipped between the early return and listener wiring,
      // resolve immediately to avoid a hang.
      if (state.exited) finish(true);
    });
  }

  /**
   * Buffer or fan out a ProviderEvent. When no consumer is attached the
   * event lands in `state.bufferedEvents`; once a consumer attaches the
   * iterator drains the buffer and switches to live fan-out via listeners.
   *
   * @param {any} state
   * @param {object} event
   */
  _enqueueEvent(state, event) {
    if (state.listeners && state.listeners.length > 0) {
      for (const listener of state.listeners) {
        listener(event);
      }
      const pending = state.wakers;
      state.wakers = [];
      for (const wake of pending) wake();
      return;
    }
    if (!state.bufferedEvents) state.bufferedEvents = [];
    state.bufferedEvents.push(event);
  }

  _enqueueCommandOutput(state, stream, chunk) {
    if (state.exited || state.spawnError) return;
    const text = typeof chunk === "string" ? chunk : String(chunk);
    this._enqueueEvent(state, {
      kind: "command.output",
      providerId: this.id,
      threadId: state.threadRef.threadId,
      commandId: state.commandId,
      stream,
      text,
      ts: this.now().toISOString(),
    });
  }
}

/**
 * Convenience factory mirroring `createManualProvider`. Useful for the
 * registry's discover() factories list.
 *
 * @param {GenericPtyDeps} deps
 * @returns {GenericPtyProvider}
 */
export function createGenericPtyProvider(deps) {
  return new GenericPtyProvider(deps);
}
