import { CONTEXT_PACK_KINDS, DETERMINISTIC_SOURCES, isContextPackKind } from "../service.js";

const SOURCE_BY_ID = new Map(DETERMINISTIC_SOURCES.map((source) => [source.id, source]));

export const PACK_SOURCE = "deterministic";

export function composePack(kind, params = {}, deps = {}, config = {}) {
  if (!isContextPackKind(kind)) {
    throw composerError(`composePack: unsupported kind '${kind}'`, "INVALID_KIND", {
      allowed: [...CONTEXT_PACK_KINDS],
    });
  }
  const normalizedParams = normalizeParams(params);
  const normalizedDeps = deps && typeof deps === "object" ? deps : {};
  const job = resolveJob(normalizedParams, normalizedDeps);
  const session = resolveSession(normalizedParams, normalizedDeps, job);
  const generatedAt = resolveGeneratedAt(normalizedParams, normalizedDeps);
  const sourceIds = Array.isArray(config.sourceIds) ? config.sourceIds : [];
  const sections =
    typeof config.sections === "function"
      ? config.sections({
          params: normalizedParams,
          deps: normalizedDeps,
          job,
          session,
          generatedAt,
        })
      : [];

  return deepFreeze(
    omitUndefined({
      kind,
      source: PACK_SOURCE,
      generatedAt,
      jobId: firstString(job?.id, normalizedParams.jobId),
      sessionId: firstString(session?.id, job?.sessionId, normalizedParams.sessionId),
      projectSlug: firstString(job?.projectSlug, session?.projectSlug, normalizedParams.projectSlug),
      taskId: firstString(job?.taskId, session?.taskId, normalizedParams.taskId),
      workspace: firstString(normalizedDeps.workspace, normalizedParams.workspace),
      sources: buildSources(sourceIds, normalizedParams, normalizedDeps),
      sections: normalizeSections(sections),
    }),
  );
}

export function trackerSection(id, sourceId, title, value) {
  return section(id, sourceId, title, value);
}

export function section(id, sourceId, title, value) {
  return omitUndefined({
    id,
    sourceId,
    title,
    value: value === undefined ? null : normalizeValue(value),
  });
}

export function jobSection(job, session) {
  return section("job", null, "Job", {
    job,
    session,
  });
}

export function completionSection(job) {
  return section("completion_gates", null, "Completion gates", {
    completionGates: Array.isArray(job?.completionGates) ? job.completionGates : [],
    humanApprovalRequests: Array.isArray(job?.humanApprovalRequests)
      ? job.humanApprovalRequests
      : [],
  });
}

export function skillPlanSection(job) {
  return section("skill_plan", null, "Skill plan", Array.isArray(job?.skillPlan) ? job.skillPlan : []);
}

export function advisoryHandoffSection(params) {
  const advisoryHandoff = firstDefined(params.advisoryHandoff, params.handoff);
  if (advisoryHandoff === undefined) return null;
  return section("advisory_handoff", "tracker.handoff", "Advisory handoff", {
    advisoryHandoff,
    advisoryHandoffLabel: "old-session claim; verify against tracker/git evidence",
  });
}

export function runtimeEvents(params, deps, job, session) {
  if (params.runtimeEvents !== undefined) return params.runtimeEvents;
  if (deps.runtimeStore && typeof deps.runtimeStore.eventsForJob === "function" && job?.id) {
    return deps.runtimeStore.eventsForJob(job.id);
  }
  if (deps.runtimeStore && typeof deps.runtimeStore.eventsForSession === "function" && session?.id) {
    return deps.runtimeStore.eventsForSession(session.id);
  }
  if (Array.isArray(deps.runtimeEvents)) {
    return deps.runtimeEvents.filter((event) => eventMatches(event, job, session));
  }
  return [];
}

export function repoEvents(params, deps, job, session) {
  if (params.repoEvents !== undefined) return params.repoEvents;
  if (deps.runtimeStore && typeof deps.runtimeStore.repoEventsFor === "function") {
    const projectSlug = firstString(job?.projectSlug, session?.projectSlug, params.projectSlug);
    const since = firstString(job?.startedAt, job?.queuedAt, session?.startedAt);
    if (projectSlug) return deps.runtimeStore.repoEventsFor(projectSlug, since);
  }
  if (Array.isArray(deps.repoEvents)) {
    const projectSlug = firstString(job?.projectSlug, session?.projectSlug, params.projectSlug);
    return deps.repoEvents.filter(
      (event) => !projectSlug || event?.projectSlug === projectSlug || event?.slug === projectSlug,
    );
  }
  return [];
}

export function changedPayload(params) {
  return firstDefined(params.changed, params.changedSince, params.changed_since);
}

export function historyPayload(params) {
  return firstDefined(params.history, params.trackerHistory);
}

export function sinceRevPayload(params) {
  return firstDefined(params.sinceRev, params.since, params.since_rev);
}

export function snapshotsHistoryPayload(params) {
  return firstDefined(params.snapshotsHistory, params.snapshotHistory);
}

export function gitEvidencePayload(params) {
  return firstDefined(params.git, params.gitEvidence);
}

export function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function composerError(message, code, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function normalizeParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  return params;
}

function resolveGeneratedAt(params, deps) {
  if (typeof params.generatedAt === "string" && params.generatedAt.length > 0) return params.generatedAt;
  if (typeof params.now === "function") return params.now();
  if (typeof deps.now === "function") return deps.now();
  return new Date(0).toISOString();
}

function resolveJob(params, deps) {
  if (params.job && typeof params.job === "object" && !Array.isArray(params.job)) return params.job;
  const jobId = firstString(params.jobId, params.draft?.jobId);
  if (!jobId) return null;
  if (deps.jobRegistry && typeof deps.jobRegistry.get === "function") {
    const job = deps.jobRegistry.get(jobId);
    if (job && typeof job === "object") return job;
  }
  if (deps.projection?.jobs instanceof Map) {
    const job = deps.projection.jobs.get(jobId);
    if (job && typeof job === "object") return job;
  }
  return { id: jobId };
}

function resolveSession(params, deps, job) {
  if (params.session && typeof params.session === "object" && !Array.isArray(params.session)) return params.session;
  const sessionId = firstString(params.sessionId, params.draft?.sessionId, job?.sessionId);
  if (!sessionId) return null;
  if (deps.projection?.sessions instanceof Map) {
    const session = deps.projection.sessions.get(sessionId);
    if (session && typeof session === "object") return session;
  }
  return { id: sessionId };
}

function buildSources(sourceIds, params, deps) {
  return sourceIds.map((id) => {
    const source = SOURCE_BY_ID.get(id);
    if (!source) {
      throw composerError(`composePack: unknown deterministic source '${id}'`, "INVALID_SOURCE", { sourceId: id });
    }
    return {
      ...source,
      status: sourceStatus(id, params, deps),
    };
  });
}

function sourceStatus(sourceId, params, deps = {}) {
  const keys = {
    "tracker.brief": ["brief"],
    "tracker.why": ["why"],
    "tracker.execute": ["execute"],
    "tracker.verify": ["verify"],
    "tracker.handoff": ["handoff", "advisoryHandoff"],
    "tracker.changed": ["changed", "changedSince", "changed_since"],
    "tracker.history": ["history", "trackerHistory"],
    "tracker.since_rev": ["since", "sinceRev", "since_rev"],
    "snapshots.history": ["snapshotsHistory", "snapshotHistory"],
    "runtime.events": ["runtimeEvents"],
    "repo.watcher": ["repoEvents"],
    "git.evidence": ["git", "gitEvidence"],
  }[sourceId];
  if (!keys) return "declared";
  if (sourceId === "runtime.events" && (
    Array.isArray(deps.runtimeEvents) ||
    typeof deps.runtimeStore?.eventsForJob === "function" ||
    typeof deps.runtimeStore?.eventsForSession === "function"
  )) {
    return "provided";
  }
  if (sourceId === "repo.watcher" && (
    Array.isArray(deps.repoEvents) ||
    typeof deps.runtimeStore?.repoEventsFor === "function"
  )) {
    return "provided";
  }
  return keys.some((key) => params[key] !== undefined) ? "provided" : "available_on_demand";
}

function normalizeSections(sections) {
  return (Array.isArray(sections) ? sections : []).filter(Boolean).map((item) => normalizeValue(item));
}

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (!value || typeof value !== "object") return value;
  if (value instanceof Map) return normalizeValue(Object.fromEntries(value));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = normalizeValue(value[key]);
  }
  return out;
}

function omitUndefined(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

function eventMatches(event, job, session) {
  if (!event || typeof event !== "object") return false;
  if (job?.id && event.jobId === job.id) return true;
  if (session?.id && event.sessionId === session.id) return true;
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return value;
}
