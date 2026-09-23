// hub/providers/codex-rpc.js
//
// Schema-driven JSON-RPC transport for Codex App Server. Method and event names
// are accepted only from the vendored schema supplied by the provider.

import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import { createConnection as nodeCreateConnection } from "node:net";
import WebSocket from "ws";

export const CODEX_RPC_DEFAULT_MAX_RECONNECT_DELAY_MS = 5000;
export const CODEX_RPC_DEFAULT_BASE_RECONNECT_DELAY_MS = 100;

export function createCodexRpcClient({
  schemaValidator,
  transport,
  transportFactory,
  transportKind = "stdio",
  command = ["codex", "app-server"],
  unixSocketPath,
  websocketUrl,
  spawn = nodeSpawn,
  createConnection = nodeCreateConnection,
  WebSocketImpl = WebSocket,
  baseReconnectDelayMs = CODEX_RPC_DEFAULT_BASE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = CODEX_RPC_DEFAULT_MAX_RECONNECT_DELAY_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
} = {}) {
  if (!schemaValidator || typeof schemaValidator.validateOutgoingCall !== "function") {
    throw new TypeError("createCodexRpcClient: schemaValidator with validateOutgoingCall required");
  }
  const methods = new Set(arrayOrEmpty(schemaValidator.methods));
  const events = new Set(arrayOrEmpty(schemaValidator.events));
  let activeTransport = transport || null;
  let connected = Boolean(transport);
  let wired = false;
  let seq = 0;
  let reconnectAttempt = 0;
  const pending = new Map();
  const emitter = new EventEmitter();

  const client = {
    methods: Object.freeze([...methods]),
    events: Object.freeze([...events]),

    async connect() {
      if (!connected || !activeTransport) {
        activeTransport = await connectWithRetry({
          create: () => resolveTransport({
            transportFactory,
            transportKind,
          command,
          unixSocketPath,
          websocketUrl,
          spawn,
          createConnection,
          WebSocketImpl,
        }),
          baseReconnectDelayMs,
          maxReconnectDelayMs,
          setTimeoutFn,
        });
        connected = true;
        reconnectAttempt = 0;
      }
      if (!wired) {
        wireTransport(activeTransport, handleMessage, handleClose);
        wired = true;
      }
      return activeTransport;
    },

    async call(method, params = {}, { id } = {}) {
      assertKnown(method, methods, "method");
      await this.connect();
      const request = schemaValidator.validateOutgoingCall({
        jsonrpc: "2.0",
        id: id ?? nextId(now, ++seq),
        method,
        params,
      });
      const response = new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
      });
      activeTransport.send(JSON.stringify(request));
      return response;
    },

    onEvent(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },

    async close() {
      connected = false;
      wired = false;
      for (const [id, entry] of pending.entries()) {
        pending.delete(id);
        entry.reject(rpcError("Codex RPC client closed", "CODEX_RPC_CLOSED"));
      }
      if (activeTransport && typeof activeTransport.close === "function") {
        await activeTransport.close();
      }
      activeTransport = null;
    },

    reconnectDelay(attempt = reconnectAttempt) {
      return calculateBackoffDelay(attempt, { baseReconnectDelayMs, maxReconnectDelayMs });
    },
  };

  function handleMessage(raw) {
    const message = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(rpcError(message.error.message || "Codex RPC error", "CODEX_RPC_ERROR", message.error));
      else entry.resolve(message.result);
      return;
    }
    if (message?.method) {
      assertKnown(message.method, events, "event");
      schemaValidator.validateIncomingEvent(message);
      emitter.emit("event", message);
    }
  }

  function handleClose() {
    connected = false;
    wired = false;
    reconnectAttempt += 1;
  }

  return client;
}

export function calculateBackoffDelay(attempt, {
  baseReconnectDelayMs = CODEX_RPC_DEFAULT_BASE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = CODEX_RPC_DEFAULT_MAX_RECONNECT_DELAY_MS,
} = {}) {
  const normalizedAttempt = Math.max(0, Number.isInteger(attempt) ? attempt : 0);
  const base = Math.max(1, Number.isInteger(baseReconnectDelayMs) ? baseReconnectDelayMs : CODEX_RPC_DEFAULT_BASE_RECONNECT_DELAY_MS);
  const max = Math.max(base, Number.isInteger(maxReconnectDelayMs) ? maxReconnectDelayMs : CODEX_RPC_DEFAULT_MAX_RECONNECT_DELAY_MS);
  return Math.min(max, base * (2 ** normalizedAttempt));
}

export async function connectWithRetry({
  create,
  attempts = 3,
  baseReconnectDelayMs = CODEX_RPC_DEFAULT_BASE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = CODEX_RPC_DEFAULT_MAX_RECONNECT_DELAY_MS,
  setTimeoutFn = setTimeout,
} = {}) {
  if (typeof create !== "function") throw new TypeError("connectWithRetry: create function required");
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await create();
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1) break;
      await delay(calculateBackoffDelay(attempt, { baseReconnectDelayMs, maxReconnectDelayMs }), setTimeoutFn);
    }
  }
  throw rpcError("Codex RPC transport unavailable", "CODEX_RPC_TRANSPORT_UNAVAILABLE", {
    cause: lastError?.message || String(lastError),
  });
}

export function createStdioTransport({
  command = ["codex", "app-server"],
  spawn = nodeSpawn,
} = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some((arg) => typeof arg !== "string" || !arg)) {
    throw new TypeError("createStdioTransport: command must be a non-empty string[]");
  }
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const emitter = new EventEmitter();
  let buffer = "";
  if (child?.stdout && typeof child.stdout.on === "function") {
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) emitter.emit("message", line);
        newline = buffer.indexOf("\n");
      }
    });
  }
  if (typeof child?.on === "function") {
    child.on("close", () => emitter.emit("close"));
    child.on("error", (err) => emitter.emit("error", err));
  }
  return {
    onMessage(listener) {
      emitter.on("message", listener);
      return () => emitter.off("message", listener);
    },
    onClose(listener) {
      emitter.on("close", listener);
      return () => emitter.off("close", listener);
    },
    send(payload) {
      child.stdin.write(`${payload}\n`);
    },
    close() {
      if (typeof child.kill === "function") child.kill("SIGTERM");
    },
  };
}

export function createWebSocketTransport({
  url,
  WebSocketImpl = WebSocket,
} = {}) {
  if (typeof url !== "string" || !url) throw new TypeError("createWebSocketTransport: url required");
  const socket = new WebSocketImpl(url);
  const emitter = new EventEmitter();
  if (typeof socket.on === "function") {
    socket.on("message", (message) => emitter.emit("message", message.toString()));
    socket.on("close", () => emitter.emit("close"));
    socket.on("error", (err) => emitter.emit("error", err));
  }
  return {
    onMessage(listener) {
      emitter.on("message", listener);
      return () => emitter.off("message", listener);
    },
    onClose(listener) {
      emitter.on("close", listener);
      return () => emitter.off("close", listener);
    },
    send(payload) {
      socket.send(payload);
    },
    close() {
      socket.close();
    },
  };
}

export function createUnixTransport({
  path,
  createConnection = nodeCreateConnection,
} = {}) {
  if (typeof path !== "string" || !path) throw new TypeError("createUnixTransport: path required");
  const socket = createConnection(path);
  const emitter = new EventEmitter();
  let buffer = "";
  if (typeof socket.on === "function") {
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) emitter.emit("message", line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => emitter.emit("close"));
    socket.on("error", (err) => emitter.emit("error", err));
  }
  return {
    onMessage(listener) {
      emitter.on("message", listener);
      return () => emitter.off("message", listener);
    },
    onClose(listener) {
      emitter.on("close", listener);
      return () => emitter.off("close", listener);
    },
    send(payload) {
      socket.write(`${payload}\n`);
    },
    close() {
      socket.end();
    },
  };
}

function resolveTransport({ transportFactory, transportKind, command, unixSocketPath, websocketUrl, spawn, createConnection, WebSocketImpl }) {
  if (typeof transportFactory === "function") return transportFactory({ transportKind, command, unixSocketPath, websocketUrl });
  if (transportKind === "stdio") return createStdioTransport({ command, spawn });
  if (transportKind === "unix") return createUnixTransport({ path: unixSocketPath, createConnection });
  if (transportKind === "websocket") return createWebSocketTransport({ url: websocketUrl, WebSocketImpl });
  throw rpcError(`Unsupported Codex transport '${transportKind}'`, "CODEX_RPC_UNSUPPORTED_TRANSPORT", { transportKind });
}

function wireTransport(transport, onMessage, onClose) {
  if (!transport || typeof transport.send !== "function") throw new TypeError("Codex transport must expose send(payload)");
  if (typeof transport.onMessage === "function") transport.onMessage(onMessage);
  if (typeof transport.onClose === "function") transport.onClose(onClose);
}

function assertKnown(name, names, kind) {
  if (!names.has(name)) {
    throw rpcError(`Unknown Codex RPC ${kind}: ${name}`, "CODEX_RPC_UNKNOWN_NAME", { kind, name });
  }
}

function nextId(now, seq) {
  return `codex-rpc-${now()}-${seq}`;
}

function delay(ms, setTimeoutFn) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function rpcError(message, code, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}
