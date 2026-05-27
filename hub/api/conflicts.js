// hub/api/conflicts.js — SH-7-08 (TDD v0.5 §12.5)
//
// HTTP routes for watcher/git-derived conflict warnings:
//   GET  /api/projects/:slug/session-conflicts
//   GET  /api/sessions/:sessionId/conflicts
//   POST /api/conflicts/:conflictId/ack
//
// The read routes project the current conflict set from RuntimeEvents plus the
// RuntimeProjection snapshot. The ack route records a runtime event only; it
// does not mutate durable tracker truth.

import { detectConflicts } from "../conflicts/detector.js";
import { isSessionId } from "../runtime/ids.js";

const CONFLICT_ID_SHAPE = /^cf_[a-z0-9_]+_[0-9a-f]{12}$/;
const ACK_ALLOWED_FIELDS = new Set(["reason", "actor", "idempotencyKey"]);

/**
 * @typedef {object} RegisterConflictDeps
 * @property {{ get: (slug: string) => ({data?: object}|null), list?: () => object[] }} store
 * @property {{ toSnapshots: () => {sessions?: object[], jobs?: object[]}, rev?: number }} projection
 * @property {() => Promise<object[]> | object[]} getRuntimeEvents
 * @property {{ append: (event: object) => Promise<{ok: true, eventId: string, rev: number, deduped?: true}> }} runtimeStore
 * @property {(event: object) => true} validateRuntimeEvent
 * @property {string} workspace
 */

/**
 * Register conflict routes on an Express app.
 *
 * @param {import("express").Express} app
 * @param {RegisterConflictDeps} deps
 */
export function registerConflictRoutes(app, deps) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new Error("registerConflictRoutes: express app required");
  }
  const { store, projection, getRuntimeEvents, runtimeStore, validateRuntimeEvent, workspace } =
    deps || {};
  if (!store || typeof store.get !== "function") {
    throw new Error("registerConflictRoutes: store (with get) required");
  }
  if (!projection || typeof projection.toSnapshots !== "function") {
    throw new Error("registerConflictRoutes: projection (with toSnapshots) required");
  }
  if (typeof getRuntimeEvents !== "function") {
    throw new Error("registerConflictRoutes: getRuntimeEvents function required");
  }
  if (!runtimeStore || typeof runtimeStore.append !== "function") {
    throw new Error("registerConflictRoutes: runtimeStore (with append) required");
  }
  if (typeof validateRuntimeEvent !== "function") {
    throw new Error("registerConflictRoutes: validateRuntimeEvent function required");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("registerConflictRoutes: workspace string required");
  }

  app.get("/api/projects/:slug/session-conflicts", async (req, res) => {
    const { slug } = req.params;
    if (!isNonEmptyString(slug)) {
      return sendError(res, 400, "INVALID_PROJECT", "project slug required");
    }
    const project = store.get(slug);
    if (!project) {
      return sendError(res, 404, "PROJECT_NOT_FOUND", `project not found: ${slug}`);
    }

    const result = await collectConflictsForProject({
      slug,
      store,
      projection,
      getRuntimeEvents,
    });
    if (result.error) return sendError(res, 500, "CONFLICT_SOURCE_FAILED", result.error);

    return res.status(200).json({
      ok: true,
      projectSlug: slug,
      conflicts: result.conflicts,
      conflictCount: result.conflicts.length,
      rev: Number.isInteger(projection.rev) ? projection.rev : null,
    });
  });

  app.get("/api/sessions/:sessionId/conflicts", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }

    const snapshots = safeSnapshots(projection);
    const session = findSession(snapshots.sessions, sessionId);
    if (!session) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
    }

    const projectSlug = isNonEmptyString(session.projectSlug) ? session.projectSlug : null;
    const result = projectSlug
      ? await collectConflictsForProject({ slug: projectSlug, store, projection, getRuntimeEvents })
      : await collectConflicts({ store, projection, getRuntimeEvents });
    if (result.error) return sendError(res, 500, "CONFLICT_SOURCE_FAILED", result.error);

    const conflicts = result.conflicts.filter((conflict) => conflictMentionsSession(conflict, sessionId));
    return res.status(200).json({
      ok: true,
      sessionId,
      ...(projectSlug ? { projectSlug } : {}),
      conflicts,
      conflictCount: conflicts.length,
      rev: Number.isInteger(projection.rev) ? projection.rev : null,
    });
  });

  app.post("/api/conflicts/:conflictId/ack", async (req, res) => {
    const { conflictId } = req.params;
    if (!isConflictIdShape(conflictId)) {
      return sendError(res, 400, "INVALID_CONFLICT_ID", `not a valid conflict id: ${conflictId}`);
    }
    const body = parseBodyObject(req.body);
    if (body === null) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const unknown = rejectUnknownFields(body, ACK_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }
    const { reason, actor, idempotencyKey } = body;
    if (!isNonEmptyString(reason)) {
      return sendError(res, 400, "INVALID_BODY", "`reason` is required (non-empty string)");
    }
    if (actor !== undefined && !isNonEmptyString(actor)) {
      return sendError(res, 400, "INVALID_BODY", "`actor` must be a non-empty string when present");
    }
    if (idempotencyKey !== undefined && !isNonEmptyString(idempotencyKey)) {
      return sendError(res, 400, "INVALID_BODY", "`idempotencyKey` must be a non-empty string when present");
    }

    const lookup = await collectConflicts({ store, projection, getRuntimeEvents });
    if (lookup.error) return sendError(res, 500, "CONFLICT_SOURCE_FAILED", lookup.error);
    const conflict = lookup.conflicts.find((candidate) => conflictIdFor(candidate) === conflictId);
    if (!conflict) {
      return sendError(res, 404, "CONFLICT_NOT_FOUND", `active conflict not found: ${conflictId}`);
    }

    const now = new Date().toISOString();
    const event = {
      schemaVersion: 1,
      ts: now,
      type: "conflict.ack",
      source: "http",
      workspace,
      conflictId,
      reason,
      acknowledgedAt: now,
      ...(isNonEmptyString(conflict.kind) ? { conflictKind: conflict.kind } : {}),
      ...(isNonEmptyString(conflict.projectSlug) ? { projectSlug: conflict.projectSlug } : {}),
      ...(isNonEmptyString(conflict.taskId) ? { taskId: conflict.taskId } : {}),
      ...(isNonEmptyString(conflict.sessionId) ? { sessionId: conflict.sessionId } : {}),
      ...(actor !== undefined ? { actor } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    try {
      validateRuntimeEvent({ ...event, id: "evt_00000000000000000000000000" });
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
        errors: err.errors,
      });
    }

    let appendResult;
    try {
      appendResult = await runtimeStore.append(event);
    } catch (err) {
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    return res.status(201).json({
      ok: true,
      conflict,
      event: { ...event, id: appendResult.eventId },
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  });
}

async function collectConflictsForProject({ slug, store, projection, getRuntimeEvents }) {
  const result = await collectConflicts({ store, projection, getRuntimeEvents });
  if (result.error) return result;
  return {
    conflicts: result.conflicts.filter((conflict) => conflict.projectSlug === slug),
  };
}

async function collectConflicts({ store, projection, getRuntimeEvents }) {
  let runtimeEvents;
  try {
    runtimeEvents = await getRuntimeEvents();
  } catch (err) {
    return { error: err?.message || "runtime events source failed" };
  }

  const snapshots = safeSnapshots(projection);
  const tasks = collectProjectTasks(store);
  const conflicts = detectConflicts({
    runtimeEvents: Array.isArray(runtimeEvents) ? runtimeEvents : [],
    repoEvents: Array.isArray(runtimeEvents) ? runtimeEvents : [],
    sessions: snapshots.sessions,
    jobs: snapshots.jobs,
    tasks,
  });
  return { conflicts };
}

function safeSnapshots(projection) {
  const snapshots = projection.toSnapshots();
  return {
    sessions: Array.isArray(snapshots?.sessions) ? snapshots.sessions : [],
    jobs: Array.isArray(snapshots?.jobs) ? snapshots.jobs : [],
  };
}

function collectProjectTasks(store) {
  if (!store || typeof store.list !== "function") {
    return [];
  }
  return store.list().flatMap((project) => {
    const entry =
      isNonEmptyString(project?.slug) && typeof store.get === "function"
        ? store.get(project.slug) || project
        : project;
    const tasks = entry?.data?.tasks || entry?.tasks || project?.data?.tasks || project?.tasks;
    return Array.isArray(tasks) ? tasks : [];
  });
}

function findSession(sessions, sessionId) {
  return sessions.find((session) => session && session.id === sessionId) || null;
}

function conflictMentionsSession(conflict, sessionId) {
  if (!conflict || typeof conflict !== "object") return false;
  if (conflict.sessionId === sessionId) return true;
  if (Array.isArray(conflict.sessionIds) && conflict.sessionIds.includes(sessionId)) return true;
  if (Array.isArray(conflict.activeSessionIds) && conflict.activeSessionIds.includes(sessionId)) return true;
  if (Array.isArray(conflict.possibleSessionIds) && conflict.possibleSessionIds.includes(sessionId)) return true;
  return false;
}

function conflictIdFor(conflict) {
  return isNonEmptyString(conflict?.conflictId) ? conflict.conflictId : conflict?.id;
}

function isConflictIdShape(value) {
  return typeof value === "string" && CONFLICT_ID_SHAPE.test(value);
}

function parseBodyObject(raw) {
  if (raw === undefined) return {};
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

function rejectUnknownFields(body, allowed) {
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) unknown.push(key);
  }
  return unknown;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
