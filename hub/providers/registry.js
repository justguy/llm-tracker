// hub/providers/registry.js — SH-2-15 (addendum §4 / §6)
//
// ProviderRegistry — holds the set of RuntimeProvider instances that are
// available in this hub process. Real provider implementations
// (CodexAppServerProvider, GenericPtyProvider, ManualProvider, etc.) land in
// later tasks (SH-2-17 / SH-2-18 / SH-9-*); this module is the registration
// + discovery surface they plug into.
//
// Provider shape (addendum §6, mirrored as JSDoc for this JS codebase):
//
//   interface RuntimeProvider {
//     id: string;                                // unique providerId
//     label: string;                             // UI display name
//     probe(): Promise<ProviderProbeResult>;     // { ok, reason? }
//     capabilities(): ProviderCapabilities;
//     listModels?(): Promise<ModelOption[]>;
//     listSkills?(req): Promise<ProviderSkill[]>;
//     start(request): Promise<ProviderThreadHandle>;
//     attach?(request): Promise<ProviderThreadHandle>;
//     resume?(threadRef): Promise<ProviderThreadHandle>;
//     fork?(threadRef, request): Promise<ProviderThreadHandle>;
//     send?(threadRef, input): Promise<void>;
//     steer?(threadRef, input): Promise<void>;
//     interrupt?(threadRef): Promise<void>;
//     approve?(decision): Promise<void>;
//     deny?(decision): Promise<void>;
//     streamEvents(threadRef): AsyncIterable<ProviderEvent>;
//     stop?(threadRef): Promise<void>;
//   }
//
// The registry enforces only the *minimum* contract: `id`, `label`,
// `probe`, `capabilities`, `start`, `streamEvents` must exist. Optional
// methods (attach / resume / fork / send / steer / interrupt / approve /
// deny / stop) are checked at call sites by the broker.

/**
 * @typedef {object} ProviderProbeResult
 * @property {boolean} ok                     true → provider is available in this env
 * @property {string} [reason]                short human-readable reason on !ok
 * @property {object} [details]               structured details (binary path, version, etc.)
 */

/**
 * @typedef {object} RuntimeProvider
 * @property {string} id
 * @property {string} label
 * @property {() => Promise<ProviderProbeResult>} probe
 * @property {() => object} capabilities
 * @property {(request: object) => Promise<object>} start
 * @property {(threadRef: object) => AsyncIterable<object>} streamEvents
 */

const REQUIRED_METHODS = ["probe", "capabilities", "start", "streamEvents"];

/**
 * Validate the minimum surface of a candidate RuntimeProvider. Throws a
 * sharp error naming the missing field so registry misconfiguration shows
 * up at registration time, not at first `start()` call.
 *
 * @param {unknown} provider
 * @returns {void}
 */
export function assertValidProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("RuntimeProvider must be an object");
  }
  for (const key of ["id", "label"]) {
    if (typeof provider[key] !== "string" || provider[key].length === 0) {
      throw new TypeError(`RuntimeProvider.${key} must be a non-empty string`);
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`RuntimeProvider '${provider.id}' missing required method: ${method}`);
    }
  }
}

/**
 * In-memory store of available RuntimeProvider instances. Lookups are by
 * `providerId`; iteration order matches registration order (used by the
 * UI to render providers in a stable list).
 */
export class ProviderRegistry {
  /**
   * @param {object} [opts]
   * @param {(level: "info"|"warn"|"error", msg: string, meta?: object) => void} [opts.log]
   */
  constructor(opts = {}) {
    /** @type {Map<string, RuntimeProvider>} */
    this.byId = new Map();
    this.log = typeof opts.log === "function" ? opts.log : () => {};
  }

  /**
   * Register a single provider instance. Throws on duplicate id or invalid
   * shape — callers should treat a registration failure as fatal at
   * startup.
   *
   * @param {RuntimeProvider} provider
   * @returns {void}
   */
  register(provider) {
    assertValidProvider(provider);
    if (this.byId.has(provider.id)) {
      throw new Error(`ProviderRegistry: duplicate providerId '${provider.id}'`);
    }
    this.byId.set(provider.id, provider);
  }

  /**
   * Look up a provider by id. Returns undefined when no such provider is
   * registered (the broker turns this into a NOT_FOUND error at call sites).
   *
   * @param {string} providerId
   * @returns {RuntimeProvider | undefined}
   */
  get(providerId) {
    if (typeof providerId !== "string") return undefined;
    return this.byId.get(providerId);
  }

  /**
   * Snapshot of registered providers in registration order.
   *
   * @returns {RuntimeProvider[]}
   */
  list() {
    return [...this.byId.values()];
  }

  /**
   * Whether a provider with this id is registered.
   *
   * @param {string} providerId
   */
  has(providerId) {
    return typeof providerId === "string" && this.byId.has(providerId);
  }

  /**
   * Run discovery: each factory in `factories` is called (optionally with
   * `opts.factoryContext`), the resulting provider is probed, and only
   * providers whose `probe()` resolves `ok: true` are registered. Factories
   * may also be plain provider instances — those are probed in-place.
   *
   * Factory failures and probe failures DO NOT throw — they are logged via
   * `this.log` and the provider is simply skipped. This keeps a single
   * unavailable provider from blocking hub startup; the operator sees the
   * skip in the hub logs.
   *
   * @param {object} [opts]
   * @param {Array<RuntimeProvider | ((ctx?: object) => RuntimeProvider | Promise<RuntimeProvider>)>} [opts.factories]
   * @param {object} [opts.factoryContext]
   * @returns {Promise<{ registered: string[]; skipped: Array<{ id?: string; reason: string }> }>}
   */
  async discover(opts = {}) {
    const { factories = [], factoryContext } = opts;
    /** @type {string[]} */
    const registered = [];
    /** @type {Array<{ id?: string; reason: string }>} */
    const skipped = [];

    for (const entry of factories) {
      /** @type {RuntimeProvider | undefined} */
      let provider;
      try {
        provider = typeof entry === "function" ? await entry(factoryContext) : entry;
      } catch (err) {
        const reason = `factory threw: ${err?.message || err}`;
        skipped.push({ reason });
        this.log("warn", "provider factory threw during discovery", { reason });
        continue;
      }

      try {
        assertValidProvider(provider);
      } catch (err) {
        const reason = `invalid provider: ${err?.message || err}`;
        skipped.push({ id: provider?.id, reason });
        this.log("warn", "provider failed shape validation", { reason });
        continue;
      }

      let probeResult;
      try {
        probeResult = await provider.probe();
      } catch (err) {
        const reason = `probe threw: ${err?.message || err}`;
        skipped.push({ id: provider.id, reason });
        this.log("warn", `provider probe threw: ${provider.id}`, { reason });
        continue;
      }

      if (!probeResult || probeResult.ok !== true) {
        const reason = probeResult?.reason || "probe returned ok=false";
        skipped.push({ id: provider.id, reason });
        this.log("info", `provider unavailable: ${provider.id}`, { reason });
        continue;
      }

      if (this.byId.has(provider.id)) {
        skipped.push({ id: provider.id, reason: `duplicate providerId during discovery` });
        this.log("warn", `duplicate provider id during discovery: ${provider.id}`);
        continue;
      }

      this.byId.set(provider.id, provider);
      registered.push(provider.id);
    }

    return { registered, skipped };
  }
}
