// hub/api/sessions.js — sh-1-09 (TDD v0.5 §6.1, §6.6, §6.10)
//
// Basic CRUD HTTP routes for runtime sessions. All mutations route through
// `RuntimeStore.append` — handlers NEVER touch `RuntimeProjection.sessions`
// directly. The store's onAppend hook (wired by the integration in sh-1-10 +
// the test fixture) drives projection updates.
//
// Routes:
//   GET   /api/sessions          — list SessionRecord[] + projection rev
//   POST  /api/sessions          — create session via session.started event
//   GET   /api/sessions/:id      — fetch single session by id
//   PATCH /api/sessions/:id      — emit session.status event (status update)
//
// Error envelope: `{ error: { code, message, details? } }`.

import { log } from "../logging/index.js";

// Allowed body fields on POST. Anything else triggers UNKNOWN_FIELDS (400).
const POST_ALLOWED_FIELDS = new Set([
  "name",
  "tier",
  "projectSlug",
  "taskId",
  "agent",
  "provider",
  "model",
  "cwd",
  "repoRoot",
  "branch",
]);

// Allowed body fields on PATCH. Anything else triggers UNKNOWN_FIELDS (400).
const PATCH_ALLOWED_FIELDS = new Set(["status", "comment"]);

// TDD §6.1 ActivityState enum (mirrors schema SessionStatusEvent.status).
const ACTIVITY_STATES = new Set([
  "starting",
  "active",
  "quiet",
  "idle",
  "waiting_for_human",
  "waiting_for_approval",
  "blocked",
  "context_high",
  "done",
  "stopping",
  "stopped",
  "resuming",
  "rolled_over",
  "archived",
  "unknown",
]);

// TDD §6.1 session tier enum.
const SESSION_TIERS = new Set([
  "dumb_terminal",
  "mcp_tracked",
  "codex_app_server",
  "hybrid",
  "manual",
]);

// Optional string fields that may be passed through on POST. Each must be a
// non-empty string when present.
const POST_OPTIONAL_STRING_FIELDS = [
  "projectSlug",
  "taskId",
  "agent",
  "provider",
  "model",
  "cwd",
  "repoRoot",
  "branch",
];

/**
 * @typedef {object} RegisterDeps
 * @property {import("../runtime/store.js").RuntimeStore} runtimeStore
 * @property {import("../runtime/projection.js").RuntimeProjection} projection
 * @property {(prefix: string) => string} makeRuntimeId
 * @property {(event: object) => true} validateRuntimeEvent
 * @property {string} workspace
 */

/**
 * Register the four /api/sessions routes onto an Express app.
 *
 * @param {import("express").Express} app
 * @param {RegisterDeps} deps
 */
export function registerSessionsRoutes(app, deps) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new Error("registerSessionsRoutes: express app required");
  }
  const { runtimeStore, projection, makeRuntimeId, validateRuntimeEvent, workspace } = deps || {};
  if (!runtimeStore || typeof runtimeStore.append !== "function") {
    throw new Error("registerSessionsRoutes: runtimeStore (with append) required");
  }
  if (!projection || typeof projection.toSnapshots !== "function") {
    throw new Error("registerSessionsRoutes: projection (with toSnapshots) required");
  }
  if (typeof makeRuntimeId !== "function") {
    throw new Error("registerSessionsRoutes: makeRuntimeId function required");
  }
  if (typeof validateRuntimeEvent !== "function") {
    throw new Error("registerSessionsRoutes: validateRuntimeEvent function required");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("registerSessionsRoutes: workspace string required");
  }

  // --- GET /api/sessions --------------------------------------------------
  app.get("/api/sessions", (_req, res) => {
    const snap = projection.toSnapshots();
    res.status(200).json({ sessions: snap.sessions, rev: projection.rev });
  });

  // --- GET /api/sessions/:id ----------------------------------------------
  app.get("/api/sessions/:id", (req, res) => {
    const { id } = req.params;
    if (!isSessionIdShape(id)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${id}`);
    }
    const session = projection.sessions.get(id);
    if (!session) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${id}`);
    }
    res.status(200).json({ session, rev: projection.rev });
  });

  // --- POST /api/sessions -------------------------------------------------
  app.post("/api/sessions", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }

    // Reject client-supplied id outright — the hub assigns ses_ ids.
    if ("id" in body) {
      log.audit({
        source: "http",
        action: "runtime.session.client_id_rejected",
        subject: "session:create",
      });
      return sendError(res, 400, "INVALID_BODY", "client-supplied `id` is not allowed; the hub assigns session IDs");
    }

    // Reject unknown fields before doing any other validation work.
    const unknown = [];
    for (const key of Object.keys(body)) {
      if (!POST_ALLOWED_FIELDS.has(key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }

    const { name, tier } = body;
    if (typeof name !== "string" || name.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`name` is required (non-empty string)");
    }
    if (typeof tier !== "string" || tier.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`tier` is required (non-empty string)");
    }
    if (!SESSION_TIERS.has(tier)) {
      return sendError(
        res,
        400,
        "INVALID_BODY",
        `\`tier\` must be one of: ${[...SESSION_TIERS].join(", ")}`,
        { allowed: [...SESSION_TIERS] },
      );
    }

    // Validate optional string fields when present.
    for (const field of POST_OPTIONAL_STRING_FIELDS) {
      if (field in body && (typeof body[field] !== "string" || body[field].length === 0)) {
        return sendError(res, 400, "INVALID_BODY", `\`${field}\` must be a non-empty string when present`);
      }
    }

    const sessionId = makeRuntimeId("ses");
    const sessionPayload = {
      id: sessionId,
      name,
      tier,
    };
    for (const field of POST_OPTIONAL_STRING_FIELDS) {
      if (field in body) sessionPayload[field] = body[field];
    }

    // Build the event with a placeholder id for schema validation. The store
    // assigns the canonical evt_ id during append (it rejects client-supplied
    // ids unless allowClientIds=true), so we strip our placeholder before
    // handing the event off. This keeps the schema check sharp without
    // colliding with the store's id ownership.
    const eventForValidation = {
      schemaVersion: 1,
      id: makeRuntimeId("evt"),
      ts: new Date().toISOString(),
      type: "session.started",
      source: "http",
      workspace,
      session: sessionPayload,
    };

    try {
      validateRuntimeEvent(eventForValidation);
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
        errors: err.errors,
      });
    }

    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;

    let appendResult;
    try {
      appendResult = await runtimeStore.append(eventForAppend);
    } catch (err) {
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    // Prefer the projection's record (which carries computed fields like
    // status/statusSource/startedAt); fall back to the event payload if the
    // store wasn't wired with an onAppend that applies events to projection.
    const session = projection.sessions.get(sessionId) || { ...sessionPayload };

    res.status(201).json({
      session,
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  });

  // --- PATCH /api/sessions/:id --------------------------------------------
  app.patch("/api/sessions/:id", async (req, res) => {
    const { id: sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }

    const unknown = [];
    for (const key of Object.keys(body)) {
      if (!PATCH_ALLOWED_FIELDS.has(key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }

    const { status, comment } = body;
    if (status === undefined) {
      return sendError(res, 400, "INVALID_BODY", "`status` is required (PATCH currently only supports status updates)");
    }
    if (typeof status !== "string" || !ACTIVITY_STATES.has(status)) {
      return sendError(
        res,
        400,
        "INVALID_BODY",
        `\`status\` must be one of: ${[...ACTIVITY_STATES].join(", ")}`,
        { allowed: [...ACTIVITY_STATES] },
      );
    }
    if (comment !== undefined && (typeof comment !== "string" || comment.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`comment` must be a non-empty string when present");
    }

    // 404 if the session doesn't exist in the projection. We check this
    // BEFORE appending so we don't write an event for an unknown sessionId.
    if (!projection.sessions.get(sessionId)) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
    }

    // Placeholder id for schema validation only — stripped before append so
    // the store can assign its own canonical evt_ id (see POST handler comment
    // above for the same dance).
    const eventForValidation = {
      schemaVersion: 1,
      id: makeRuntimeId("evt"),
      ts: new Date().toISOString(),
      type: "session.status",
      source: "http",
      workspace,
      sessionId,
      status,
      ...(comment ? { comment } : {}),
    };

    try {
      validateRuntimeEvent(eventForValidation);
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
        errors: err.errors,
      });
    }

    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;

    let appendResult;
    try {
      appendResult = await runtimeStore.append(eventForAppend);
    } catch (err) {
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    const session = projection.sessions.get(sessionId) || { id: sessionId, status };
    res.status(200).json({
      session,
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  });
}

// Inlined to avoid importing SESSION_ID_RE from the runtime layer twice and
// to keep this module self-contained for the file-allowlist constraint
// (hub/api/sessions.js is the only allowed implementation path for sh-1-09).
const SESSION_ID_SHAPE = /^ses_[0-9a-hjkmnp-tv-z]{26}$/;
function isSessionIdShape(value) {
  return typeof value === "string" && SESSION_ID_SHAPE.test(value);
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
