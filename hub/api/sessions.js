// hub/api/sessions.js — sh-1-09 (TDD v0.5 §6.1, §6.6, §6.10)
//                       + SH-2-07 (TDD v0.5 §19.2 token rotation)
//                       + SH-2-23 (TDD v0.5 §19.3 stdio capture toggle)
//
// Basic CRUD HTTP routes for runtime sessions. All mutations route through
// `RuntimeStore.append` — handlers NEVER touch `RuntimeProjection.sessions`
// directly. The store's onAppend hook (wired by the integration in sh-1-10 +
// the test fixture) drives projection updates.
//
// Routes:
//   GET   /api/sessions                              — list SessionRecord[] + projection rev
//   POST  /api/sessions                              — create session via session.started event
//   GET   /api/sessions/:id                          — fetch single session by id
//   GET   /api/sessions/:sessionId/task-ledger       — derived SessionTaskLedgerItem[]
//   PATCH /api/sessions/:id                          — emit session.status event (status update)
//   POST  /api/sessions/:sessionId/token/rotate      — rotate session token (gated on tokenStore dep)
//   POST  /api/sessions/:sessionId/stdio/capture     — toggle stdio disk capture (gated on tokenStore dep)
//
// Error envelope: `{ error: { code, message, details? } }`.

import { log } from "../logging/index.js";
import { requireSessionToken } from "./middleware/session-token.js";
import { createSessionAskEvent, createSessionStdioCaptureChangedEvent, createSessionWarningEvent } from "../runtime/events.js";
import { SessionTaskLedgerService } from "../sessions/task-ledger.js";
import { DEFAULT_THRESHOLDS } from "../sessions/activity.js";
import { contextHighWarning } from "../sessions/warnings.js";
import { buildAttachTaskPreflight } from "../run-session/attach-preflight.js";

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
  "worktreePath",
  "branch",
]);

// Allowed body fields on PATCH. Anything else triggers UNKNOWN_FIELDS (400).
const PATCH_ALLOWED_FIELDS = new Set(["status", "comment", "contextUsage"]);

// Allowed body fields on POST /:sessionId/ask.
const ASK_ALLOWED_FIELDS = new Set(["targetSessionId", "prompt", "idempotencyKey"]);

// Allowed body fields on POST /:sessionId/token/rotate. Both are optional —
// an empty body `{}` means "use the caller's current capabilities and the
// default lifetime". Anything else triggers UNKNOWN_FIELDS (400).
const ROTATE_ALLOWED_FIELDS = new Set(["capabilities", "lifetimeMinutes"]);

// Allowed body fields on POST /:sessionId/stdio/capture. `captureToDisk` is
// required (boolean); `reason` optional (non-empty string when present).
const STDIO_CAPTURE_ALLOWED_FIELDS = new Set(["captureToDisk", "reason"]);

const ATTACH_PREVIEW_ALLOWED_FIELDS = new Set([
  "taskId",
  "projectSlug",
  "profileId",
  "estBriefTokens",
  "contextBriefTokens",
  "contextBudget",
]);

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
  "worktreePath",
  "branch",
];

/**
 * @typedef {object} RegisterDeps
 * @property {import("../runtime/store.js").RuntimeStore} runtimeStore
 * @property {import("../runtime/projection.js").RuntimeProjection} projection
 * @property {(prefix: string) => string} makeRuntimeId
 * @property {(event: object) => true} validateRuntimeEvent
 * @property {string} workspace
 * @property {import("../sessions/auth/tokens.js").SessionTokenStore} [tokenStore]
 *   When provided, mounts POST /api/sessions/:sessionId/token/rotate (SH-2-07).
 *   When omitted, the rotation route is not registered — existing routes work
 *   unchanged so older test fixtures don't have to wire token plumbing.
 * @property {{ get(sessionId: string): object[] | null }} [taskLedgerService]
 * @property {{ list(): object[] }} [jobRegistry]
 * @property {{ get(slug: string): object | null }} [store]
 * @property {{ contextHighPercent?: number }} [activityThresholds]
 * @property {{ contextOverflowWarnPercent?: number }} [attach]
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
  const {
    runtimeStore,
    projection,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace,
    tokenStore,
    taskLedgerService,
    jobRegistry,
    store,
    activityThresholds,
    attach,
  } = deps || {};
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
  const tokenMiddleware =
    tokenStore && typeof tokenStore.issue === "function" && typeof tokenStore.revoke === "function"
      ? requireSessionToken({
          tokenStore,
          runtimeStore,
          makeRuntimeId,
          validateRuntimeEvent,
          workspace,
      })
      : null;
  const ledgerService = taskLedgerService || new SessionTaskLedgerService({
    projection,
    jobRegistry,
    store,
  });

  // --- GET /api/sessions --------------------------------------------------
  app.get("/api/sessions", (_req, res) => {
    const snap = projection.toSnapshots();
    res.status(200).json({ sessions: snap.sessions, rev: projection.rev });
  });

  // --- GET /api/sessions/:sessionId/task-ledger ---------------------------
  app.get("/api/sessions/:sessionId/task-ledger", (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    if (!projection.sessions.get(sessionId)) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
    }
    let taskLedger;
    try {
      taskLedger = ledgerService.get(sessionId);
    } catch (err) {
      return sendError(res, 500, "TASK_LEDGER_FAILED", err.message || "task ledger projection failed");
    }
    res.status(200).json({
      sessionId,
      taskLedger: Array.isArray(taskLedger) ? taskLedger : [],
      rev: projection.rev,
    });
  });

  // --- POST /api/sessions/:sessionId/attach-task/preview ---------------------
  app.post("/api/sessions/:sessionId/attach-task/preview", (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }

    const unknown = [];
    for (const key of Object.keys(body)) {
      if (!ATTACH_PREVIEW_ALLOWED_FIELDS.has(key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }

    const { taskId, profileId, estBriefTokens, contextBriefTokens, contextBudget } = body;
    if (typeof taskId !== "string" || taskId.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`taskId` is required (non-empty string)");
    }
    if ("projectSlug" in body && (typeof body.projectSlug !== "string" || body.projectSlug.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`projectSlug` must be a non-empty string when present");
    }
    if (profileId !== undefined && (typeof profileId !== "string" || profileId.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`profileId` must be a non-empty string when present");
    }
    for (const [field, value] of Object.entries({ estBriefTokens, contextBriefTokens })) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        return sendError(res, 400, "INVALID_BODY", `\`${field}\` must be a non-negative number when present`);
      }
    }
    if (contextBudget !== undefined && (!contextBudget || typeof contextBudget !== "object" || Array.isArray(contextBudget))) {
      return sendError(res, 400, "INVALID_BODY", "`contextBudget` must be a JSON object when present");
    }

    const session = projection.sessions.get(sessionId) || null;
    const projectSlug = body.projectSlug || session?.projectSlug || "";
    const project =
      projectSlug && store && typeof store.get === "function"
        ? store.get(projectSlug)
        : null;
    const tasks = Array.isArray(project?.data?.tasks) ? project.data.tasks : [];
    const task = tasks.find((item) => item && item.id === taskId) || null;

    const snapshots = projection.toSnapshots();
    const sessions = snapshots.sessions || [];
    const jobs =
      jobRegistry && typeof jobRegistry.list === "function"
        ? jobRegistry.list()
        : snapshots.jobs || [];

    let preview;
    try {
      preview = buildAttachTaskPreflight({
        sessionId,
        projectSlug,
        taskId,
        session,
        task,
        sessions,
        jobs,
        profileId,
        estBriefTokens,
        contextBriefTokens,
        contextBudget,
        config: { attach },
      });
    } catch (err) {
      return sendError(res, 500, "ATTACH_PREFLIGHT_FAILED", err.message || "attach preflight failed");
    }
    res.status(200).json(preview);
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

  // --- POST /api/sessions/:sessionId/ask ----------------------------------
  const postSessionAsk = async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }

    const unknown = [];
    for (const key of Object.keys(body)) {
      if (!ASK_ALLOWED_FIELDS.has(key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }

    const { targetSessionId, prompt, idempotencyKey } = body;
    if (!projection.sessions.get(sessionId)) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
    }
    if (!isSessionIdShape(targetSessionId)) {
      return sendError(res, 400, "INVALID_BODY", "`targetSessionId` must be a canonical ses_ session id");
    }
    if (!projection.sessions.get(targetSessionId)) {
      return sendError(res, 404, "UNKNOWN_TARGET_SESSION", `target session not found: ${targetSessionId}`);
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`prompt` is required (non-empty string)");
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`idempotencyKey` must be a non-empty string when present");
    }

    let eventForAppend;
    try {
      eventForAppend = createSessionAskEvent({
        fromSessionId: sessionId,
        targetSessionId,
        prompt,
        workspace,
        source: "http",
        ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
      });
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "failed to create session.ask event");
    }

    let appendResult;
    try {
      appendResult = await runtimeStore.append(eventForAppend);
    } catch (err) {
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    const targetSession = projection.sessions.get(targetSessionId) || { id: targetSessionId };
    res.status(200).json({
      ok: true,
      ask: {
        from: sessionId,
        to: targetSessionId,
        prompt: eventForAppend.prompt,
        ts: eventForAppend.ts,
      },
      delivery: {
        runtimeEvent: true,
        targetSessionNotification: true,
      },
      targetSession,
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  };
  if (tokenMiddleware) {
    app.post("/api/sessions/:sessionId/ask", tokenMiddleware, postSessionAsk);
  } else {
    app.post("/api/sessions/:sessionId/ask", postSessionAsk);
  }

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

    let issuedToken = null;
    if (tokenStore && typeof tokenStore.issue === "function") {
      try {
        issuedToken = tokenStore.issue({ sessionId });
      } catch (err) {
        return sendError(res, 500, "TOKEN_ISSUE_FAILED", err.message || "failed to issue session token");
      }
    }

    let appendResult;
    try {
      appendResult = await runtimeStore.append(eventForAppend);
    } catch (err) {
      if (issuedToken && typeof tokenStore.revokeTokenHash === "function") {
        tokenStore.revokeTokenHash(issuedToken.tokenHash);
      }
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    // Prefer the projection's record (which carries computed fields like
    // status/statusSource/startedAt); fall back to the event payload if the
    // store wasn't wired with an onAppend that applies events to projection.
    const session = projection.sessions.get(sessionId) || { ...sessionPayload };

    res.status(201).json({
      session,
      ...(issuedToken
        ? {
            token: {
              token: issuedToken.token,
              tokenHash: issuedToken.tokenHash,
              sessionId: issuedToken.sessionId,
              capabilities: [...issuedToken.capabilities],
              issuedAt: issuedToken.issuedAt,
              expiresAt: issuedToken.expiresAt,
            },
          }
        : {}),
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  });

  // --- PATCH /api/sessions/:id --------------------------------------------
  const patchSessionStatus = async (req, res) => {
    const sessionId = req.params.id || req.params.sessionId;
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

    const { status, comment, contextUsage } = body;
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
    const contextUsageShape = validateContextUsage(contextUsage);
    if (contextUsageShape.error) {
      return sendError(res, 400, "INVALID_BODY", contextUsageShape.error);
    }

    // 404 if the session doesn't exist in the projection. We check this
    // BEFORE appending so we don't write an event for an unknown sessionId.
    if (!projection.sessions.get(sessionId)) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
    }

    // Placeholder id for schema validation only — stripped before append so
    // the store can assign its own canonical evt_ id (see POST handler comment
    // above for the same dance).
    const contextHighPercent = resolveContextHighPercent(activityThresholds);
    const shouldWarnContextHigh =
      contextUsageShape.value &&
      typeof contextUsageShape.value.percent === "number" &&
      contextUsageShape.value.percent >= contextHighPercent &&
      contextUsageShape.value.source === "mcp";
    const eventSource = contextUsageShape.value?.source === "mcp" ? "mcp" : "http";
    const statusForEvent = shouldWarnContextHigh ? "context_high" : status;
    const ts = new Date().toISOString();
    const eventForValidation = {
      schemaVersion: 1,
      id: makeRuntimeId("evt"),
      ts,
      type: "session.status",
      source: eventSource,
      workspace,
      sessionId,
      status: statusForEvent,
      ...(comment ? { comment } : {}),
      ...(contextUsageShape.value ? { contextUsage: contextUsageShape.value } : {}),
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

    let finalRev = appendResult.rev;
    let warningEventId = null;
    if (shouldWarnContextHigh) {
      let warningEvent;
      try {
        warningEvent = createSessionWarningEvent({
          sessionId,
          workspace,
          source: "mcp",
          ts,
          warning: contextHighWarning({
            source: "mcp",
            percent: contextUsageShape.value.percent,
          }),
        });
      } catch (err) {
        return sendError(res, 500, "CONTEXT_WARNING_FAILED", err.message || "failed to create context warning");
      }
      try {
        const warningAppendResult = await runtimeStore.append(warningEvent);
        finalRev = warningAppendResult.rev;
        warningEventId = warningAppendResult.eventId;
      } catch (err) {
        return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
      }
    }

    const session = projection.sessions.get(sessionId) || { id: sessionId, status: statusForEvent };
    res.status(200).json({
      session,
      rev: finalRev,
      eventId: appendResult.eventId,
      ...(warningEventId ? { warningEventId } : {}),
    });
  };
  if (tokenMiddleware) {
    app.patch("/api/sessions/:sessionId", tokenMiddleware, patchSessionStatus);
  } else {
    app.patch("/api/sessions/:id", patchSessionStatus);
  }

  // --- POST /api/sessions/:sessionId/token/rotate -------------------------
  // SH-2-07 (TDD v0.5 §19.2): caller presents current session token via the
  // requireSessionToken middleware; on success we revoke ALL outstanding
  // tokens for the session (killing the just-used cleartext) and issue a
  // fresh one. The handler appends a `session.token_rotated` runtime event
  // recording the NEW tokenHash — never the cleartext.
  //
  // Mounted only when `tokenStore` is wired so the older four routes keep
  // working in test fixtures that don't carry token plumbing.
  if (tokenMiddleware) {
    const runSerializedTokenRotation = createPerSessionSerializer();
    const runSerializedCaptureToggle = createPerSessionSerializer();

    app.post("/api/sessions/:sessionId/token/rotate", tokenMiddleware, async (req, res) => {
      const { sessionId } = req.params;
      if (!isSessionIdShape(sessionId)) {
        return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
      }

      // Body is optional for rotation — an empty/absent body means "use the
      // caller's current capabilities and the default lifetime". When
      // present, it must be a plain JSON object.
      const rawBody = req.body;
      const bodyObj =
        rawBody === undefined || rawBody === null
          ? {}
          : typeof rawBody === "object" && !Array.isArray(rawBody)
            ? rawBody
            : null;
      if (bodyObj === null) {
        return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
      }

      const unknown = [];
      for (const key of Object.keys(bodyObj)) {
        if (!ROTATE_ALLOWED_FIELDS.has(key)) unknown.push(key);
      }
      if (unknown.length > 0) {
        return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
      }

      // Capabilities: when omitted, inherit from the presented token so
      // rotation preserves effective rights unless the caller narrows them.
      let requestedCapabilities;
      if ("capabilities" in bodyObj) {
        const caps = bodyObj.capabilities;
        if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string" || c.length === 0)) {
          return sendError(res, 400, "INVALID_BODY", "`capabilities` must be a non-empty string[]");
        }
        requestedCapabilities = caps;
      }

      let lifetimeMinutes;
      if ("lifetimeMinutes" in bodyObj) {
        const lt = bodyObj.lifetimeMinutes;
        if (!Number.isInteger(lt) || lt <= 0) {
          return sendError(res, 400, "INVALID_BODY", "`lifetimeMinutes` must be a positive integer");
        }
        lifetimeMinutes = lt;
      }

      return runSerializedTokenRotation(sessionId, async () => {
        const presentedToken = readSessionTokenHeader(req);
        const freshCheck = tokenStore.validate(presentedToken, { expectedSessionId: sessionId });
        if (!freshCheck.ok) {
          return sendError(
            res,
            401,
            "SESSION_TOKEN_REJECTED",
            sessionTokenRejectMessage(freshCheck.reason),
            { reason: freshCheck.reason },
          );
        }

        // 404 if the session doesn't exist — don't append a rotation event for
        // a phantom session.
        if (!projection.sessions.get(sessionId)) {
          return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
        }

        const capabilities =
          requestedCapabilities !== undefined
            ? requestedCapabilities
            : [...freshCheck.record.capabilities];

        let issued;
        try {
          issued = tokenStore.issue({
            sessionId,
            capabilities,
            ...(lifetimeMinutes !== undefined ? { lifetimeMinutes } : {}),
          });
        } catch (err) {
          return sendError(res, 500, "TOKEN_ISSUE_FAILED", err.message || "failed to issue rotated token");
        }

        // Build the event with placeholder id for schema validation — same
        // dance as POST/PATCH above. Payload includes sessionId + the NEW
        // tokenHash. The cleartext is NEVER included in the event.
        const eventForValidation = {
          schemaVersion: 1,
          id: makeRuntimeId("evt"),
          ts: new Date().toISOString(),
          type: "session.token_rotated",
          source: "http",
          workspace,
          sessionId,
          tokenHash: issued.tokenHash,
        };

        try {
          validateRuntimeEvent(eventForValidation);
        } catch (err) {
          if (typeof tokenStore.revokeTokenHash === "function") {
            tokenStore.revokeTokenHash(issued.tokenHash);
          }
          return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
            errors: err.errors,
          });
        }

        const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;

        let appendResult;
        try {
          appendResult = await runtimeStore.append(eventForAppend);
        } catch (err) {
          if (typeof tokenStore.revokeTokenHash === "function") {
            tokenStore.revokeTokenHash(issued.tokenHash);
          }
          return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
        }

        tokenStore.revoke(sessionId, { exceptTokenHash: issued.tokenHash });

        res.status(200).json({
          token: issued.token,
          tokenHash: issued.tokenHash,
          sessionId: issued.sessionId,
          capabilities: [...issued.capabilities],
          issuedAt: issued.issuedAt,
          expiresAt: issued.expiresAt,
          rev: appendResult.rev,
          eventId: appendResult.eventId,
        });
      });
    });

    // --- POST /api/sessions/:sessionId/stdio/capture ----------------------
    // SH-2-23 (TDD v0.5 §19.3): toggle per-session stdio disk capture. Caller
    // presents a valid session token (same middleware as rotation). The
    // handler emits a `session.stdio_capture_changed` runtime event the
    // rotation module / WS layer can later react to. Idempotent on no-op:
    // when the requested `captureToDisk` matches the projection's current
    // value, the endpoint returns 200 without appending an event.
    app.post("/api/sessions/:sessionId/stdio/capture", tokenMiddleware, async (req, res) => {
      const { sessionId } = req.params;
      if (!isSessionIdShape(sessionId)) {
        return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
      }

      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
      }

      const unknown = [];
      for (const key of Object.keys(body)) {
        if (!STDIO_CAPTURE_ALLOWED_FIELDS.has(key)) unknown.push(key);
      }
      if (unknown.length > 0) {
        return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
      }

      const { captureToDisk, reason } = body;
      if (typeof captureToDisk !== "boolean") {
        return sendError(res, 400, "INVALID_BODY", "`captureToDisk` is required (boolean)");
      }
      if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
        return sendError(res, 400, "INVALID_BODY", "`reason` must be a non-empty string when present");
      }

      return runSerializedCaptureToggle(sessionId, async () => {
        // 404 before touching state — don't emit for a phantom session.
        const session = projection.sessions.get(sessionId);
        if (!session) {
          return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
        }

        // No-op detection: capture defaults OFF until a stdio_capture_changed
        // event lands. The projection (sh-1-05) stamps `stdioCapture` (the full
        // `capture` object); we read `.enabled` and treat absence as `false`.
        // This runs in a per-session chain so concurrent same-state toggles
        // re-check after the winner's RuntimeStore.append() updates projection.
        const currentEnabled =
          session.stdioCapture && typeof session.stdioCapture === "object"
            ? session.stdioCapture.enabled === true
            : false;
        if (currentEnabled === captureToDisk) {
          return res.status(200).json({
            session,
            rev: projection.rev,
            noop: true,
          });
        }

        let event;
        try {
          event = createSessionStdioCaptureChangedEvent({
            sessionId,
            captureToDisk,
            ...(reason !== undefined ? { reason } : {}),
            workspace,
            source: "http",
          });
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

        const updated = projection.sessions.get(sessionId) || session;
        res.status(200).json({
          session: updated,
          rev: appendResult.rev,
          eventId: appendResult.eventId,
        });
      });
    });
  }
}

// Inlined to avoid importing SESSION_ID_RE from the runtime layer twice and
// to keep this module self-contained for the file-allowlist constraint
// (hub/api/sessions.js is the only allowed implementation path for sh-1-09).
const SESSION_ID_SHAPE = /^ses_[0-9a-hjkmnp-tv-z]{26}$/;
function isSessionIdShape(value) {
  return typeof value === "string" && SESSION_ID_SHAPE.test(value);
}

function createPerSessionSerializer() {
  const chains = new Map();
  return (sessionId, fn) => {
    const previous = chains.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    chains.set(sessionId, next);
    next
      .finally(() => {
        if (chains.get(sessionId) === next) {
          chains.delete(sessionId);
        }
      })
      .catch(() => {});
    return next;
  };
}

function readSessionTokenHeader(req) {
  return (
    (typeof req.get === "function" && req.get("X-LT-Session-Token")) ||
    (req.headers && req.headers["x-lt-session-token"])
  );
}

function sessionTokenRejectMessage(reason) {
  switch (reason) {
    case "missing": return "session token required";
    case "unknown": return "session token not recognized";
    case "expired": return "session token expired";
    case "session_mismatch": return "session token does not match session";
    case "revoked": return "session token has been revoked";
    default: return "session token rejected";
  }
}

function validateContextUsage(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "`contextUsage` must be a JSON object when present" };
  }
  const output = {};
  if ("percent" in value) {
    if (!Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100) {
      return { error: "`contextUsage.percent` must be a number between 0 and 100" };
    }
    output.percent = value.percent;
  }
  if ("source" in value) {
    if (typeof value.source !== "string" || value.source.length === 0) {
      return { error: "`contextUsage.source` must be a non-empty string when present" };
    }
    output.source = value.source;
  }
  for (const key of ["used", "limit"]) {
    if (key in value) {
      if (!Number.isFinite(value[key]) || value[key] < 0) {
        return { error: `\`contextUsage.${key}\` must be a non-negative number when present` };
      }
      output[key] = value[key];
    }
  }
  if (!("percent" in output) && !("used" in output) && !("limit" in output)) {
    return { error: "`contextUsage` requires at least one of percent, used, or limit" };
  }
  return { value: output };
}

function resolveContextHighPercent(thresholds) {
  const percent =
    thresholds &&
    typeof thresholds === "object" &&
    typeof thresholds.contextHighPercent === "number"
      ? thresholds.contextHighPercent
      : DEFAULT_THRESHOLDS.contextHighPercent;
  if (Number.isFinite(percent) && percent > 0 && percent <= 100) return percent;
  return DEFAULT_THRESHOLDS.contextHighPercent;
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
