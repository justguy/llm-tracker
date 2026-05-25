// hub/providers/manual.js — SH-2-18 (PRD §6.3 / §7, addendum §6)
//
// ManualProvider — advisory-only RuntimeProvider for the "manual" session
// tier. Per PRD §6.3, manual sessions are human-attached/advisory only:
// no process, no adapter, no stdio capture, no structured events. State
// transitions come exclusively from explicit human edits in the UI/CLI.
// Per addendum §5, every ProviderCapabilities flag is therefore false —
// tier-level state-source labeling lives at the SessionRecord layer, not
// here. Optional lifecycle methods (attach/resume/fork/send/steer/
// interrupt/approve/deny/stop/listModels/listSkills) are deliberately
// omitted so the broker raises NOT_SUPPORTED per its existing contract.
// This module underwrites the Phase 6 MCP-contract paste path: external
// agents can post advisory thread handles without the hub ever needing
// to spawn a process.

/**
 * @typedef {object} ProviderCapabilities
 * @property {boolean} structuredThread
 * @property {boolean} structuredTurns
 * @property {boolean} structuredItems
 * @property {boolean} structuredApprovals
 * @property {boolean} structuredFileChanges
 * @property {boolean} structuredCommandEvents
 * @property {boolean} structuredContextUsage
 * @property {boolean} providerTimeline
 * @property {boolean} providerDiffs
 * @property {boolean} providerReview
 * @property {boolean} modelList
 * @property {boolean} skillList
 * @property {boolean} threadResume
 * @property {boolean} threadFork
 * @property {boolean} turnSteer
 * @property {boolean} turnInterrupt
 * @property {boolean} rawStdio
 * @property {boolean} stdinWrite
 * @property {boolean} processLifecycle
 * @property {boolean} directContextInjection
 */

/** Stable id for the manual provider. */
export const MANUAL_PROVIDER_ID = "manual";

/** Human-readable label shown in the UI provider list. */
export const MANUAL_PROVIDER_LABEL = "Manual (advisory)";

/**
 * Capability flags for the manual tier. All twenty flags are `false`:
 * a manual session has no provider-driven capability whatsoever — every
 * state change is a human edit. Returns a fresh object on each call so
 * callers cannot accidentally mutate a shared instance.
 *
 * @returns {ProviderCapabilities}
 */
export function manualCapabilities() {
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
    rawStdio: false,
    stdinWrite: false,
    processLifecycle: false,
    directContextInjection: false,
  };
}

/**
 * Generate an advisory threadId. These IDs are not security tokens —
 * they are stable references for the human-edited manual tier — so
 * `Math.random()` plus a timestamp is appropriate. Prefix `man_` makes
 * the source tier obvious in logs.
 *
 * @param {number} nowMs
 * @returns {string}
 */
function generateManualThreadId(nowMs) {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `man_${nowMs}_${suffix}`;
}

/**
 * Create a ManualProvider instance. The factory accepts an injectable
 * clock to keep tests deterministic; production callers omit it.
 *
 * The returned object implements only the minimum RuntimeProvider
 * surface required by `assertValidProvider` (id, label, probe,
 * capabilities, start, streamEvents). Every optional lifecycle method
 * is omitted: the broker maps missing optional methods to NOT_SUPPORTED,
 * which is the contract for the manual tier.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]   injectable clock; defaults to Date.now
 * @returns {object} RuntimeProvider instance
 */
export function createManualProvider(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  return {
    id: MANUAL_PROVIDER_ID,
    label: MANUAL_PROVIDER_LABEL,

    /**
     * The manual provider is always available — it depends on no binary,
     * no socket, no environment. Returning `ok: true` lets the registry
     * discover() always register it.
     *
     * @returns {Promise<{ ok: true; reason: string }>}
     */
    async probe() {
      return { ok: true, reason: "manual provider is always available" };
    },

    capabilities() {
      return manualCapabilities();
    },

    /**
     * Create an advisory thread handle. No process is spawned, no file
     * descriptor is opened, no resource is held. The handle is just an
     * identifier the SessionRegistry can hang human-edit state on.
     *
     * @param {object} request   { cwd?, repoRoot?, ... } (only cwd/repoRoot are read)
     * @returns {Promise<{ providerId: "manual"; transport: "manual"; threadId: string; cwd?: string; repoRoot?: string; createdAt: string }>}
     */
    async start(request) {
      if (!request || typeof request !== "object") {
        throw new TypeError("ManualProvider.start: request must be an object");
      }
      const nowMs = now();
      return {
        providerId: MANUAL_PROVIDER_ID,
        transport: "manual",
        threadId: generateManualThreadId(nowMs),
        cwd: request.cwd,
        repoRoot: request.repoRoot,
        createdAt: new Date(nowMs).toISOString(),
      };
    },

    /**
     * Manual sessions emit no provider events — there is no underlying
     * process to capture from. The async iterator completes immediately.
     * `threadRef` is still validated so the broker's threadRef-binding
     * contract is honored.
     *
     * @param {object} threadRef   { providerId, threadId }
     * @returns {AsyncIterable<never>}
     */
    streamEvents(threadRef) {
      if (!threadRef || typeof threadRef !== "object") {
        throw new TypeError("ManualProvider.streamEvents: threadRef must be an object");
      }
      if (threadRef.providerId !== MANUAL_PROVIDER_ID) {
        throw new TypeError(
          `ManualProvider.streamEvents: threadRef.providerId must be '${MANUAL_PROVIDER_ID}'`,
        );
      }
      if (typeof threadRef.threadId !== "string" || threadRef.threadId.length === 0) {
        throw new TypeError("ManualProvider.streamEvents: threadRef.threadId must be a non-empty string");
      }
      return (async function* () {
        // no events emitted by a manual provider
      })();
    },

    // Deliberately omitted (broker raises NOT_SUPPORTED):
    //   attach, resume, fork, send, steer, interrupt,
    //   approve, deny, stop, listModels, listSkills.
  };
}
