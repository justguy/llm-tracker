// hub/api/diffs.js - SH-7A-06
//
// Read-only DiffReview HTTP surface. Diff content is computed on demand from
// tracker history, runtime evidence, and git state; this route does not persist
// hunks or file content.

import { detectConflicts } from "../conflicts/detector.js";
import { buildChangedSincePayload } from "../diffs/changed-since.js";
import {
  annotateDiffAllowedPathWarnings,
  annotateDiffConflictWarnings,
} from "../diffs/diff-review-service.js";
import { annotateProviderFileChanges } from "../diffs/provider-file-changes.js";
import { isSessionId } from "../runtime/ids.js";

/**
 * @typedef {object} RegisterDiffDeps
 * @property {{ get: (slug: string) => ({data?: object, rev?: number}|null), history?: Function, getSince?: Function }} store
 * @property {{ toSnapshots: () => {sessions?: object[], jobs?: object[]}, rev?: number }} projection
 * @property {() => Promise<object[]> | object[]} [getRuntimeEvents]
 * @property {() => Promise<object[]> | object[]} [getProviderEvents]
 * @property {() => Promise<object[]> | object[]} [getProviderTimelineItems]
 * @property {(args: string[], options?: object) => Promise<object>} [runGit]
 */

/**
 * Register GET /api/sessions/:sessionId/diff.
 *
 * @param {import("express").Express} app
 * @param {RegisterDiffDeps} deps
 */
export function registerDiffRoutes(app, deps) {
  if (!app || typeof app.get !== "function") {
    throw new Error("registerDiffRoutes: express app required");
  }
  const {
    store,
    projection,
    getRuntimeEvents = () => [],
    getProviderEvents = () => [],
    getProviderTimelineItems = () => [],
    runGit,
  } = deps || {};
  if (!store || typeof store.get !== "function") {
    throw new Error("registerDiffRoutes: store (with get) required");
  }
  if (!projection || typeof projection.toSnapshots !== "function") {
    throw new Error("registerDiffRoutes: projection (with toSnapshots) required");
  }

  app.get("/api/sessions/:sessionId/diff", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }

    const snapshots = safeSnapshots(projection);
    const session = findById(snapshots.sessions, sessionId);
    if (!session) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
    }

    const projectSlug = firstString(session.projectSlug);
    if (!projectSlug) {
      return sendError(res, 409, "SESSION_PROJECT_MISSING", "session is not bound to a project");
    }
    const project = store.get(projectSlug);
    if (!project) {
      return sendError(res, 404, "PROJECT_NOT_FOUND", `project not found: ${projectSlug}`);
    }

    const query = parseDiffQuery(req.query || {});
    if (query.error) {
      return sendError(res, 400, "INVALID_QUERY", query.error);
    }

    const job = findDiffJob(snapshots.jobs, session);
    const taskId = firstString(session.taskId, job?.taskId);
    const task = findTask(project.data, taskId);
    const baseRev = firstInteger(
      query.value.baseRev,
      job?.startRev,
      job?.baseRev,
      job?.verifyPack?.stampedFromRev,
      session.startRev,
      session.baseRev,
      project.rev,
    );
    if (!Number.isInteger(baseRev)) {
      return sendError(res, 409, "BASE_REV_MISSING", "session diff requires a base tracker revision");
    }

    let runtimeEvents;
    let providerEvents;
    let providerTimelineItems;
    try {
      runtimeEvents = await getRuntimeEvents();
      providerEvents = await getProviderEvents();
      providerTimelineItems = await getProviderTimelineItems();
    } catch (err) {
      return sendError(res, 500, "DIFF_SOURCE_FAILED", err?.message || "diff evidence source failed");
    }

    let changedSince;
    try {
      changedSince = await buildChangedSincePayload({
        slug: projectSlug,
        fromRev: baseRev,
        store,
        data: project.data,
        history: projectHistory(store, projectSlug),
        session,
        job: query.value.baseRev === undefined ? job : null,
        repoRoot: firstString(session.worktreePath, session.repoRoot, session.cwd, job?.worktreePath, job?.repoRoot, job?.cwd),
        includePatch: true,
        ...(typeof runGit === "function" ? { runGit } : {}),
      });
    } catch (err) {
      return sendError(res, 500, "DIFF_BUILD_FAILED", err?.message || "diff build failed");
    }

    const provider = annotateProviderFileChanges(changedSince.git?.files || [], {
      providerEvents: filterProviderRowsForSession(providerEvents, sessionId),
      providerTimelineItems: filterProviderRowsForSession(providerTimelineItems, sessionId),
    });
    const allowed = annotateDiffAllowedPathWarnings(provider.files, {
      task,
      repoRoot: changedSince.git?.repoRoot || null,
    });
    const conflicts = detectConflicts({
      projectSlug,
      repoEvents: arrayOrEmpty(runtimeEvents),
      sessions: snapshots.sessions,
      jobs: snapshots.jobs,
      tasks: Array.isArray(project.data?.tasks) ? project.data.tasks : [],
    }).filter((conflict) => conflictBelongsToSessionOrProject(conflict, session, projectSlug));
    const conflictAnnotated = annotateDiffConflictWarnings(allowed.files, conflicts, {
      repoRoot: changedSince.git?.repoRoot || null,
    });

    const watcherEvidence = watcherEvidenceRefs(runtimeEvents, { session, projectSlug });
    const allowedPathWarningDetails = collectFileDetails(
      conflictAnnotated.files,
      "allowedPathWarningDetails",
    );
    const diffReview = {
      id: diffReviewId(sessionId, baseRev),
      projectSlug,
      ...(taskId ? { taskId } : {}),
      ...(job?.id ? { jobId: job.id } : {}),
      sessionId,
      baseRev,
      baseTrackerRev: baseRev,
      currentRev: changedSince.currentRev,
      baseGitSha: changedSince.base?.baseGitSha || changedSince.git?.baseGitSha || null,
      headGitSha: changedSince.base?.headGitSha || changedSince.git?.headGitSha || null,
      status: "open",
      evidenceRefs: uniqueStrings([
        ...watcherEvidence,
        ...provider.providerItems.map((item) => item.evidenceRef),
        ...conflictAnnotated.conflictDetails.map((conflict) => conflict.evidenceRef),
      ]),
      generatedAt: changedSince.generatedAt,
      files: conflictAnnotated.files,
      providerItems: provider.providerItems,
      unmatchedProviderItems: provider.unmatchedProviderItems,
      watcherEvidence,
      allowedPathWarnings: allowed.allowedPathWarnings,
      allowedPathWarningDetails,
      conflictIds: conflictAnnotated.conflictIds,
      conflictDetails: conflictAnnotated.conflictDetails,
      tabs: {
        changedSince: changedSince.tracker,
        providerProposals: {
          items: provider.providerItems,
          unmatchedItems: provider.unmatchedProviderItems,
        },
        gitDiff: changedSince.git,
        allowedPaths: {
          warnings: allowed.allowedPathWarnings,
          details: allowedPathWarningDetails,
        },
        conflicts: {
          conflictIds: conflictAnnotated.conflictIds,
          details: conflictAnnotated.conflictDetails,
        },
        reviewerNotes: {
          status: "open",
          notes: [],
        },
      },
    };

    return res.status(200).json({
      ok: true,
      sessionId,
      projectSlug,
      ...(taskId ? { taskId } : {}),
      ...(job?.id ? { jobId: job.id } : {}),
      rev: Number.isInteger(projection.rev) ? projection.rev : null,
      diffReview,
    });
  });
}

export function providerEventsFromRuntimeEvents(events) {
  return arrayOrEmpty(events).flatMap((event) => [
    ...arrayOrEmpty(event?.providerEvents),
    ...arrayOrEmpty(event?.provider?.events),
    ...(event?.providerEvent && typeof event.providerEvent === "object" ? [event.providerEvent] : []),
  ]);
}

export function providerTimelineItemsFromRuntimeEvents(events) {
  return arrayOrEmpty(events).flatMap((event) => [
    ...arrayOrEmpty(event?.providerTimelineItems),
    ...arrayOrEmpty(event?.provider?.timelineItems),
    ...arrayOrEmpty(event?.timelineItems).filter(isProviderTimelineItem),
  ]);
}

function parseDiffQuery(query) {
  const baseRevRaw = firstQueryValue(query.baseRev);
  if (baseRevRaw === undefined) return { value: {} };
  const baseRev = Number(baseRevRaw);
  if (!Number.isInteger(baseRev) || baseRev < 0) {
    return { error: "`baseRev` must be a non-negative integer" };
  }
  return { value: { baseRev } };
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function safeSnapshots(projection) {
  try {
    const snapshots = projection.toSnapshots();
    return {
      sessions: arrayOrEmpty(snapshots?.sessions),
      jobs: arrayOrEmpty(snapshots?.jobs),
    };
  } catch {
    return { sessions: [], jobs: [] };
  }
}

function findDiffJob(jobs, session) {
  const activeJobId = firstString(session.activeJobId);
  if (activeJobId) {
    const active = findById(jobs, activeJobId);
    if (active) return active;
  }
  const sessionJobs = arrayOrEmpty(jobs).filter((job) => job?.sessionId === session.id);
  return sessionJobs[sessionJobs.length - 1] || null;
}

function findTask(data, taskId) {
  if (!taskId || !Array.isArray(data?.tasks)) return null;
  return data.tasks.find((task) => task?.id === taskId) || null;
}

function projectHistory(store, slug) {
  if (!store || typeof store.history !== "function") return [];
  const result = store.history(slug, { fromRev: 0, limit: 10000 });
  return arrayOrEmpty(result?.events);
}

function filterProviderRowsForSession(rows, sessionId) {
  return arrayOrEmpty(rows).filter((row) => {
    const rowSessionId = providerRowSessionId(row);
    return !rowSessionId || rowSessionId === sessionId;
  });
}

function providerRowSessionId(row) {
  if (!row || typeof row !== "object") return null;
  return firstString(row.sessionId, row.data?.sessionId);
}

function isProviderTimelineItem(item) {
  return (
    item &&
    typeof item === "object" &&
    isNonEmptyString(item.providerId) &&
    isNonEmptyString(item.kind)
  );
}

function watcherEvidenceRefs(events, { session, projectSlug }) {
  return uniqueStrings(
    arrayOrEmpty(events)
      .filter((event) => isWatcherEventForDiff(event, { session, projectSlug }))
      .map((event) => event.id)
      .filter(isNonEmptyString),
  );
}

function isWatcherEventForDiff(event, { session, projectSlug }) {
  if (!event || typeof event !== "object") return false;
  if (event.type !== "repo.change" && event.type !== "repo.burst") return false;
  if (event.projectSlug && event.projectSlug !== projectSlug) return false;
  const sessionIds = [
    ...arrayOrEmpty(event.activeSessionIds),
    ...arrayOrEmpty(event.possibleSessionIds),
    event.sessionId,
  ].filter(isNonEmptyString);
  return sessionIds.length === 0 || sessionIds.includes(session.id);
}

function conflictBelongsToSessionOrProject(conflict, session, projectSlug) {
  if (!conflict || typeof conflict !== "object") return false;
  if (conflict.projectSlug && conflict.projectSlug !== projectSlug) return false;
  const sessionIds = [
    ...arrayOrEmpty(conflict.sessionIds),
    ...arrayOrEmpty(conflict.activeSessionIds),
    conflict.sessionId,
  ].filter(isNonEmptyString);
  return sessionIds.length === 0 || sessionIds.includes(session.id);
}

function collectFileDetails(files, key) {
  const details = [];
  const seen = new Set();
  for (const file of arrayOrEmpty(files)) {
    for (const detail of arrayOrEmpty(file?.[key])) {
      const id = firstString(detail.id, detail.conflictId, detail.path);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      details.push(detail);
    }
  }
  return details;
}

function findById(values, id) {
  return arrayOrEmpty(values).find((value) => value?.id === id) || null;
}

function diffReviewId(sessionId, baseRev) {
  return `diff:${sessionId}:${baseRev}`;
}

function sendError(res, status, code, message, details) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

function uniqueStrings(values) {
  return Array.from(new Set(arrayOrEmpty(values).filter(isNonEmptyString)));
}

function firstInteger(...values) {
  return values.find(Number.isInteger);
}

function firstString(...values) {
  return values.find(isNonEmptyString) || null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
