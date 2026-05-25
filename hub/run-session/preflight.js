// hub/run-session/preflight.js — sh-3-18 (TDD v0.5 §6.7, §8A.1)
//
// Pure Run Session preflight warning producer. The draft store validates the
// warning schema; this module decides which advisory warnings should be shown
// before launch. Launch-time services remain authoritative for mutations and
// conflict enforcement.

import { toSessionCapabilities } from "../providers/capabilities.js";
import { TERMINAL_JOB_STATUS } from "../jobs/registry.js";

const ACTIVE_SESSION_STATUSES = new Set([
  "starting",
  "active",
  "running",
  "idle",
  "waiting_for_human",
  "waiting_for_approval",
  "quiet",
  "context_high",
  "stopping",
  "resuming",
  "unknown",
  "not_responding",
  "blocked",
]);

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameProject(record, projectSlug) {
  if (!projectSlug) return true;
  const value = record?.projectSlug ?? record?.project?.slug;
  return !nonEmptyString(value) || value === projectSlug;
}

function targetTaskId(draft) {
  if (!isRecord(draft)) return null;
  if (draft.mode === "attach_existing" && nonEmptyString(draft.attachTaskId)) return draft.attachTaskId;
  return nonEmptyString(draft.taskId) ? draft.taskId : null;
}

function currentSessionId(draft) {
  if (!isRecord(draft)) return null;
  return nonEmptyString(draft.attachExistingSessionId)
    ? draft.attachExistingSessionId
    : nonEmptyString(draft.sessionId)
      ? draft.sessionId
      : null;
}

function getProvider(providerRegistry, providerId) {
  if (!providerRegistry || !nonEmptyString(providerId)) return undefined;
  if (typeof providerRegistry.get === "function") return providerRegistry.get(providerId);
  if (providerRegistry instanceof Map) return providerRegistry.get(providerId);
  return undefined;
}

function providerCapabilities(provider) {
  if (!provider || typeof provider.capabilities !== "function") return null;
  try {
    const caps = provider.capabilities();
    if (!isRecord(caps)) return null;
    toSessionCapabilities(caps);
    return caps;
  } catch {
    return null;
  }
}

function sessionCapabilitiesFor(draft, provider) {
  const caps = isRecord(draft?.capabilityPreview)
    ? draft.capabilityPreview
    : providerCapabilities(provider);
  if (!caps) return null;
  try {
    return toSessionCapabilities(caps);
  } catch {
    return null;
  }
}

function requiredCapabilities(input) {
  if (!Array.isArray(input.requiredCapabilities)) return [];
  return input.requiredCapabilities.filter(nonEmptyString);
}

function sandboxResult(sandbox, policy) {
  if (!nonEmptyString(sandbox) || !policy) return null;
  if (typeof policy === "function") {
    const result = policy(sandbox);
    if (result === true) return null;
    if (result === false) return { allowed: false, reason: `sandbox ${sandbox} is disallowed` };
    return isRecord(result) && result.allowed === false
      ? { allowed: false, reason: nonEmptyString(result.reason) ? result.reason : `sandbox ${sandbox} is disallowed` }
      : null;
  }

  const allowed = Array.isArray(policy.allowedSandboxes)
    ? policy.allowedSandboxes
    : Array.isArray(policy.allowed)
      ? policy.allowed
      : null;
  if (allowed && !allowed.includes(sandbox)) {
    return {
      allowed: false,
      reason: nonEmptyString(policy.reason) ? policy.reason : `sandbox ${sandbox} is not allowed by policy`,
    };
  }
  return null;
}

function findOtherTaskBinding(draft, jobs = [], sessions = []) {
  const projectSlug = draft?.projectSlug;
  const taskId = targetTaskId(draft);
  const ownSessionId = currentSessionId(draft);
  if (!nonEmptyString(taskId)) return null;

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!isRecord(job)) continue;
    if (job.taskId !== taskId || !sameProject(job, projectSlug)) continue;
    if (TERMINAL_JOB_STATUS.includes(job.status)) continue;
    if (ownSessionId && job.sessionId === ownSessionId) continue;
    if (nonEmptyString(job.id) && nonEmptyString(job.sessionId)) {
      return { otherJobId: job.id, otherSessionId: job.sessionId };
    }
  }

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isRecord(session)) continue;
    if (session.taskId !== taskId || !sameProject(session, projectSlug)) continue;
    if (ownSessionId && session.id === ownSessionId) continue;
    if (!ACTIVE_SESSION_STATUSES.has(session.status)) continue;
    if (nonEmptyString(session.id) && nonEmptyString(session.activeJobId)) {
      return { otherJobId: session.activeJobId, otherSessionId: session.id };
    }
  }

  return null;
}

function contextBudgetOverflow(contextBudget) {
  if (!isRecord(contextBudget)) return null;
  const { currentUsed, estBriefTokens, capacity } = contextBudget;
  if (!nonNegativeNumber(currentUsed) || !nonNegativeNumber(estBriefTokens) || !nonNegativeNumber(capacity)) {
    return null;
  }
  if (capacity <= 0 || currentUsed + estBriefTokens <= capacity) return null;
  return {
    kind: "attach_context_overflow",
    currentUsed,
    estBriefTokens,
    capacity,
    severity: currentUsed >= capacity ? "high" : "medium",
  };
}

/**
 * Build advisory warnings for a RunSessionDraft preflight.
 *
 * @param {object} input
 * @param {object} input.draft
 * @param {{get(id:string): object | undefined} | Map<string, object>} [input.providerRegistry]
 * @param {string[]} [input.requiredCapabilities]
 * @param {Function | {allowed?: string[], allowedSandboxes?: string[], reason?: string}} [input.sandboxPolicy]
 * @param {object[]} [input.jobs]
 * @param {object[]} [input.sessions]
 * @param {{currentUsed:number, estBriefTokens:number, capacity:number}} [input.contextBudget]
 * @param {boolean} [input.contextInjectionRequested]
 * @returns {object[]}
 */
export function buildRunSessionPreflightWarnings(input = {}) {
  if (!isRecord(input)) throw new TypeError("buildRunSessionPreflightWarnings: input must be an object");
  const draft = isRecord(input.draft) ? input.draft : {};
  const warnings = [];

  const providerId = draft.providerId;
  const provider = getProvider(input.providerRegistry, providerId);
  const providerIsUnavailable =
    nonEmptyString(providerId) &&
    input.providerRegistry &&
    (!provider || !providerCapabilities(provider));
  if (providerIsUnavailable) {
    warnings.push({ kind: "provider_unavailable", providerId, severity: "high" });
  }

  const sessionCaps = provider ? sessionCapabilitiesFor(draft, provider) : sessionCapabilitiesFor(draft, null);
  if (sessionCaps) {
    for (const cap of requiredCapabilities(input)) {
      if (sessionCaps[cap] !== true) {
        warnings.push({ kind: "capability_mismatch", requiredCap: cap, severity: "high" });
      }
    }
  }

  const sandbox = sandboxResult(draft.sandbox, input.sandboxPolicy);
  if (sandbox) {
    warnings.push({
      kind: "sandbox_disallowed",
      sandbox: draft.sandbox,
      reason: sandbox.reason,
      severity: "high",
    });
  }

  if ((input.contextInjectionRequested || draft.refreshContext === true) && sessionCaps?.directContextInjection !== true) {
    warnings.push({ kind: "context_injection_unsupported", severity: "medium" });
  }

  const binding = findOtherTaskBinding(draft, input.jobs, input.sessions);
  if (binding) {
    warnings.push({
      kind: "task_already_bound_other_session",
      otherSessionId: binding.otherSessionId,
      otherJobId: binding.otherJobId,
      severity: "high",
    });
  }

  const overflow = draft.mode === "attach_existing" || draft.source === "attach"
    ? contextBudgetOverflow(input.contextBudget)
    : null;
  if (overflow) warnings.push(overflow);

  return warnings;
}
