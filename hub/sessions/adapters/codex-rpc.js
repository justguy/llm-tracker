// hub/sessions/adapters/codex-rpc.js
//
// Codex App Server session adapter handshake surface. This slice owns the
// hello/capability cache only; thread lifecycle methods land in later SH-9
// tasks.

import {
  PROVIDER_CAPABILITY_KEYS,
  defaultProviderCapabilities,
  validateProviderCapabilities,
} from "../../providers/capabilities.js";

export const CODEX_RPC_HELLO_METHOD = "hello";

export const CODEX_RPC_FEATURE_CAPABILITIES = Object.freeze({
  approvals: "structuredApprovals",
  commands: "structuredCommandEvents",
  contextUsage: "structuredContextUsage",
  diffs: "providerDiffs",
  directContextInjection: "directContextInjection",
  fork: "threadFork",
  interrupt: "turnInterrupt",
  modelList: "modelList",
  resume: "threadResume",
  review: "providerReview",
  skillList: "skillList",
  steer: "turnSteer",
  structuredChat: "structuredTurns",
  structuredEvents: "structuredThread",
});

export function createCodexRpcSessionAdapter(opts = {}) {
  return new CodexRpcSessionAdapter(opts);
}

export class CodexRpcSessionAdapter {
  constructor({
    provider,
    rpcClient,
    schemaValidator,
    helloMethod,
    handshakeParams,
    now = () => new Date(),
  } = {}) {
    if (!provider && !rpcClient) {
      throw new TypeError("CodexRpcSessionAdapter: provider or rpcClient required");
    }
    if (provider && typeof provider.createRpcClient !== "function" && !rpcClient) {
      throw new TypeError("CodexRpcSessionAdapter: provider.createRpcClient required");
    }
    if (rpcClient && typeof rpcClient.call !== "function") {
      throw new TypeError("CodexRpcSessionAdapter: rpcClient.call required");
    }
    if (schemaValidator && !Array.isArray(schemaValidator.methods)) {
      throw new TypeError("CodexRpcSessionAdapter: schemaValidator.methods must be an array");
    }
    if (typeof now !== "function") {
      throw new TypeError("CodexRpcSessionAdapter: now must be a function");
    }

    this.kind = "codex_app_server";
    this.provider = provider || null;
    this.rpcClient = rpcClient || null;
    this.schemaValidator = schemaValidator || null;
    this.helloMethod = helloMethod || selectHelloMethod({
      methods: schemaValidator?.methods || rpcClient?.methods || [],
    });
    this.handshakeParams = isRecord(handshakeParams) ? { ...handshakeParams } : {};
    this.now = now;
    this._capabilities = defaultProviderCapabilities();
    this._featureFlags = featuresFromCapabilities(this._capabilities);
    this._hello = null;
  }

  async hello(params = {}) {
    const client = this._client();
    const response = await client.call(this.helloMethod, {
      ...this.handshakeParams,
      ...(isRecord(params) ? params : {}),
    });
    const capabilities = normalizeHelloCapabilities(response);
    this._capabilities = Object.freeze(capabilities);
    this._featureFlags = Object.freeze(featuresFromCapabilities(capabilities));
    this._hello = Object.freeze({
      receivedAt: this._isoNow(),
      method: this.helloMethod,
      response: clonePlain(response),
      capabilities: this._capabilities,
      features: this._featureFlags,
    });
    return this._hello;
  }

  capabilities() {
    return { ...this._capabilities };
  }

  features() {
    return { ...this._featureFlags };
  }

  hasCapability(capability) {
    return this._capabilities[capability] === true;
  }

  featureEnabled(feature) {
    return this._featureFlags[feature] === true;
  }

  lastHello() {
    return this._hello;
  }

  async close() {
    if (this.rpcClient && typeof this.rpcClient.close === "function") {
      await this.rpcClient.close();
    }
  }

  _client() {
    if (!this.rpcClient) this.rpcClient = this.provider.createRpcClient();
    return this.rpcClient;
  }

  _isoNow() {
    const value = this.now();
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
  }
}

export function selectHelloMethod({ methods = [] } = {}) {
  const candidates = Array.isArray(methods) ? methods : [];
  if (candidates.includes(CODEX_RPC_HELLO_METHOD)) return CODEX_RPC_HELLO_METHOD;
  const dotted = candidates.find((method) => typeof method === "string" && method.endsWith(".hello"));
  if (dotted) return dotted;
  throw capabilityError("Codex RPC schema does not expose a hello method", "CODEX_RPC_HELLO_UNAVAILABLE", {
    methods: candidates,
  });
}

export function normalizeHelloCapabilities(response) {
  const source = selectCapabilitySource(response);
  const out = defaultProviderCapabilities();
  if (Array.isArray(source)) {
    for (const key of source) {
      if (typeof key === "string" && PROVIDER_CAPABILITY_KEYS.includes(key)) out[key] = true;
    }
    return Object.freeze(validateProviderCapabilities(out));
  }
  if (isRecord(source)) {
    for (const key of PROVIDER_CAPABILITY_KEYS) {
      out[key] = source[key] === true;
    }
    return Object.freeze(validateProviderCapabilities(out));
  }
  return Object.freeze(validateProviderCapabilities(out));
}

export function featuresFromCapabilities(capabilities = {}) {
  const caps = validateProviderCapabilities({
    ...defaultProviderCapabilities(),
    ...(isRecord(capabilities) ? capabilities : {}),
  });
  const out = {};
  for (const [feature, capability] of Object.entries(CODEX_RPC_FEATURE_CAPABILITIES)) {
    out[feature] = caps[capability] === true;
  }
  return out;
}

function selectCapabilitySource(response) {
  if (!isRecord(response)) return null;
  if ("capabilities" in response) return response.capabilities;
  if ("capabilityFlags" in response) return response.capabilityFlags;
  if (isRecord(response.provider) && "capabilities" in response.provider) return response.provider.capabilities;
  if (isRecord(response.result) && "capabilities" in response.result) return response.result.capabilities;
  return null;
}

function clonePlain(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function capabilityError(message, code, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}
