// test/providers-generic-pty.test.js — SH-2-17 (addendum §6 / §10, TDD §25)
//
// GenericPtyProvider acceptance tests.
//
// Scope:
//   - backend selection: node-pty primary, child_process.spawn fallback when
//     the loader rejects (ERR_MODULE_NOT_FOUND or any throw).
//   - capabilities() returns the 20-flag ProviderCapabilities with rawStdio /
//     stdinWrite / processLifecycle = true; structured* = false.
//   - backendDetails() surfaces { kind, stdinWrite, terminalResize } — the
//     "partial" stdinWrite for spawn fallback the boolean schema can't carry.
//   - start() composes argv as [...template.command, ...request.extraArgs].
//   - stop() runs SIGINT → 5s grace → SIGKILL (§23.2 #28 mirror).
//   - send() requires { userInitiated: true } per the SH-2-03 stdin gate.
//   - streamEvents() yields thread.started / provider.error and nothing else;
//     completes after exit.
//   - registry/broker integration: the provider is `broker.register`-able and
//     dispatches through the broker like ManualProvider.
//   - Lint regression: source contains no regex literal, no `.includes(`,
//     no `.match(`, no `.test(`, no `.indexOf(`, no `RegExp(` — the addendum
//     §3.1 / §10 invariant that this provider performs zero stdio parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { GenericPtyProvider, createGenericPtyProvider } from "../hub/providers/generic-pty.js";
import { ProviderRegistry } from "../hub/providers/registry.js";
import { ProviderBroker, BROKER_ERROR_CODES } from "../hub/providers/broker.js";
import {
  PROVIDER_CAPABILITY_KEYS,
  validateProviderCapabilities,
} from "../hub/providers/capabilities.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(HERE, "..", "hub", "providers", "generic-pty.js");

// --- test doubles -----------------------------------------------------------

/**
 * Fake child_process child. Defaults to ignoring SIGINT, exiting on SIGKILL —
 * lets us drive the §23.2 #28 escalation deterministically.
 */
function makeFakeSpawnChild(opts = {}) {
  const exitOn = Array.isArray(opts.exitOn) ? opts.exitOn : ["SIGKILL"];
  const exitCode = opts.exitCode === undefined ? null : opts.exitCode;
  const child = new EventEmitter();
  /** @type {any} */ (child).pid = opts.pid || 4242;
  /** @type {any} */ (child).stdin = {
    written: [],
    write(buf) { this.written.push(buf); return true; },
  };
  /** @type {any} */ (child).stdout = new EventEmitter();
  /** @type {any} */ (child).stderr = new EventEmitter();
  /** @type {string[]} */
  const killCalls = [];
  /** @type {any} */ (child).killCalls = killCalls;
  /** @type {any} */ (child).kill = (signal) => {
    killCalls.push(signal);
    const accepted = exitOn.filter((s) => s === signal).length > 0;
    if (accepted) {
      setImmediate(() => child.emit("exit", exitCode, signal));
    }
    return true;
  };
  if (opts.emitSpawn !== false) setImmediate(() => child.emit("spawn"));
  return child;
}

/**
 * Fake node-pty child. Mirrors the parts of the node-pty API the provider
 * touches: `write(text)`, `kill(signal)`, `onExit(cb)`.
 */
function makeFakePtyChild(opts = {}) {
  const exitOn = Array.isArray(opts.exitOn) ? opts.exitOn : ["SIGKILL"];
  const exitCode = opts.exitCode === undefined ? 0 : opts.exitCode;
  const exitCallbacks = [];
  const dataCallbacks = [];
  const writes = [];
  const killCalls = [];
  return {
    pid: opts.pid || 5252,
    writes,
    killCalls,
    onExit(cb) { exitCallbacks.push(cb); },
    onData(cb) { dataCallbacks.push(cb); },
    emitData(text) {
      for (const cb of dataCallbacks) cb(text);
    },
    write(text) { writes.push(text); },
    kill(signal) {
      killCalls.push(signal);
      const accepted = exitOn.filter((s) => s === signal).length > 0;
      if (accepted) {
        setImmediate(() => {
          for (const cb of exitCallbacks) cb({ exitCode, signal });
        });
      }
    },
  };
}

/**
 * Build a fake node-pty module surface. The provider probes for `mod.spawn`
 * and falls back to `mod.default.spawn`.
 */
function fakePtyModule(spawnFn) {
  return { spawn: spawnFn };
}

function makeProvider(overrides = {}) {
  const spawnCalls = [];
  const ptyCalls = [];
  const spawn = overrides.spawn || ((command, args, opts) => {
    spawnCalls.push({ command, args, opts });
    return makeFakeSpawnChild();
  });
  const ptySpawn = overrides.ptySpawn || ((command, args, opts) => {
    ptyCalls.push({ command, args, opts });
    return makeFakePtyChild();
  });
  const ptyLoader = overrides.ptyLoader || (async () => fakePtyModule(ptySpawn));
  const provider = new GenericPtyProvider({
    providerId: overrides.providerId || "codex_cli",
    label: overrides.label || "Codex CLI",
    commandTemplate: overrides.commandTemplate || { command: ["codex"], mcpContract: true },
    ptyLoader,
    spawn,
    now: overrides.now || (() => new Date("2026-05-24T00:00:00.000Z")),
    sigintGraceMs: overrides.sigintGraceMs === undefined ? 25 : overrides.sigintGraceMs,
  });
  return { provider, spawnCalls, ptyCalls };
}

// --- construction / shape ---------------------------------------------------

test("GenericPtyProvider: id / label come from constructor with defaults", () => {
  const { provider } = makeProvider();
  assert.equal(provider.id, "codex_cli");
  assert.equal(provider.label, "Codex CLI");

  const defaultProvider = new GenericPtyProvider({
    commandTemplate: { command: ["any-bin"] },
    ptyLoader: async () => { throw new Error("no node-pty"); },
  });
  assert.equal(defaultProvider.id, "generic_pty");
  assert.equal(defaultProvider.label, "Generic PTY");
});

test("GenericPtyProvider: rejects bad commandTemplate at construction", () => {
  assert.throws(
    () => new GenericPtyProvider({ commandTemplate: { command: [] } }),
    TypeError,
  );
  assert.throws(
    () => new GenericPtyProvider({ commandTemplate: { command: ["ok", 5] } }),
    TypeError,
  );
  assert.throws(
    () => new GenericPtyProvider({}),
    TypeError,
  );
});

test("createGenericPtyProvider factory exposes the class instance", () => {
  const p = createGenericPtyProvider({ commandTemplate: { command: ["x"] } });
  assert.ok(p instanceof GenericPtyProvider);
});

// --- capabilities -----------------------------------------------------------

test("capabilities(): 20 ProviderCapabilities flags with rawStdio/stdinWrite/processLifecycle true and structured* false", () => {
  const { provider } = makeProvider();
  const caps = provider.capabilities();
  // Schema-conformant: every key boolean, only the 20 known keys.
  validateProviderCapabilities(caps);
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    assert.equal(typeof caps[key], "boolean", `cap ${key} must be boolean`);
  }
  assert.equal(caps.rawStdio, true);
  assert.equal(caps.stdinWrite, true);
  assert.equal(caps.processLifecycle, true);
  // structured* all false
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    if (key.startsWith("structured") || key === "providerTimeline" || key === "providerDiffs" || key === "providerReview" || key === "modelList" || key === "skillList" || key === "threadResume" || key === "threadFork" || key === "turnSteer" || key === "turnInterrupt" || key === "directContextInjection") {
      assert.equal(caps[key], false, `cap ${key} must be false for generic-pty`);
    }
  }
});

test("capabilities(): returns a fresh object so callers can't mutate shared state", () => {
  const { provider } = makeProvider();
  const a = provider.capabilities();
  const b = provider.capabilities();
  assert.notEqual(a, b);
  a.rawStdio = false;
  assert.equal(b.rawStdio, true);
});

test("backendDetails(): node-pty backend → kind=node-pty, stdinWrite=true, terminalResize=true", async () => {
  const { provider } = makeProvider({
    ptyLoader: async () => fakePtyModule(() => makeFakePtyChild()),
  });
  const details = await provider.backendDetails();
  assert.deepEqual(details, { kind: "node-pty", stdinWrite: true, terminalResize: true });
});

test("backendDetails(): spawn fallback → kind=spawn, stdinWrite='partial', terminalResize=false", async () => {
  const { provider } = makeProvider({
    ptyLoader: async () => { throw new Error("ERR_MODULE_NOT_FOUND"); },
  });
  const details = await provider.backendDetails();
  assert.deepEqual(details, { kind: "spawn", stdinWrite: "partial", terminalResize: false });
});

test("backendDetails(): fallback when loader returns module without .spawn", async () => {
  const { provider } = makeProvider({
    ptyLoader: async () => ({ default: { somethingElse: true } }),
  });
  const details = await provider.backendDetails();
  assert.equal(details.kind, "spawn");
});

test("probe(): reports the resolved backend in its reason field", async () => {
  const a = makeProvider({ ptyLoader: async () => fakePtyModule(() => makeFakePtyChild()) }).provider;
  const ra = await a.probe();
  assert.equal(ra.ok, true);
  assert.equal(ra.details.backend, "node-pty");

  const b = makeProvider({ ptyLoader: async () => { throw new Error("nope"); } }).provider;
  const rb = await b.probe();
  assert.equal(rb.ok, true);
  assert.equal(rb.details.backend, "spawn");
});

// --- start: argv composition + transport per backend ------------------------

test("start(): node-pty backend composes argv from template+extraArgs, transport='pty'", async () => {
  const { provider, ptyCalls } = makeProvider({
    commandTemplate: { command: ["codex", "--no-color"] },
  });
  const handle = await provider.start({ extraArgs: ["--task", "abc"], cwd: "/work" });
  assert.equal(handle.providerId, "codex_cli");
  assert.equal(handle.transport, "pty");
  assert.equal(handle.cwd, "/work");
  assert.equal(typeof handle.threadId, "string");
  assert.ok(handle.threadId.startsWith("gpty_"));
  assert.equal(ptyCalls.length, 1);
  assert.equal(ptyCalls[0].command, "codex");
  assert.deepEqual(ptyCalls[0].args, ["--no-color", "--task", "abc"]);
  assert.equal(ptyCalls[0].opts.cwd, "/work");
});

test("start(): spawn fallback composes argv and uses transport='stdio'", async () => {
  const { provider, spawnCalls } = makeProvider({
    ptyLoader: async () => { throw new Error("no pty"); },
    commandTemplate: { command: ["claude"] },
  });
  const handle = await provider.start({ extraArgs: ["chat", "--task", "xyz"] });
  assert.equal(handle.transport, "stdio");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "claude");
  assert.deepEqual(spawnCalls[0].args, ["chat", "--task", "xyz"]);
  assert.deepEqual(spawnCalls[0].opts.stdio, ["pipe", "pipe", "pipe"]);
});

test("start(): rejects non-object request and non-string extraArgs", async () => {
  const { provider } = makeProvider();
  await assert.rejects(() => provider.start(null), TypeError);
  await assert.rejects(() => provider.start({ extraArgs: [5] }), TypeError);
});

test("start(): two calls produce distinct threadIds", async () => {
  const { provider } = makeProvider({
    now: (() => {
      let i = 0;
      return () => new Date(1717000000000 + i++);
    })(),
  });
  const a = await provider.start({});
  const b = await provider.start({});
  assert.notEqual(a.threadId, b.threadId);
});

// --- streamEvents: lifecycle only ------------------------------------------

test("streamEvents(): yields thread.started, then completes after exit (node-pty backend)", async () => {
  const ptyChild = makeFakePtyChild({ exitOn: ["SIGINT"], exitCode: 0 });
  const { provider } = makeProvider({
    ptyLoader: async () => fakePtyModule(() => ptyChild),
  });
  const handle = await provider.start({});

  const events = [];
  const collector = (async () => {
    for await (const e of provider.streamEvents(handle)) {
      events.push(e);
    }
  })();

  await provider.stop(handle);
  await collector;

  // We deliberately do not emit a thread.exited shape (addendum §8 union has
  // no such kind); command.completed carries the raw process lifecycle close.
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, "thread.started");
  assert.equal(events[0].providerId, "codex_cli");
  assert.equal(events[0].threadRef.threadId, handle.threadId);
  assert.equal(events[0].threadRef.transport, "pty");
  assert.equal(events[1].kind, "command.started");
  assert.equal(events[2].kind, "command.completed");
});

test("streamEvents(): spawnError yields a provider.error event (no thread.started)", async () => {
  const { provider } = makeProvider({
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: () => { throw new Error("ENOENT: codex not found"); },
  });
  const handle = await provider.start({});
  const events = [];
  for await (const e of provider.streamEvents(handle)) {
    events.push(e);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "provider.error");
  assert.equal(events[0].code, "SPAWN_FAILED");
  assert.equal(events[0].retryable, false);
  assert.equal(events[0].providerId, "codex_cli");
});

test("streamEvents(): async child_process spawn error yields provider.error without crashing", async () => {
  const child = makeFakeSpawnChild({ emitSpawn: false });
  const { provider } = makeProvider({
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: () => child,
  });
  const handle = await provider.start({});
  const events = [];
  const collector = (async () => {
    for await (const e of provider.streamEvents(handle)) {
      events.push(e);
    }
  })();

  child.emit("error", new Error("spawn definitely-missing-session-hub-bin ENOENT"));
  await collector;

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "provider.error");
  assert.equal(events[0].code, "SPAWN_FAILED");
  assert.match(events[0].message, /ENOENT/);
});

test("streamEvents(): spawn stdout/stderr are surfaced as raw command.output events", async () => {
  const child = makeFakeSpawnChild({ exitOn: ["SIGINT"] });
  const { provider } = makeProvider({
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: () => child,
  });
  const handle = await provider.start({});
  const events = [];
  const collector = (async () => {
    for await (const e of provider.streamEvents(handle)) {
      events.push(e);
    }
  })();

  await new Promise((resolve) => child.once("spawn", resolve));
  child.stdout.emit("data", Buffer.from("hello\n"));
  child.stderr.emit("data", "warn\n");
  await provider.stop(handle);
  await collector;

  assert.deepEqual(
    events.filter((e) => e.kind === "command.output").map((e) => [e.stream, e.text]),
    [["stdout", "hello\n"], ["stderr", "warn\n"]],
  );
});

test("streamEvents(): validates threadRef shape", async () => {
  const { provider } = makeProvider();
  await provider.start({});
  assert.throws(() => provider.streamEvents(null), TypeError);
  assert.throws(() => provider.streamEvents({}), TypeError);
  assert.throws(() => provider.streamEvents({ providerId: "wrong", threadId: "x" }), TypeError);
});

// --- send: stdin gate -------------------------------------------------------

test("send(): writes via node-pty child.write() on userInitiated=true", async () => {
  const ptyChild = makeFakePtyChild();
  const { provider } = makeProvider({
    ptyLoader: async () => fakePtyModule(() => ptyChild),
  });
  const handle = await provider.start({});
  await provider.send(handle, { text: "hello", userInitiated: true });
  assert.deepEqual(ptyChild.writes, ["hello"]);
});

test("send(): writes via spawn child.stdin.write() on userInitiated=true", async () => {
  const spawnChild = makeFakeSpawnChild();
  const { provider } = makeProvider({
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: () => spawnChild,
  });
  const handle = await provider.start({});
  await provider.send(handle, { text: "hi\n", userInitiated: true });
  assert.deepEqual(spawnChild.stdin.written, ["hi\n"]);
});

test("send(): rejects without userInitiated=true", async () => {
  const { provider } = makeProvider();
  const handle = await provider.start({});
  await assert.rejects(
    () => provider.send(handle, { text: "x" }),
    /requires explicit user action/,
  );
  await assert.rejects(
    () => provider.send(handle, { text: "x", userInitiated: false }),
    /requires explicit user action/,
  );
});

test("send(): rejects non-string text and missing thread", async () => {
  const { provider } = makeProvider();
  const handle = await provider.start({});
  await assert.rejects(
    () => provider.send(handle, { text: 5, userInitiated: true }),
    TypeError,
  );
  await assert.rejects(
    () => provider.send({ providerId: "codex_cli", threadId: "missing" }, { text: "x", userInitiated: true }),
    /unknown threadId/,
  );
});

// --- stop: SIGINT → grace → SIGKILL sequence -------------------------------

test("stop(): SIGINT ignored → escalates to SIGKILL after grace (spawn backend)", async () => {
  const spawnChild = makeFakeSpawnChild({ exitOn: ["SIGKILL"] });
  const { provider } = makeProvider({
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: () => spawnChild,
    sigintGraceMs: 10,
  });
  const handle = await provider.start({});
  await provider.stop(handle);
  assert.deepEqual(spawnChild.killCalls, ["SIGINT", "SIGKILL"]);
});

test("stop(): graceful SIGINT exit skips SIGKILL (node-pty backend)", async () => {
  const ptyChild = makeFakePtyChild({ exitOn: ["SIGINT"] });
  const { provider } = makeProvider({
    ptyLoader: async () => fakePtyModule(() => ptyChild),
    sigintGraceMs: 50,
  });
  const handle = await provider.start({});
  await provider.stop(handle);
  assert.deepEqual(ptyChild.killCalls, ["SIGINT"]);
});

test("stop(): throws when child never exits after SIGKILL", async () => {
  const spawnChild = makeFakeSpawnChild({ exitOn: [] });
  const { provider } = makeProvider({
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: () => spawnChild,
    sigintGraceMs: 2,
  });
  const handle = await provider.start({});
  await assert.rejects(
    () => provider.stop(handle),
    /did not exit after SIGKILL/,
  );
  assert.deepEqual(spawnChild.killCalls, ["SIGINT", "SIGKILL"]);
});

test("stop(): no-op on already-exited thread", async () => {
  const ptyChild = makeFakePtyChild({ exitOn: ["SIGINT"] });
  const { provider } = makeProvider({
    ptyLoader: async () => fakePtyModule(() => ptyChild),
    sigintGraceMs: 25,
  });
  const handle = await provider.start({});
  await provider.stop(handle);
  // Second call returns without throwing or sending more signals.
  await provider.stop(handle);
  assert.deepEqual(ptyChild.killCalls, ["SIGINT"]);
});

// --- broker integration ----------------------------------------------------

test("GenericPtyProvider plugs into ProviderRegistry/ProviderBroker", async () => {
  const { provider } = makeProvider();
  const registry = new ProviderRegistry();
  registry.register(provider);
  const broker = new ProviderBroker({ registry });
  assert.ok(broker.listProviderIds().filter((id) => id === "codex_cli").length === 1);
  const handle = await broker.start("codex_cli", { extraArgs: ["foo"] });
  assert.equal(handle.providerId, "codex_cli");
  await broker.stop("codex_cli", handle);
});

test("GenericPtyProvider: optional broker methods not implemented surface NOT_SUPPORTED", async () => {
  const { provider } = makeProvider();
  const registry = new ProviderRegistry();
  registry.register(provider);
  const broker = new ProviderBroker({ registry });
  await assert.rejects(
    () => broker.resume("codex_cli", { providerId: "codex_cli", threadId: "x" }),
    (err) => err.code === BROKER_ERROR_CODES.NOT_SUPPORTED,
  );
  await assert.rejects(
    () => broker.approve("codex_cli", {}),
    (err) => err.code === BROKER_ERROR_CODES.NOT_SUPPORTED,
  );
});

// --- per-provider command template multi-instance ---------------------------

test("Per-provider command templates: separate instances under different ids share implementation", async () => {
  const claudeChild = makeFakeSpawnChild();
  const kimiChild = makeFakeSpawnChild();
  const claudeCalls = [];
  const kimiCalls = [];

  const claude = new GenericPtyProvider({
    providerId: "claude_code",
    label: "Claude Code",
    commandTemplate: { command: ["claude"], mcpContract: true },
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: (cmd, args) => { claudeCalls.push({ cmd, args }); return claudeChild; },
    sigintGraceMs: 5,
  });
  const kimi = new GenericPtyProvider({
    providerId: "kimi",
    label: "Kimi",
    commandTemplate: { command: ["kimi"], mcpContract: true },
    ptyLoader: async () => { throw new Error("no pty"); },
    spawn: (cmd, args) => { kimiCalls.push({ cmd, args }); return kimiChild; },
    sigintGraceMs: 5,
  });

  const registry = new ProviderRegistry();
  registry.register(claude);
  registry.register(kimi);
  const broker = new ProviderBroker({ registry });

  const claudeHandle = await broker.start("claude_code", { extraArgs: ["--cmd"] });
  const kimiHandle = await broker.start("kimi", {});
  assert.equal(claudeHandle.providerId, "claude_code");
  assert.equal(kimiHandle.providerId, "kimi");
  assert.equal(claudeCalls[0].cmd, "claude");
  assert.deepEqual(claudeCalls[0].args, ["--cmd"]);
  assert.equal(kimiCalls[0].cmd, "kimi");
  assert.deepEqual(kimiCalls[0].args, []);
});

// --- lint regression: no heuristic parsing of stdio ------------------------

test("GenericPtyProvider source contains no stdio-content heuristics", () => {
  const src = readFileSync(SRC_PATH, "utf8");
  const forbidden = [".includes(", ".match(", ".test(", ".indexOf(", "RegExp("];
  for (const needle of forbidden) {
    const at = src.split(needle).length - 1;
    assert.equal(
      at,
      0,
      `generic-pty.js contains forbidden substring ${JSON.stringify(needle)} — stdio heuristics are forbidden (addendum §3.1 / §10)`,
    );
  }

  // Forbid regex literals in code (after stripping comments + strings).
  const stripped = stripJsCommentsAndStrings(src);
  let cursor = 0;
  let foundRegex = false;
  while (cursor < stripped.length) {
    const slash = stripped.split("").findIndex((ch, idx) => idx >= cursor && ch === "/");
    if (slash === -1) break;
    const nl = stripped.split("").findIndex((ch, idx) => idx > slash && ch === "\n");
    const end = nl === -1 ? stripped.length : nl;
    let close = -1;
    for (let i = slash + 1; i < end; i++) {
      if (stripped[i] === "/") { close = i; break; }
    }
    if (close > slash + 1) {
      const prev = slash === 0 ? "" : stripped[slash - 1];
      if (!isDivisionPrev(prev)) {
        foundRegex = true;
        break;
      }
    }
    cursor = slash + 1;
  }
  assert.equal(foundRegex, false, "generic-pty.js contains a regex literal — stdio heuristics forbidden");
});

function isDivisionPrev(ch) {
  if (ch === "") return false;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  if (ch === "_" || ch === "$" || ch === ")" || ch === "]") return true;
  return false;
}

function stripJsCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      let nl = -1;
      for (let j = i; j < src.length; j++) {
        if (src[j] === "\n") { nl = j; break; }
      }
      const end = nl === -1 ? src.length : nl;
      out += " ".repeat(end - i);
      i = end;
    } else if (c === "/" && n === "*") {
      let close = -1;
      for (let j = i + 2; j < src.length - 1; j++) {
        if (src[j] === "*" && src[j + 1] === "/") { close = j; break; }
      }
      const end = close === -1 ? src.length : close + 2;
      out += " ".repeat(end - i);
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
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
