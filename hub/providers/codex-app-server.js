// hub/providers/codex-app-server.js — SH-9-11
//
// Codex App Server provider probe. The transport/client surface lands in later
// SH-9 tasks; this slice establishes a RuntimeProvider-compatible shell whose
// probe reports availability without throwing into ProviderRegistry discovery.

import { spawn as nodeSpawn } from "node:child_process";
import { defaultProviderCapabilities, validateProviderCapabilities } from "./capabilities.js";
import { createCodexRpcClient } from "./codex-rpc.js";
import { createCodexSchemaValidator, loadVendoredCodexSchema } from "./codex-schema/index.js";

export const CODEX_APP_SERVER_PROVIDER_ID = "codex_app_server";
export const CODEX_APP_SERVER_PROVIDER_LABEL = "Codex App Server";

const DEFAULT_CODEX_COMMAND = Object.freeze(["codex"]);
const DEFAULT_PROBE_TIMEOUT_MS = 10000;
const DEFAULT_TRANSPORT_PRIORITY = Object.freeze(["stdio", "unix", "websocket"]);
const FALLBACK_PROVIDER_IDS = Object.freeze(["codex_cli", "generic_pty"]);

const CAPABILITY_KEYS_BY_TOKEN = Object.freeze({
  structured_thread: "structuredThread",
  structured_turns: "structuredTurns",
  structured_items: "structuredItems",
  structured_approvals: "structuredApprovals",
  structured_file_changes: "structuredFileChanges",
  structured_command_events: "structuredCommandEvents",
  structured_context_usage: "structuredContextUsage",
  provider_timeline: "providerTimeline",
  provider_diffs: "providerDiffs",
  provider_review: "providerReview",
  model_list: "modelList",
  skill_list: "skillList",
  thread_resume: "threadResume",
  thread_fork: "threadFork",
  turn_steer: "turnSteer",
  turn_interrupt: "turnInterrupt",
  direct_context_injection: "directContextInjection",
  model_swap_mid_thread: "modelSwapMidThread",
});

const CODEX_EXTENSION_CAPABILITY_KEYS = Object.freeze(["modelSwapMidThread"]);
const CODEX_START_METHODS = Object.freeze([
  "thread/start",
  "threads.create",
  "thread.start",
]);
const CODEX_SEND_METHODS = Object.freeze([
  "turn/start",
  "turn.start",
  "turns.create",
]);
const CODEX_MODEL_SWAP_METHODS = Object.freeze([
  "threads.model.swap",
  "threads.swap_model",
  "thread.model_swap",
  "model.swap",
]);
const CODEX_INTERRUPT_METHODS = Object.freeze([
  "threads.cancel",
  "turn.cancel",
  "turn.interrupt",
  "thread.cancel",
]);
const CODEX_REVIEW_METHODS = Object.freeze([
  "review/start",
  "review.start",
  "threads.review",
  "thread.review",
]);

export function codexAppServerDefaultCapabilities() {
  return {
    ...defaultProviderCapabilities(),
    structuredThread: true,
    structuredTurns: true,
    structuredItems: true,
    structuredApprovals: true,
    structuredFileChanges: true,
    structuredCommandEvents: true,
    structuredContextUsage: true,
    providerTimeline: true,
    providerDiffs: true,
    providerReview: true,
    modelList: true,
    skillList: true,
    threadResume: true,
    threadFork: true,
    turnSteer: true,
    turnInterrupt: true,
    directContextInjection: true,
    modelSwapMidThread: true,
  };
}

export function parseCodexVersion(text) {
  const value = String(text || "");
  const match = value.match(/\b(?:codex\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

export function parseAdvertisedCapabilities(text, fallback = codexAppServerDefaultCapabilities()) {
  const caps = { ...fallback };
  const value = String(text || "");
  for (const [token, key] of Object.entries(CAPABILITY_KEYS_BY_TOKEN)) {
    if (value.includes(token) || value.includes(key)) caps[key] = true;
  }
  return validateCodexCapabilities(caps);
}

export function selectCodexAppServerTransport({
  availableTransports = DEFAULT_TRANSPORT_PRIORITY,
  websocketEnabled = false,
} = {}) {
  const available = new Set(arrayOrEmpty(availableTransports).filter((item) => typeof item === "string" && item));
  for (const transport of DEFAULT_TRANSPORT_PRIORITY) {
    if (transport === "websocket" && websocketEnabled !== true) continue;
    if (available.has(transport)) return transport;
  }
  return null;
}

export function codexAppServerFeatureFallbacks(capabilities = {}) {
  const caps = validateCodexCapabilities({ ...defaultProviderCapabilities(), ...capabilities });
  return Object.freeze({
    resume: caps.threadResume
      ? { mode: "native" }
      : { mode: "successor_spawn", via: "thread/start" },
    fork: caps.threadFork
      ? { mode: "native" }
      : { mode: "deterministic_rollover", via: "thread/start" },
    approval: caps.structuredApprovals
      ? { mode: "native" }
      : { mode: "unsupported" },
    contextUsage: caps.structuredContextUsage
      ? { mode: "native" }
      : { mode: "unsupported" },
    turnDiff: caps.providerDiffs
      ? { mode: "native" }
      : { mode: "unsupported" },
    modelSwap: caps.modelSwapMidThread
      ? { mode: "native" }
      : { mode: "successor_restart", via: "session/restart" },
  });
}

export function codexProviderErrorWarning({
  message,
  code = "codex_app_server_unavailable",
  retryable = true,
  setupRequired = false,
  eventId,
  sessionId,
  jobId,
} = {}) {
  return {
    kind: "provider_error",
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    code,
    message: text(message) || "Codex App Server unavailable; falling back to Generic PTY",
    retryable,
    setupRequired,
    ...(text(eventId) ? { eventId: text(eventId) } : {}),
    ...(text(sessionId) ? { sessionId: text(sessionId) } : {}),
    ...(text(jobId) ? { jobId: text(jobId) } : {}),
  };
}

export function createCodexAppServerProvider(opts = {}) {
  const command = normalizeCommand(opts.command || DEFAULT_CODEX_COMMAND);
  const appServerCommand = normalizeCommand(opts.appServerCommand || [...command, "app-server"]);
  const runCommand = typeof opts.runCommand === "function"
    ? opts.runCommand
    : (args, options) => runSpawnCommand(command[0], [...command.slice(1), ...args], {
        ...options,
        spawn: typeof opts.spawn === "function" ? opts.spawn : nodeSpawn,
      });
  const probeTimeoutMs = normalizeTimeout(opts.probeTimeoutMs);
  const schemaAvailable = opts.schemaAvailable !== false;
  const loadSchema = typeof opts.loadSchema === "function" ? opts.loadSchema : loadVendoredCodexSchema;
  const websocketEnabled = opts.websocketEnabled === true;
  const availableTransports = Array.isArray(opts.availableTransports)
    ? opts.availableTransports
    : DEFAULT_TRANSPORT_PRIORITY;
  const websocketUrl = opts.websocketUrl;
  const unixSocketPath = opts.unixSocketPath;
  const transportFactory = opts.transportFactory;
  let lastProbe = null;
  let lastCapabilities = codexUnavailableCapabilities();
  let lastSchema = null;
  let lastSchemaValidator = null;

  return {
    id: CODEX_APP_SERVER_PROVIDER_ID,
    label: CODEX_APP_SERVER_PROVIDER_LABEL,

    async probe() {
      const selectedTransport = selectCodexAppServerTransport({ availableTransports, websocketEnabled });
      if (!schemaAvailable || !selectedTransport) {
        lastCapabilities = codexUnavailableCapabilities();
        lastProbe = {
          ok: false,
          reason: selectedTransport ? "codex app-server schema missing" : "codex app-server transport unavailable",
          details: {
            command,
            selectedTransport,
            transportPriority: DEFAULT_TRANSPORT_PRIORITY,
            fallbackProviderIds: FALLBACK_PROVIDER_IDS,
            warning: codexProviderErrorWarning({
              code: selectedTransport ? "codex_app_server_schema_missing" : "codex_app_server_transport_unavailable",
              message: selectedTransport
                ? "Codex App Server schema is missing; setup is required before structured provider use"
                : "Codex App Server transport is unavailable; setup is required before structured provider use",
              retryable: false,
              setupRequired: true,
            }),
          },
        };
        return lastProbe;
      }
      try {
        lastSchema = await loadSchema();
        lastSchemaValidator = createCodexSchemaValidator(lastSchema);
        const appServerHelpArgs = [...appServerCommand.slice(1), "--help"];
        const [versionResult, helpResult] = await Promise.all([
          runCommand(["--version"], { timeoutMs: probeTimeoutMs }),
          runCommand(appServerHelpArgs, { timeoutMs: probeTimeoutMs }),
        ]);
        const versionOutput = commandOutput(versionResult);
        const helpOutput = commandOutput(helpResult);
        const version = parseCodexVersion(versionOutput);
        if (!isOkResult(helpResult)) {
          lastCapabilities = codexUnavailableCapabilities();
          lastProbe = {
            ok: false,
            reason: "codex app-server unavailable",
            details: {
              command,
              version,
              exitCode: helpResult?.exitCode ?? null,
              signal: helpResult?.signal ?? null,
              stderr: trimOutput(helpResult?.stderr),
              selectedTransport,
              transportPriority: DEFAULT_TRANSPORT_PRIORITY,
              fallbackProviderIds: FALLBACK_PROVIDER_IDS,
              warning: codexProviderErrorWarning({
                message: "Codex App Server unavailable; falling back to Generic PTY",
                retryable: true,
              }),
            },
          };
          return lastProbe;
        }
        lastCapabilities = parseAdvertisedCapabilities(helpOutput, codexAppServerDefaultCapabilities());
        lastProbe = {
          ok: true,
          reason: "codex app-server available",
          details: {
            command,
            version,
            selectedTransport,
            transportPriority: DEFAULT_TRANSPORT_PRIORITY,
            schemaProtocolVersion: lastSchema?.protocolVersion || null,
            capabilities: lastCapabilities,
            featureFallbacks: codexAppServerFeatureFallbacks(lastCapabilities),
          },
        };
        return lastProbe;
      } catch (err) {
        const schemaLoadFailure = isSchemaLoadFailure(err);
        lastCapabilities = codexUnavailableCapabilities();
        lastProbe = {
          ok: false,
          reason: schemaLoadFailure ? "codex app-server schema missing" : "codex app-server probe failed",
          details: {
            command,
            error: err?.message || String(err),
            code: err?.code || null,
            selectedTransport,
            transportPriority: DEFAULT_TRANSPORT_PRIORITY,
            fallbackProviderIds: FALLBACK_PROVIDER_IDS,
            warning: codexProviderErrorWarning({
              code: schemaLoadFailure ? "codex_app_server_schema_missing" : "codex_app_server_probe_failed",
              message: schemaLoadFailure
                ? "Codex App Server schema is missing; setup is required before structured provider use"
                : err?.message || "Codex App Server probe failed; falling back to Generic PTY",
              retryable: !schemaLoadFailure,
              setupRequired: schemaLoadFailure,
            }),
          },
        };
        return lastProbe;
      }
    },

    capabilities() {
      return { ...lastCapabilities };
    },

    async start(request = {}) {
      const body = normalizeStartRequest(request);
      if (lastCapabilities.structuredThread !== true) {
        throw notSupported("start", "structuredThread capability unavailable");
      }
      const client = this.createRpcClient();
      await initializeCodexRpcClient(client, lastSchema);
      const method = selectMethod(client.methods, CODEX_START_METHODS);
      if (!method) {
        throw notSupported("start", "Codex RPC schema does not expose a thread start method");
      }
      const result = await client.call(method, body);
      return providerThreadHandleFromStart(result, {
        request: body,
        selectedTransport: selectCodexAppServerTransport({ availableTransports, websocketEnabled }),
        schemaVersion: lastSchema?.protocolVersion || null,
      });
    },

    async swapModel(threadRef, request = {}) {
      const ref = normalizeThreadRef(threadRef, "swapModel");
      const body = normalizeModelSwapRequest(request);
      if (lastCapabilities.modelSwapMidThread !== true) {
        throw notSupported("swapModel", "modelSwapMidThread capability unavailable");
      }
      const client = this.createRpcClient();
      await initializeCodexRpcClient(client, lastSchema);
      const method = selectMethod(client.methods, CODEX_MODEL_SWAP_METHODS);
      if (!method) {
        throw notSupported("swapModel", "Codex RPC schema does not expose a live model swap method");
      }
      return client.call(method, {
        ...body,
        ...ref,
      });
    },

    async send(threadRef, input = {}) {
      const ref = normalizeThreadRef(threadRef, "send");
      const body = normalizeSendRequest(input);
      if (lastCapabilities.structuredTurns !== true) {
        throw notSupported("send", "structuredTurns capability unavailable");
      }
      const client = this.createRpcClient();
      await initializeCodexRpcClient(client, lastSchema);
      const method = selectMethod(client.methods, CODEX_SEND_METHODS);
      if (!method) {
        throw notSupported("send", "Codex RPC schema does not expose a turn start method");
      }
      return client.call(method, {
        ...body,
        threadId: ref.threadId,
      });
    },

    async interrupt(threadRef) {
      const ref = normalizeThreadRef(threadRef, "interrupt");
      if (lastCapabilities.turnInterrupt !== true) {
        throw notSupported("interrupt", "turnInterrupt capability unavailable");
      }
      const client = this.createRpcClient();
      await initializeCodexRpcClient(client, lastSchema);
      const method = selectMethod(client.methods, CODEX_INTERRUPT_METHODS);
      if (!method) {
        throw notSupported("interrupt", "Codex RPC schema does not expose an interrupt/cancel method");
      }
      return client.call(method, ref);
    },

    async review(threadRef, request = {}) {
      const ref = normalizeThreadRef(threadRef, "review");
      const body = normalizeReviewRequest(request);
      if (lastCapabilities.providerReview !== true) {
        throw notSupported("review", "providerReview capability unavailable");
      }
      const client = this.createRpcClient();
      await initializeCodexRpcClient(client, lastSchema);
      const method = selectMethod(client.methods, CODEX_REVIEW_METHODS);
      if (!method) {
        throw notSupported("review", "Codex RPC schema does not expose a review method");
      }
      return client.call(method, {
        ...body,
        ...ref,
      });
    },

    createRpcClient() {
      if (!lastSchemaValidator) {
        throw schemaUnavailableError("CodexAppServerProvider.createRpcClient: schema not loaded; call probe() first");
      }
      const selectedTransport = selectCodexAppServerTransport({ availableTransports, websocketEnabled });
      if (!selectedTransport) {
        throw schemaUnavailableError("CodexAppServerProvider.createRpcClient: no supported transport available");
      }
      return createCodexRpcClient({
        schemaValidator: lastSchemaValidator,
        transportFactory,
        transportKind: selectedTransport,
        unixSocketPath,
        websocketUrl,
        command: appServerCommand,
        spawn: typeof opts.spawn === "function" ? opts.spawn : nodeSpawn,
      });
    },

    streamEvents(threadRef) {
      if (!threadRef || typeof threadRef !== "object") {
        throw new TypeError("CodexAppServerProvider.streamEvents: threadRef must be an object");
      }
      return (async function* () {
        // Transport event streaming lands with the SH-9 transport/client tasks.
      })();
    },

    _lastProbe() {
      return lastProbe;
    },
  };
}

function codexUnavailableCapabilities() {
  return {
    ...defaultProviderCapabilities(),
    modelSwapMidThread: false,
  };
}

function normalizeCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((arg) => typeof arg !== "string" || !arg)) {
    throw new TypeError("createCodexAppServerProvider: command must be a non-empty string[]");
  }
  return Object.freeze([...command]);
}

function validateCodexCapabilities(caps) {
  const extensionValues = {};
  for (const key of CODEX_EXTENSION_CAPABILITY_KEYS) {
    if (caps[key] !== undefined) extensionValues[key] = caps[key] === true;
  }
  const baseCaps = { ...caps };
  for (const key of CODEX_EXTENSION_CAPABILITY_KEYS) {
    delete baseCaps[key];
  }
  return {
    ...validateProviderCapabilities(baseCaps),
    ...extensionValues,
  };
}

function normalizeThreadRef(value, caller) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`CodexAppServerProvider.${caller}: threadRef must be an object`);
  }
  const out = { ...value };
  const threadId = out.threadId || out.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new TypeError(`CodexAppServerProvider.${caller}: threadId required`);
  }
  out.threadId = threadId;
  return out;
}

async function initializeCodexRpcClient(client, schema) {
  if (!client || !arrayOrEmpty(client.methods).includes("initialize")) return null;
  return client.call("initialize", {
    clientInfo: {
      name: "llm-project-tracker",
      title: "LLM Project Tracker",
      version: text(schema?.protocolVersion) || "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
}

function normalizeModelSwapRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("CodexAppServerProvider.swapModel: request must be an object");
  }
  const { model, keepCtx = true, instruction, idempotencyKey } = request;
  if (typeof model !== "string" || model.length === 0) {
    throw new TypeError("CodexAppServerProvider.swapModel: model required");
  }
  if (keepCtx !== undefined && typeof keepCtx !== "boolean") {
    throw new TypeError("CodexAppServerProvider.swapModel: keepCtx must be boolean");
  }
  return {
    model,
    keepCtx,
    ...(instruction && typeof instruction === "object" ? { instruction: { ...instruction } } : {}),
    ...(typeof idempotencyKey === "string" && idempotencyKey ? { idempotencyKey } : {}),
  };
}

function normalizeSendRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("CodexAppServerProvider.send: input must be an object");
  }
  const message = text(input.text) || text(input.message) || text(input.prompt);
  if (!message) {
    throw new TypeError("CodexAppServerProvider.send: input text required");
  }
  const out = {
    input: [{ type: "text", text: message }],
  };
  if (text(input.cwd)) out.cwd = text(input.cwd);
  if (text(input.model)) out.model = text(input.model);
  if (text(input.sandbox)) out.sandboxPolicy = text(input.sandbox);
  return out;
}

function normalizeStartRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("CodexAppServerProvider.start: request must be an object");
  }
  const out = {};
  copyOptionalString(out, request, "cwd");
  copyOptionalString(out, request, "baseInstructions");
  copyOptionalString(out, request, "developerInstructions");
  copyOptionalString(out, request, "serviceName");
  copyOptionalString(out, request, "serviceTier");
  copyOptionalString(out, request, "model");
  copyOptionalString(out, request, "modelProvider");
  copyOptionalString(out, request, "sandbox");
  copyOptionalString(out, request, "sessionStartSource");
  copyOptionalString(out, request, "threadSource");
  copyOptionalRecord(out, request, "approvalPolicy");
  copyOptionalRecord(out, request, "approvalsReviewer");
  copyOptionalRecord(out, request, "config");
  if (request.ephemeral !== undefined) {
    if (typeof request.ephemeral !== "boolean") {
      throw new TypeError("CodexAppServerProvider.start: ephemeral must be boolean when present");
    }
    out.ephemeral = request.ephemeral;
  }
  return out;
}

function normalizeReviewRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("CodexAppServerProvider.review: request must be an object");
  }
  const { prompt, target, delivery, scope, idempotencyKey } = request;
  let reviewTarget = null;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    reviewTarget = { ...target };
  } else if (typeof prompt === "string" && prompt.length > 0) {
    reviewTarget = { type: "custom", instructions: prompt };
  }
  if (!reviewTarget) {
    throw new TypeError("CodexAppServerProvider.review: prompt or target required");
  }
  return {
    target: reviewTarget,
    ...(typeof delivery === "string" && delivery ? { delivery } : {}),
    ...(scope && typeof scope === "object" && !Array.isArray(scope) ? { scope: { ...scope } } : {}),
    ...(typeof idempotencyKey === "string" && idempotencyKey ? { idempotencyKey } : {}),
  };
}

function providerThreadHandleFromStart(result, { request, selectedTransport, schemaVersion }) {
  const thread = recordOrNull(result?.thread) || recordOrNull(result);
  const threadId = text(result?.threadId) || text(thread?.threadId) || text(thread?.id);
  if (!threadId) {
    throw new TypeError("CodexAppServerProvider.start: thread/start result missing thread id");
  }
  return {
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    transport: selectedTransport || "stdio",
    threadId,
    ...(text(thread?.sessionId) ? { providerSessionId: text(thread.sessionId) } : {}),
    ...(text(thread?.cwd) ? { cwd: text(thread.cwd) } : text(request?.cwd) ? { cwd: text(request.cwd) } : {}),
    ...(text(request?.model) ? { model: text(request.model) } : {}),
    ...(text(schemaVersion) ? { schemaVersion: text(schemaVersion) } : {}),
  };
}

function selectMethod(methods, aliases) {
  const available = new Set(arrayOrEmpty(methods));
  for (const alias of aliases) {
    if (available.has(alias)) return alias;
  }
  return null;
}

function copyOptionalString(out, source, key) {
  if (source[key] === undefined || source[key] === null) return;
  if (typeof source[key] !== "string" || source[key].length === 0) {
    throw new TypeError(`CodexAppServerProvider.start: ${key} must be a non-empty string when present`);
  }
  out[key] = source[key];
}

function copyOptionalRecord(out, source, key) {
  if (source[key] === undefined || source[key] === null) return;
  if (!recordOrNull(source[key])) {
    throw new TypeError(`CodexAppServerProvider.start: ${key} must be an object when present`);
  }
  out[key] = { ...source[key] };
}

function recordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeTimeout(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
}

function isOkResult(result) {
  return result && result.exitCode === 0 && result.timedOut !== true && !result.error;
}

function commandOutput(result) {
  return `${result?.stdout || ""}\n${result?.stderr || ""}`;
}

function trimOutput(value) {
  const text = String(value || "").trim();
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function notSupported(operation, reason) {
  const err = new Error(`CodexAppServerProvider.${operation}: ${reason}`);
  err.code = "PROVIDER_OPERATION_NOT_SUPPORTED";
  err.details = { operation, reason };
  return err;
}

function isSchemaLoadFailure(err) {
  return Boolean(
    err?.code === "ENOENT" ||
    err?.code === "INVALID_SCHEMA" ||
    err?.code === "INVALID_SCHEMA_VERSION" ||
    err?.code === "INVALID_SCHEMA_PATH" ||
    err?.code === "CODEX_SCHEMA_VALIDATION_FAILED",
  );
}

function schemaUnavailableError(message) {
  const err = new Error(message);
  err.code = "CODEX_APP_SERVER_SCHEMA_UNAVAILABLE";
  return err;
}

function runSpawnCommand(file, args, { spawn = nodeSpawn, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut: false,
        ...result,
      });
    };
    const timer = setTimeout(() => {
      if (child && typeof child.kill === "function") child.kill("SIGTERM");
      finish({ timedOut: true, error: "timeout" });
    }, timeoutMs);
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ error: err?.message || String(err), code: err?.code || null });
      return;
    }
    if (child?.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    }
    if (child?.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    }
    if (typeof child?.on === "function") {
      child.on("error", (err) => finish({ error: err?.message || String(err), code: err?.code || null }));
      child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    } else {
      finish({ error: "spawn did not return a child process" });
    }
  });
}
