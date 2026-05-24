// hub/providers/capabilities.js — SH-2-16 (addendum §5)
//
// ProviderCapabilities — the 20-flag shape each RuntimeProvider returns from
// its capabilities() method. The hub combines this with policy / runtime
// state to derive the SessionCapabilities surface (TDD §6.2) that cards and
// the tool shelf consume.
//
// This module is the single source of truth for both shapes; consumers
// should import PROVIDER_CAPABILITY_KEYS / SESSION_CAPABILITY_KEYS rather
// than re-listing the flag names.

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

/**
 * @typedef {object} SessionCapabilities
 * @property {boolean} rawStdio
 * @property {boolean} stdinWrite
 * @property {boolean} processLifecycle
 * @property {boolean} structuredEvents
 * @property {boolean} structuredApprovals
 * @property {boolean} structuredChat
 * @property {boolean} structuredCommands
 * @property {boolean} structuredMcpCalls
 * @property {boolean} explicitTrackerMcp
 * @property {boolean} appServerChat
 * @property {boolean} directContextInjection
 */

/**
 * The 20 ProviderCapabilities flags in addendum §5 order. Used by the
 * validator to detect unknown keys and by defaultProviderCapabilities() to
 * build a fresh all-false base.
 */
export const PROVIDER_CAPABILITY_KEYS = Object.freeze([
  "structuredThread",
  "structuredTurns",
  "structuredItems",
  "structuredApprovals",
  "structuredFileChanges",
  "structuredCommandEvents",
  "structuredContextUsage",
  "providerTimeline",
  "providerDiffs",
  "providerReview",
  "modelList",
  "skillList",
  "threadResume",
  "threadFork",
  "turnSteer",
  "turnInterrupt",
  "rawStdio",
  "stdinWrite",
  "processLifecycle",
  "directContextInjection",
]);

/**
 * The 11 SessionCapabilities flags in TDD §6.2 order.
 */
export const SESSION_CAPABILITY_KEYS = Object.freeze([
  "rawStdio",
  "stdinWrite",
  "processLifecycle",
  "structuredEvents",
  "structuredApprovals",
  "structuredChat",
  "structuredCommands",
  "structuredMcpCalls",
  "explicitTrackerMcp",
  "appServerChat",
  "directContextInjection",
]);

const PROVIDER_KEY_SET = new Set(PROVIDER_CAPABILITY_KEYS);

/**
 * Build a fresh ProviderCapabilities object with every flag = false. Each
 * call returns a new object so providers can safely spread their overrides
 * onto it without aliasing.
 *
 * @returns {ProviderCapabilities}
 */
export function defaultProviderCapabilities() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    out[key] = false;
  }
  return /** @type {ProviderCapabilities} */ (out);
}

/**
 * Validate the shape of a ProviderCapabilities object. Throws TypeError
 * with a sharp message if `caps` is not an object, has any unknown key, or
 * has a non-boolean at a known key. Missing known keys are NOT an error —
 * the mapping reads them with `||` semantics — but callers that want a
 * complete object should spread over defaultProviderCapabilities() first.
 *
 * @param {unknown} caps
 * @returns {ProviderCapabilities}
 */
export function validateProviderCapabilities(caps) {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    throw new TypeError("ProviderCapabilities must be an object");
  }
  for (const key of Object.keys(caps)) {
    if (!PROVIDER_KEY_SET.has(key)) {
      throw new TypeError(`ProviderCapabilities: unknown key '${key}'`);
    }
    const value = /** @type {Record<string, unknown>} */ (caps)[key];
    if (typeof value !== "boolean") {
      throw new TypeError(`ProviderCapabilities.${key} must be boolean`);
    }
  }
  return /** @type {ProviderCapabilities} */ (caps);
}

/**
 * Derive the SessionCapabilities shape from a ProviderCapabilities object.
 * Mapping is verbatim from addendum §5:
 *
 *   structuredEvents      = structuredThread || structuredTurns || structuredItems
 *   structuredChat        = structuredTurns
 *   structuredCommands    = structuredCommandEvents
 *   structuredMcpCalls    = false   (not provider-derivable)
 *   explicitTrackerMcp    = false   (not provider-derivable)
 *   appServerChat         = structuredTurns
 *   (rawStdio / stdinWrite / processLifecycle / structuredApprovals /
 *    directContextInjection pass through unchanged)
 *
 * @param {ProviderCapabilities} providerCaps
 * @returns {SessionCapabilities}
 */
export function toSessionCapabilities(providerCaps) {
  validateProviderCapabilities(providerCaps);
  return {
    rawStdio: providerCaps.rawStdio,
    stdinWrite: providerCaps.stdinWrite,
    processLifecycle: providerCaps.processLifecycle,
    structuredEvents:
      providerCaps.structuredThread ||
      providerCaps.structuredTurns ||
      providerCaps.structuredItems,
    structuredApprovals: providerCaps.structuredApprovals,
    structuredChat: providerCaps.structuredTurns,
    structuredCommands: providerCaps.structuredCommandEvents,
    structuredMcpCalls: false,
    explicitTrackerMcp: false,
    appServerChat: providerCaps.structuredTurns,
    directContextInjection: providerCaps.directContextInjection,
  };
}
