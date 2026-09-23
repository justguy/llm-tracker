// hub/context-packs/rollover.js - SH-8-03
//
// Deterministic rollover pack assembly. The per-section composer lives under
// composers/; this module owns the rollover-specific evidence selection and
// the rule that old-session handoff content is advisory only.

import { composeRolloverPack } from "./composers/rollover.js";

export const ROLLOVER_ADVISORY_HANDOFF_LABEL =
  "old-session claim; verify against tracker/git evidence";

export const ROLLOVER_TRIGGER_SOURCES = Object.freeze([
  Object.freeze({ id: "manual", label: "manual" }),
  Object.freeze({ id: "context_high", label: "context-high" }),
  Object.freeze({ id: "missing_heartbeat", label: "missing heartbeat" }),
  Object.freeze({ id: "mcp", label: "MCP" }),
  Object.freeze({ id: "resume_reload", label: "resume/reload" }),
]);

const ROLLOVER_TRIGGER_BY_ID = new Map(
  ROLLOVER_TRIGGER_SOURCES.map((source) => [source.id, source]),
);

const ROLLOVER_TRIGGER_ALIASES = Object.freeze({
  manual: "manual",
  ui: "manual",
  user: "manual",
  human: "manual",
  click: "manual",
  user_click: "manual",
  rollover: "manual",
  context_high: "context_high",
  context: "context_high",
  ctx_high: "context_high",
  "context-high": "context_high",
  "context high": "context_high",
  missing_heartbeat: "missing_heartbeat",
  no_heartbeat: "missing_heartbeat",
  heartbeat_missing: "missing_heartbeat",
  not_responding: "missing_heartbeat",
  "missing heartbeat": "missing_heartbeat",
  mcp: "mcp",
  tracker_job_rollover: "mcp",
  resume: "resume_reload",
  reload: "resume_reload",
  resumed: "resume_reload",
  reloaded: "resume_reload",
  resume_requested: "resume_reload",
  reload_requested: "resume_reload",
  "session.resume": "resume_reload",
  "session.reload": "resume_reload",
  resume_reload: "resume_reload",
  resume_reload_flow: "resume_reload",
  "resume/reload": "resume_reload",
  "resume reload": "resume_reload",
});

export function buildRolloverPack(input = {}, deps = {}) {
  const params = annotateRolloverInput(input);
  const evidence = resolveEvidence(params, deps);
  const handoff = resolveAdvisoryHandoff(params, deps);
  const pack = composeRolloverPack({
    ...params,
    rolloverEvidence: {
      trigger: params.rolloverTrigger,
    },
    brief: evidence.brief,
    why: evidence.why,
    execute: evidence.execute,
    verify: evidence.verify,
    changed: evidence.changed,
    history: evidence.history,
    sinceRev: evidence.sinceRev,
    runtimeEvents: evidence.runtimeEvents,
    repoEvents: evidence.repoEvents,
    git: evidence.git,
    ...(handoff ? { advisoryHandoff: handoff } : {}),
  }, deps);
  return annotateRolloverPack(pack, params.rolloverTrigger);
}

export function buildRolloverEvidence(input = {}, deps = {}) {
  const params = annotateRolloverInput(input);
  return {
    rolloverTrigger: params.rolloverTrigger,
    ...resolveEvidence(params, deps),
  };
}

export function annotateRolloverInput(input = {}) {
  const params = normalizeInput(input);
  return {
    ...params,
    rolloverTrigger: normalizeRolloverTrigger(params),
  };
}

export function normalizeRolloverTrigger(input = {}) {
  const params = normalizeInput(input);
  const direct = firstDefined(
    params.rolloverTrigger,
    params.trigger,
    params.triggerSource,
    params.rolloverSource,
    params.reason,
  );
  const id = firstString(
    triggerIdFor(direct),
    triggerIdFor(params.kind),
    triggerIdFor(params.type),
    triggerIdFor(params.flow),
    triggerIdFor(params.action),
    triggerIdFor(params.source),
    triggerIdFor(params.warning),
    triggerIdFor(params.attentionItem),
    triggerIdFor(params.session),
    triggerIdFor(params.job),
  ) || "manual";
  return normalizeTriggerId(id);
}

export function resolveAdvisoryHandoff(input = {}, deps = {}) {
  const params = normalizeInput(input);
  const value = firstDefined(
    params.advisoryHandoff,
    params.oldSessionHandoff,
    deps.advisoryHandoff,
    deps.oldSessionHandoff,
  );
  if (value === undefined || value === null) return null;
  return normalizeValue(value);
}

function resolveEvidence(params, deps) {
  const job = resolveJob(params, deps);
  const session = resolveSession(params, deps, job);
  const projectSlug = firstString(params.projectSlug, job?.projectSlug, session?.projectSlug);
  const taskId = firstString(params.taskId, job?.taskId, session?.taskId);
  const fromRev = firstInteger(params.fromRev, params.baseRev, job?.startRev, job?.baseRev);
  return {
    brief: firstDefined(params.brief, callMaybe(deps.brief, { projectSlug, taskId, job, session })),
    why: firstDefined(params.why, callMaybe(deps.why, { projectSlug, taskId, job, session })),
    execute: firstDefined(params.execute, callMaybe(deps.execute, { projectSlug, taskId, job, session })),
    verify: firstDefined(params.verify, job?.verifyPack, callMaybe(deps.verify, { projectSlug, taskId, job, session })),
    changed: firstDefined(params.changed, params.changedSince, callMaybe(deps.changed, { projectSlug, taskId, fromRev, job, session })),
    history: firstDefined(params.history, params.trackerHistory, callMaybe(deps.history, { projectSlug, taskId, job, session })),
    sinceRev: firstDefined(params.sinceRev, params.since, callMaybe(deps.sinceRev, { projectSlug, taskId, fromRev, job, session })),
    runtimeEvents: firstDefined(params.runtimeEvents, runtimeEventsFor({ params, deps, job, session })),
    repoEvents: firstDefined(params.repoEvents, repoEventsFor({ params, deps, job, session, projectSlug })),
    git: firstDefined(params.git, params.gitEvidence, callMaybe(deps.gitEvidence, { projectSlug, taskId, job, session })),
  };
}

function annotateRolloverPack(pack, trigger) {
  const normalizedTrigger = normalizeRolloverTrigger({ rolloverTrigger: trigger });
  const triggerSection = {
    id: "rollover_trigger",
    sourceId: null,
    title: "Rollover trigger",
    value: normalizedTrigger,
  };
  return deepFreeze({
    ...pack,
    rolloverTrigger: normalizedTrigger,
    sections: [triggerSection, ...(Array.isArray(pack?.sections) ? pack.sections : [])],
  });
}

function normalizeTriggerId(id) {
  const source = ROLLOVER_TRIGGER_BY_ID.get(id);
  if (!source) return ROLLOVER_TRIGGER_BY_ID.get("manual");
  return { ...source };
}

function triggerIdFor(value) {
  if (typeof value === "string") return aliasFor(value);
  if (!isRecord(value)) return null;

  if (value.type === "job.rollover_requested") {
    return triggerIdFor(value.source) || "manual";
  }

  const nested = firstString(
    triggerIdFor(value.id),
    triggerIdFor(value.kind),
    triggerIdFor(value.type),
    triggerIdFor(value.source),
    triggerIdFor(value.reason),
  );
  if (nested) return nested;

  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  for (const warning of warnings) {
    const warningId = triggerIdFor(warning);
    if (warningId) return warningId;
  }
  return null;
}

function aliasFor(value) {
  const key = value.trim().toLowerCase();
  return ROLLOVER_TRIGGER_ALIASES[key] || null;
}

function runtimeEventsFor({ deps, job, session }) {
  if (typeof deps.runtimeEventsForJob === "function" && job?.id) {
    return deps.runtimeEventsForJob(job.id);
  }
  if (typeof deps.runtimeEventsForSession === "function" && session?.id) {
    return deps.runtimeEventsForSession(session.id);
  }
  if (deps.runtimeStore && typeof deps.runtimeStore.eventsForJob === "function" && job?.id) {
    return deps.runtimeStore.eventsForJob(job.id);
  }
  if (deps.runtimeStore && typeof deps.runtimeStore.eventsForSession === "function" && session?.id) {
    return deps.runtimeStore.eventsForSession(session.id);
  }
  if (Array.isArray(deps.runtimeEvents)) {
    return deps.runtimeEvents.filter((event) => matchesScope(event, job, session));
  }
  return undefined;
}

function repoEventsFor({ deps, job, session, projectSlug }) {
  if (typeof deps.repoEventsFor === "function" && projectSlug) {
    return deps.repoEventsFor(projectSlug, { job, session });
  }
  if (deps.runtimeStore && typeof deps.runtimeStore.repoEventsFor === "function" && projectSlug) {
    return deps.runtimeStore.repoEventsFor(projectSlug, firstString(job?.startedAt, job?.queuedAt, session?.startedAt));
  }
  if (Array.isArray(deps.repoEvents)) {
    return deps.repoEvents.filter((event) => !projectSlug || event?.projectSlug === projectSlug || event?.slug === projectSlug);
  }
  return undefined;
}

function resolveJob(params, deps) {
  if (isRecord(params.job)) return params.job;
  const jobId = firstString(params.jobId);
  if (!jobId) return null;
  if (deps.jobRegistry && typeof deps.jobRegistry.get === "function") {
    const job = deps.jobRegistry.get(jobId);
    if (isRecord(job)) return job;
  }
  if (deps.projection?.jobs instanceof Map) {
    const job = deps.projection.jobs.get(jobId);
    if (isRecord(job)) return job;
  }
  return { id: jobId };
}

function resolveSession(params, deps, job) {
  if (isRecord(params.session)) return params.session;
  const sessionId = firstString(params.sessionId, job?.sessionId);
  if (!sessionId) return null;
  if (deps.projection?.sessions instanceof Map) {
    const session = deps.projection.sessions.get(sessionId);
    if (isRecord(session)) return session;
  }
  return { id: sessionId };
}

function callMaybe(fn, arg) {
  return typeof fn === "function" ? fn(arg) : undefined;
}

function matchesScope(event, job, session) {
  if (!isRecord(event)) return false;
  if (job?.id && event.jobId === job.id) return true;
  if (session?.id && event.sessionId === session.id) return true;
  return false;
}

function normalizeInput(input) {
  return isRecord(input) ? input : {};
}

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!isRecord(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = normalizeValue(value[key]);
  }
  return out;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) || null;
}

function firstInteger(...values) {
  return values.find(Number.isInteger);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return value;
}
