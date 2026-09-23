// hub/providers/broker.js — SH-2-15 (addendum §4 / §6)
//
// ProviderBroker — the single mediator that routes session lifecycle calls
// (start / attach / resume / fork / stop / send / steer / interrupt /
// review / approve / deny / streamEvents / capabilities / listModels / listSkills)
// to the right RuntimeProvider by `providerId`.
//
// Architectural contract (addendum §4):
//   Browser UI / CLI / MCP
//     → RunSessionService / SessionRegistry / JobRegistry
//     → ProviderBroker            ← THIS MODULE
//         → CodexAppServerProvider
//         → GenericPtyProvider
//         → ClaudeCodePtyProvider
//         → KimiPtyProvider / GeminiPtyProvider
//         → ManualProvider
//     → ProviderEventNormalizer
//     → RuntimeStore
//
// "Sessions always go through the broker" is an invariant the broker
// itself can't enforce on call sites (those live in SessionRegistry,
// JobRegistry, RunSessionService — each in their own allowed_paths).
// The broker enforces it from the inside out: it is the only object that
// knows how to call provider methods, and it exposes the full set so no
// caller has a reason to reach around it.

/**
 * @typedef {import("./registry.js").ProviderRegistry} ProviderRegistry
 * @typedef {import("./registry.js").RuntimeProvider} RuntimeProvider
 */

/**
 * Stable error codes the broker raises. Callers (e.g., HTTP routes) map
 * these to status codes / error envelopes.
 */
export const BROKER_ERROR_CODES = Object.freeze({
  NOT_FOUND: "PROVIDER_NOT_FOUND",
  NOT_SUPPORTED: "PROVIDER_OPERATION_NOT_SUPPORTED",
  INVALID_ARGUMENT: "PROVIDER_INVALID_ARGUMENT",
});

const CODEX_APP_SERVER_PROVIDER_ID = "codex_app_server";
const DEFAULT_CODEX_FALLBACK_PROVIDER_IDS = Object.freeze(["codex_cli", "generic_pty"]);

/**
 * Build a tagged broker error with a stable `code`.
 *
 * @param {string} message
 * @param {string} code
 * @param {object} [details]
 */
function brokerError(message, code, details) {
  const err = /** @type {any} */ (new Error(message));
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Look up a provider by id; throw NOT_FOUND if absent.
 *
 * @param {ProviderRegistry} registry
 * @param {string} providerId
 * @param {string} operation   for error messages
 * @returns {RuntimeProvider}
 */
function mustGetProvider(registry, providerId, operation) {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw brokerError(
      `ProviderBroker.${operation}: providerId required`,
      BROKER_ERROR_CODES.INVALID_ARGUMENT,
      { operation },
    );
  }
  const p = registry.get(providerId);
  if (!p) {
    throw brokerError(
      `ProviderBroker.${operation}: provider '${providerId}' not registered`,
      BROKER_ERROR_CODES.NOT_FOUND,
      { providerId, operation },
    );
  }
  return p;
}

/**
 * Throw NOT_SUPPORTED if the provider doesn't expose `method`. Required
 * methods (start, capabilities, streamEvents, probe) are validated at
 * registration time and don't need a runtime guard here.
 *
 * @param {RuntimeProvider} provider
 * @param {string} method
 * @param {string} operation
 */
function mustSupport(provider, method, operation) {
  if (typeof provider[method] !== "function") {
    throw brokerError(
      `ProviderBroker.${operation}: provider '${provider.id}' does not support ${method}`,
      BROKER_ERROR_CODES.NOT_SUPPORTED,
      { providerId: provider.id, method, operation },
    );
  }
}

/**
 * Mediator over a `ProviderRegistry`. Construct once per hub process and
 * pass it down to anyone who needs to start/attach/operate a session.
 */
export class ProviderBroker {
  /**
   * @param {object} deps
   * @param {ProviderRegistry} deps.registry
   * @param {string[]} [deps.codexFallbackProviderIds]
   */
  constructor(deps) {
    const { registry } = deps || {};
    if (!registry || typeof registry.get !== "function") {
      throw new Error("ProviderBroker: registry (with get) required");
    }
    this.registry = registry;
    this.codexFallbackProviderIds = normalizeProviderIds(
      deps?.codexFallbackProviderIds,
      DEFAULT_CODEX_FALLBACK_PROVIDER_IDS,
    );
  }

  /** @returns {string[]} */
  listProviderIds() {
    return this.registry.list().map((p) => p.id);
  }

  /**
   * Capability vector for a given providerId.
   *
   * @param {string} providerId
   * @returns {object}
   */
  capabilities(providerId) {
    return mustGetProvider(this.registry, providerId, "capabilities").capabilities();
  }

  /**
   * @param {string} providerId
   * @returns {Promise<import("./registry.js").ProviderProbeResult>}
   */
  async probe(providerId) {
    return mustGetProvider(this.registry, providerId, "probe").probe();
  }

  /**
   * @param {string} providerId
   * @returns {Promise<object[]>}
   */
  async listModels(providerId) {
    const p = mustGetProvider(this.registry, providerId, "listModels");
    mustSupport(p, "listModels", "listModels");
    return p.listModels();
  }

  /**
   * @param {string} providerId
   * @param {object} [request]
   * @returns {Promise<object[]>}
   */
  async listSkills(providerId, request) {
    const p = mustGetProvider(this.registry, providerId, "listSkills");
    mustSupport(p, "listSkills", "listSkills");
    return p.listSkills(request);
  }

  /**
   * Start a new provider thread. Required on every provider.
   *
   * @param {string} providerId
   * @param {object} request   ProviderStartRequest per addendum §6
   * @returns {Promise<object>} ProviderThreadHandle
   */
  async start(providerId, request) {
    const p = mustGetProvider(this.registry, providerId, "start");
    if (providerId !== CODEX_APP_SERVER_PROVIDER_ID) {
      return p.start(request);
    }
    const probe = await safeProbe(p);
    if (probe?.ok) {
      try {
        return await p.start(request);
      } catch (err) {
        if (err?.code !== BROKER_ERROR_CODES.NOT_SUPPORTED && err?.code !== "PROVIDER_OPERATION_NOT_SUPPORTED") {
          throw err;
        }
        return this.#startCodexFallback({ request, failure: providerFailureFromError(err, probe) });
      }
    }
    return this.#startCodexFallback({ request, failure: providerFailureFromProbe(probe) });
  }

  /**
   * Attach to an externally-started thread. Optional on the provider —
   * NOT_SUPPORTED if absent.
   *
   * @param {string} providerId
   * @param {object} request
   */
  async attach(providerId, request) {
    const p = mustGetProvider(this.registry, providerId, "attach");
    mustSupport(p, "attach", "attach");
    return p.attach(request);
  }

  /**
   * Resume a prior thread by reference.
   *
   * @param {string} providerId
   * @param {object} threadRef   ProviderThreadRef
   */
  async resume(providerId, threadRef) {
    const p = mustGetProvider(this.registry, providerId, "resume");
    if (providerId === CODEX_APP_SERVER_PROVIDER_ID && !providerHasCapability(p, "threadResume")) {
      return this.#startCodexFallback({
        request: {
          resumeOf: threadRef,
          fallbackMode: "successor_spawn",
        },
        failure: {
          reason: "codex thread resume unavailable; successor spawn fallback",
          warning: providerWarning("codex_thread_resume_unavailable", "Codex thread resume unavailable; starting successor via Generic PTY", true),
        },
      });
    }
    mustSupport(p, "resume", "resume");
    return p.resume(threadRef);
  }

  /**
   * Fork from a prior thread.
   *
   * @param {string} providerId
   * @param {object} threadRef
   * @param {object} request    ProviderForkRequest
   */
  async fork(providerId, threadRef, request) {
    const p = mustGetProvider(this.registry, providerId, "fork");
    if (providerId === CODEX_APP_SERVER_PROVIDER_ID && !providerHasCapability(p, "threadFork")) {
      return this.#startCodexFallback({
        request: {
          ...(isRecord(request) ? request : {}),
          forkOf: threadRef,
          fallbackMode: "deterministic_rollover",
        },
        failure: {
          reason: "codex thread fork unavailable; deterministic rollover fallback",
          warning: providerWarning("codex_thread_fork_unavailable", "Codex thread fork unavailable; starting rollover successor via Generic PTY", true),
        },
      });
    }
    mustSupport(p, "fork", "fork");
    return p.fork(threadRef, request);
  }

  /**
   * Send input to an active thread. Optional on the provider.
   *
   * @param {string} providerId
   * @param {object} threadRef
   * @param {object} input
   */
  async send(providerId, threadRef, input) {
    const p = mustGetProvider(this.registry, providerId, "send");
    mustSupport(p, "send", "send");
    return p.send(threadRef, input);
  }

  /**
   * Steer an in-progress turn. Optional.
   *
   * @param {string} providerId
   * @param {object} threadRef
   * @param {object} input
   */
  async steer(providerId, threadRef, input) {
    const p = mustGetProvider(this.registry, providerId, "steer");
    mustSupport(p, "steer", "steer");
    return p.steer(threadRef, input);
  }

  /**
   * Interrupt an in-progress turn. Optional.
   *
   * @param {string} providerId
   * @param {object} threadRef
   */
  async interrupt(providerId, threadRef) {
    const p = mustGetProvider(this.registry, providerId, "interrupt");
    mustSupport(p, "interrupt", "interrupt");
    return p.interrupt(threadRef);
  }

  /**
   * Start a provider-native review for an active thread. Optional.
   *
   * @param {string} providerId
   * @param {object} threadRef
   * @param {object} request
   */
  async review(providerId, threadRef, request) {
    const p = mustGetProvider(this.registry, providerId, "review");
    if (providerId === CODEX_APP_SERVER_PROVIDER_ID && !providerHasCapability(p, "providerReview")) {
      throw unsupportedCodexFeature("review", "provider review unavailable");
    }
    mustSupport(p, "review", "review");
    return p.review(threadRef, request);
  }

  /**
   * Approve a pending provider approval decision. Optional.
   *
   * @param {string} providerId
   * @param {object} decision   ProviderApprovalDecision
   */
  async approve(providerId, decision) {
    const p = mustGetProvider(this.registry, providerId, "approve");
    if (providerId === CODEX_APP_SERVER_PROVIDER_ID && !providerHasCapability(p, "structuredApprovals")) {
      throw unsupportedCodexFeature("approve", "structured approvals unavailable");
    }
    mustSupport(p, "approve", "approve");
    return p.approve(decision);
  }

  /**
   * Deny a pending provider approval decision. Optional.
   *
   * @param {string} providerId
   * @param {object} decision
   */
  async deny(providerId, decision) {
    const p = mustGetProvider(this.registry, providerId, "deny");
    if (providerId === CODEX_APP_SERVER_PROVIDER_ID && !providerHasCapability(p, "structuredApprovals")) {
      throw unsupportedCodexFeature("deny", "structured approvals unavailable");
    }
    mustSupport(p, "deny", "deny");
    return p.deny(decision);
  }

  /**
   * Stream events from a provider thread. Returns an AsyncIterable that
   * yields `ProviderEvent` shapes; the SessionTimelineService / event
   * normalizer (SH-2-19) consumes this stream.
   *
   * @param {string} providerId
   * @param {object} threadRef
   * @returns {AsyncIterable<object>}
   */
  streamEvents(providerId, threadRef) {
    return mustGetProvider(this.registry, providerId, "streamEvents").streamEvents(threadRef);
  }

  /**
   * Stop a provider thread. Optional — providers without process
   * lifecycle (e.g., ManualProvider) raise NOT_SUPPORTED.
   *
   * @param {string} providerId
   * @param {object} threadRef
   */
  async stop(providerId, threadRef) {
    const p = mustGetProvider(this.registry, providerId, "stop");
    mustSupport(p, "stop", "stop");
    return p.stop(threadRef);
  }

  #fallbackProvider() {
    for (const providerId of this.codexFallbackProviderIds) {
      const provider = this.registry.get(providerId);
      if (provider && typeof provider.start === "function") return provider;
    }
    return null;
  }

  async #startCodexFallback({ request, failure }) {
    const fallback = this.#fallbackProvider();
    if (!fallback) {
      throw brokerError(
        "ProviderBroker.start: codex_app_server unavailable and no Generic PTY fallback provider registered",
        BROKER_ERROR_CODES.NOT_FOUND,
        {
          providerId: CODEX_APP_SERVER_PROVIDER_ID,
          fallbackProviderIds: this.codexFallbackProviderIds,
          failure,
        },
      );
    }
    const fallbackRequest = {
      ...(isRecord(request) ? request : {}),
      requestedProviderId: CODEX_APP_SERVER_PROVIDER_ID,
      providerFallback: {
        fromProviderId: CODEX_APP_SERVER_PROVIDER_ID,
        toProviderId: fallback.id,
        reason: failure?.reason || "codex_app_server unavailable",
        transportPriority: ["stdio", "unix", "websocket"],
      },
    };
    const handle = await fallback.start(fallbackRequest);
    return {
      ...(isRecord(handle) ? handle : { handle }),
      providerId: text(handle?.providerId) || fallback.id,
      requestedProviderId: CODEX_APP_SERVER_PROVIDER_ID,
      fallback: fallbackRequest.providerFallback,
      warnings: [failure?.warning || providerWarning(
        "codex_app_server_unavailable",
        "Codex App Server unavailable; falling back to Generic PTY",
        true,
      )],
    };
  }
}

function normalizeProviderIds(value, fallback) {
  const list = Array.isArray(value) ? value : fallback;
  return list.filter((item) => typeof item === "string" && item.length > 0);
}

async function safeProbe(provider) {
  try {
    return await provider.probe();
  } catch (err) {
    return { ok: false, reason: err?.message || "probe failed", details: { error: err?.message || String(err) } };
  }
}

function providerFailureFromProbe(probe) {
  const warning = probe?.details?.warning || providerWarning(
    probe?.details?.code || "codex_app_server_unavailable",
    probe?.reason || "Codex App Server unavailable; falling back to Generic PTY",
    probe?.details?.setupRequired !== true,
    probe?.details?.setupRequired === true,
  );
  return {
    reason: probe?.reason || "codex_app_server unavailable",
    warning,
  };
}

function providerFailureFromError(err, probe) {
  return {
    reason: err?.message || probe?.reason || "codex_app_server start unsupported",
    warning: providerWarning(
      err?.code || "codex_app_server_start_unsupported",
      err?.message || "Codex App Server start unsupported; falling back to Generic PTY",
      true,
    ),
  };
}

function providerWarning(code, message, retryable, setupRequired = false) {
  return {
    kind: "provider_error",
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    code,
    message,
    retryable,
    setupRequired,
  };
}

function providerHasCapability(provider, capability) {
  try {
    const caps = typeof provider.capabilities === "function" ? provider.capabilities() : {};
    return caps?.[capability] === true;
  } catch {
    return false;
  }
}

function unsupportedCodexFeature(operation, reason) {
  return brokerError(
    `ProviderBroker.${operation}: ${reason}`,
    BROKER_ERROR_CODES.NOT_SUPPORTED,
    {
      providerId: CODEX_APP_SERVER_PROVIDER_ID,
      operation,
      fallback: { mode: "unsupported" },
      warning: providerWarning(`codex_${operation}_unsupported`, `Codex ${reason}`, false),
    },
  );
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}
