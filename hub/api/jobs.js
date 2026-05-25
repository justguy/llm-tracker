// hub/api/jobs.js — SH-5-09 (TDD v0.5 §12.2, §11.5.1)
//
// HTTP routes for the JobRecord lifecycle. Every mutation flows through the
// JobRegistry (SH-5-01), which owns the runtime event emission and the
// terminal-state guard. Routes never touch RuntimeProjection directly.
//
// Endpoints (TDD §12.2):
//   GET    /api/jobs                            — list JobRecord[]
//   POST   /api/projects/:slug/tasks/:taskId/jobs — create JobRecord (SH-5-18)
//   GET    /api/jobs/:jobId                     — fetch a single JobRecord
//   PATCH  /api/jobs/:jobId                     — checkpoint delegate (SH-5-18)
//   POST   /api/jobs/:jobId/checkpoint          — emit job.checkpoint
//   POST   /api/jobs/:jobId/complete            — JobCompleteResult union
//   POST   /api/jobs/:jobId/complete-override   — emit human.override + job.completed
//   POST   /api/jobs/:jobId/cancel              — emit job.completed (cancelled)
//   POST   /api/jobs/:jobId/rollover            — emit job.rollover_requested
//   POST   /api/jobs/:jobId/unblock             — emit job.unblocked (SH-5-16)
//   GET    /api/jobs/:jobId/context-pack        — 501 stub (SH-8-02)
//
// The `/complete` route implements the JobCompleteResult union (§11.5.1):
//   { ok: true,  mode: "completed", jobId }
//   { ok: false, mode: "gates_pending", missing[], requiresOverride, overridePromptUrl }
//   { ok: true,  mode: "completed_via_override", jobId, overrideEventId }
//
// Error envelope mirrors hub/api/sessions.js: `{ error: { code, message, details? } }`.

import { isJobId } from "../runtime/ids.js";
import { TERMINAL_JOB_STATUS } from "../jobs/registry.js";
import {
  buildGatesPendingResult,
  findMissingRequiredGates,
  resolveUiCompleteMode,
} from "../jobs/gates.js";

const CHECKPOINT_ALLOWED_FIELDS = new Set(["status", "summary", "idempotencyKey"]);
// SH-5-18: PATCH /api/jobs/:jobId reconciles with checkpoint semantics, so it
// accepts the same fields as POST /:jobId/checkpoint.
const PATCH_ALLOWED_FIELDS = new Set(["status", "summary", "idempotencyKey"]);
// SH-5-18: POST /api/projects/:slug/tasks/:taskId/jobs. `projectSlug`/`taskId`
// come from the URL — they are not accepted in the body so the URL is the
// single source of truth.
const CREATE_ALLOWED_FIELDS = new Set([
  "sessionId",
  "profileId",
  "kind",
  "predecessorJobId",
  "idempotencyKey",
]);
const COMPLETE_ALLOWED_FIELDS = new Set(["summary", "idempotencyKey", "uiCompleteMode"]);
const COMPLETE_OVERRIDE_ALLOWED_FIELDS = new Set(["reason", "summary", "user", "idempotencyKey"]);
const CANCEL_ALLOWED_FIELDS = new Set(["summary", "idempotencyKey"]);
const ROLLOVER_ALLOWED_FIELDS = new Set(["reason", "idempotencyKey"]);
// SH-5-16: /unblock accepts reason + previousReason. `user` is intentionally
// NOT accepted from the body — there is no auth surface yet and we don't want
// callers to spoof identity. The registry has a `user` parameter so future
// auth wiring can pass it through server-side once an identity layer lands.
const UNBLOCK_ALLOWED_FIELDS = new Set(["reason", "previousReason", "idempotencyKey"]);

const CONTEXT_PACK_KINDS = new Set(["start", "resume", "rollover", "verify", "handoff"]);

/**
 * @typedef {object} RegisterDeps
 * @property {import("../jobs/registry.js").JobRegistry} jobRegistry
 */

/**
 * Register the job lifecycle routes on an Express app.
 *
 * @param {import("express").Express} app
 * @param {RegisterDeps} deps
 */
export function registerJobsRoutes(app, deps) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new Error("registerJobsRoutes: express app required");
  }
  const { jobRegistry } = deps || {};
  if (
    !jobRegistry ||
    typeof jobRegistry.list !== "function" ||
    typeof jobRegistry.get !== "function" ||
    typeof jobRegistry.checkpoint !== "function" ||
    typeof jobRegistry.complete !== "function" ||
    typeof jobRegistry.completeWithOverride !== "function" ||
    typeof jobRegistry.cancel !== "function" ||
    typeof jobRegistry.requestRollover !== "function" ||
    typeof jobRegistry.unblock !== "function"
  ) {
    throw new Error("registerJobsRoutes: jobRegistry (with list/get/checkpoint/complete/completeWithOverride/cancel/requestRollover/unblock) required");
  }

  // --- GET /api/jobs ------------------------------------------------------
  app.get("/api/jobs", (_req, res) => {
    res.status(200).json({ jobs: jobRegistry.list() });
  });

  // --- POST /api/projects/:slug/tasks/:taskId/jobs ------------------------
  // SH-5-18. §12.2 start/create route — JobRegistry.create() picks the right
  // verb (`job.started` vs `job.queued`) based on `predecessorJobId`.
  app.post("/api/projects/:slug/tasks/:taskId/jobs", async (req, res) => {
    const { slug, taskId } = req.params;
    if (typeof slug !== "string" || slug.length === 0) {
      return sendError(res, 400, "INVALID_INPUT", "slug path param required");
    }
    if (typeof taskId !== "string" || taskId.length === 0) {
      return sendError(res, 400, "INVALID_INPUT", "taskId path param required");
    }
    const bodyOrErr = requireObjectBody(req, res);
    if (bodyOrErr === undefined) return;
    const unknown = rejectUnknownFields(bodyOrErr, CREATE_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    try {
      const result = await jobRegistry.create({
        sessionId: bodyOrErr.sessionId,
        projectSlug: slug,
        taskId,
        profileId: bodyOrErr.profileId,
        kind: bodyOrErr.kind,
        ...(bodyOrErr.predecessorJobId !== undefined ? { predecessorJobId: bodyOrErr.predecessorJobId } : {}),
        ...(bodyOrErr.idempotencyKey !== undefined ? { idempotencyKey: bodyOrErr.idempotencyKey } : {}),
        source: "http",
      });
      return res.status(201).json({
        jobId: result.jobId,
        rev: result.rev,
        eventId: result.eventId,
        job: result.job,
      });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- GET /api/jobs/:jobId -----------------------------------------------
  app.get("/api/jobs/:jobId", (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const job = jobRegistry.get(jobId);
    if (!job) {
      return sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
    }
    res.status(200).json(job);
  });

  // --- PATCH /api/jobs/:jobId ---------------------------------------------
  // SH-5-18. Thin delegation to JobRegistry.checkpoint — reconciles §12.2's
  // generic lifecycle update with the explicit checkpoint route below.
  app.patch("/api/jobs/:jobId", async (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const bodyOrErr = requireObjectBody(req, res);
    if (bodyOrErr === undefined) return;
    const unknown = rejectUnknownFields(bodyOrErr, PATCH_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    try {
      const result = await jobRegistry.checkpoint(jobId, {
        ...(bodyOrErr.status !== undefined ? { status: bodyOrErr.status } : {}),
        ...(bodyOrErr.summary !== undefined ? { summary: bodyOrErr.summary } : {}),
        ...(bodyOrErr.idempotencyKey !== undefined ? { idempotencyKey: bodyOrErr.idempotencyKey } : {}),
        source: "http",
      });
      return res.status(200).json({ rev: result.rev, eventId: result.eventId, job: result.job });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- POST /api/jobs/:jobId/checkpoint -----------------------------------
  app.post("/api/jobs/:jobId/checkpoint", async (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const bodyOrErr = requireObjectBody(req, res);
    if (bodyOrErr === undefined) return;
    const unknown = rejectUnknownFields(bodyOrErr, CHECKPOINT_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    try {
      const result = await jobRegistry.checkpoint(jobId, {
        ...(bodyOrErr.status !== undefined ? { status: bodyOrErr.status } : {}),
        ...(bodyOrErr.summary !== undefined ? { summary: bodyOrErr.summary } : {}),
        ...(bodyOrErr.idempotencyKey !== undefined ? { idempotencyKey: bodyOrErr.idempotencyKey } : {}),
        source: "http",
      });
      return res.status(200).json({ rev: result.rev, eventId: result.eventId, job: result.job });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- POST /api/jobs/:jobId/complete -------------------------------------
  // JobCompleteResult union per TDD §11.5.1.
  app.post("/api/jobs/:jobId/complete", async (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }

    // Body is optional on /complete (per brief). When present, validate.
    const body = req.body;
    let summary;
    let idempotencyKey;
    let uiCompleteMode;
    if (body !== undefined && body !== null) {
      if (typeof body !== "object" || Array.isArray(body)) {
        return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
      }
      if (Object.keys(body).length > 0) {
        const unknown = rejectUnknownFields(body, COMPLETE_ALLOWED_FIELDS);
        if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
        summary = body.summary;
        idempotencyKey = body.idempotencyKey;
        try {
          uiCompleteMode = resolveUiCompleteMode(body.uiCompleteMode);
        } catch (err) {
          return mapGateError(res, err);
        }
      }
    }
    if (uiCompleteMode === undefined) uiCompleteMode = resolveUiCompleteMode(undefined);

    // Inspect the projection record's completionGates. A gate with status
    // `satisfied` or `overridden` still blocks completion unless it carries a
    // runtime-event evidenceRef. This prevents UI-only flips from completing.
    const existing = jobRegistry.get(jobId);
    if (!existing) {
      return sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
    }
    if (TERMINAL_JOB_STATUS.includes(existing.status)) {
      return sendError(res, 409, "JOB_TERMINAL", `job '${jobId}' is terminal (${existing.status})`, {
        jobId,
        status: existing.status,
      });
    }
    const missing = findMissingRequiredGates(existing);
    if (missing.length > 0) {
      return res.status(200).json(buildGatesPendingResult(jobId, missing));
    }

    try {
      await jobRegistry.complete(jobId, {
        status: "completed",
        ...(summary !== undefined ? { summary } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        source: "http",
      });
      return res.status(200).json({ ok: true, mode: "completed", jobId });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- POST /api/jobs/:jobId/complete-override ----------------------------
  // Human override of missing completion gates. The human.override event is
  // recorded first; its canonical event id becomes each overridden gate's
  // evidenceRef before the job.completed terminal transition is emitted.
  app.post("/api/jobs/:jobId/complete-override", async (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const bodyOrErr = requireObjectBody(req, res);
    if (bodyOrErr === undefined) return;
    const unknown = rejectUnknownFields(bodyOrErr, COMPLETE_OVERRIDE_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    if (typeof bodyOrErr.reason !== "string" || bodyOrErr.reason.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`reason` is required for completion override");
    }
    if (bodyOrErr.user !== undefined && (typeof bodyOrErr.user !== "string" || bodyOrErr.user.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`user` must be a non-empty string when present");
    }

    const existing = jobRegistry.get(jobId);
    if (!existing) {
      return sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
    }
    const missing = findMissingRequiredGates(existing);
    if (missing.length === 0) {
      return sendError(res, 409, "NO_MISSING_GATES", "completion override requires at least one missing required gate");
    }

    try {
      const result = await jobRegistry.completeWithOverride(jobId, {
        reason: bodyOrErr.reason,
        ...(bodyOrErr.summary !== undefined ? { summary: bodyOrErr.summary } : {}),
        ...(bodyOrErr.user !== undefined ? { user: bodyOrErr.user } : {}),
        ...(bodyOrErr.idempotencyKey !== undefined ? { idempotencyKey: bodyOrErr.idempotencyKey } : {}),
        source: "http",
      });
      return res.status(200).json({
        ok: true,
        mode: "completed_via_override",
        jobId,
        overrideEventId: result.overrideEventId,
      });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- POST /api/jobs/:jobId/cancel ---------------------------------------
  app.post("/api/jobs/:jobId/cancel", async (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const bodyOrErr = requireObjectBody(req, res);
    if (bodyOrErr === undefined) return;
    const unknown = rejectUnknownFields(bodyOrErr, CANCEL_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    try {
      const result = await jobRegistry.cancel(jobId, {
        ...(bodyOrErr.summary !== undefined ? { summary: bodyOrErr.summary } : {}),
        ...(bodyOrErr.idempotencyKey !== undefined ? { idempotencyKey: bodyOrErr.idempotencyKey } : {}),
        source: "http",
      });
      return res.status(200).json({ rev: result.rev, eventId: result.eventId, job: result.job });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- POST /api/jobs/:jobId/rollover -------------------------------------
  app.post("/api/jobs/:jobId/rollover", async (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const bodyOrErr = requireObjectBody(req, res);
    if (bodyOrErr === undefined) return;
    const unknown = rejectUnknownFields(bodyOrErr, ROLLOVER_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    try {
      const result = await jobRegistry.requestRollover(jobId, {
        ...(bodyOrErr.reason !== undefined ? { reason: bodyOrErr.reason } : {}),
        ...(bodyOrErr.idempotencyKey !== undefined ? { idempotencyKey: bodyOrErr.idempotencyKey } : {}),
        source: "http",
      });
      return res.status(200).json({ rev: result.rev, eventId: result.eventId, job: result.job });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- POST /api/jobs/:jobId/unblock --------------------------------------
  // SH-5-16. Manual override of the `blocked` status (per TDD §12.8). Emits a
  // JobUnblockedEvent; if the predecessor is still active, the registry also
  // emits a follow-up job.checkpoint that flips status to `queued`.
  app.post("/api/jobs/:jobId/unblock", async (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const bodyOrErr = requireObjectBody(req, res);
    if (bodyOrErr === undefined) return;
    const unknown = rejectUnknownFields(bodyOrErr, UNBLOCK_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    try {
      const result = await jobRegistry.unblock(jobId, {
        ...(bodyOrErr.reason !== undefined ? { reason: bodyOrErr.reason } : {}),
        ...(bodyOrErr.previousReason !== undefined ? { previousReason: bodyOrErr.previousReason } : {}),
        ...(bodyOrErr.idempotencyKey !== undefined ? { idempotencyKey: bodyOrErr.idempotencyKey } : {}),
        source: "http",
      });
      return res.status(200).json({ rev: result.rev, eventId: result.eventId, job: result.job });
    } catch (err) {
      return mapRegistryError(res, err);
    }
  });

  // --- GET /api/jobs/:jobId/context-pack ----------------------------------
  // Reserved by SH-5-09 — composition lands with SH-8-02. We still validate
  // shape so callers learn the contract early.
  app.get("/api/jobs/:jobId/context-pack", (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const { kind } = req.query;
    if (kind !== undefined && (typeof kind !== "string" || !CONTEXT_PACK_KINDS.has(kind))) {
      return sendError(
        res,
        400,
        "INVALID_QUERY",
        `\`kind\` must be one of: ${[...CONTEXT_PACK_KINDS].join(", ")}`,
        { allowed: [...CONTEXT_PACK_KINDS] },
      );
    }
    return sendError(
      res,
      501,
      "NOT_IMPLEMENTED",
      "context-pack composition lands with SH-8-02; sh-5-09 reserves the route.",
    );
  });
}

// --- helpers ----------------------------------------------------------------

/**
 * Validate that the request body is a plain JSON object. On failure, writes
 * a 400 INVALID_BODY response and returns undefined so the caller can early-
 * exit; on success, returns the body.
 */
function requireObjectBody(req, res) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    return undefined;
  }
  return body;
}

function rejectUnknownFields(body, allowed) {
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) unknown.push(key);
  }
  return unknown.length > 0 ? unknown : null;
}

/**
 * Translate a JobRegistry error into the right HTTP status + error envelope.
 * Stable codes from the registry:
 *   INVALID_JOB_ID            -> 400
 *   INVALID_JOB_STATUS        -> 400
 *   TERMINAL_STATUS_FORBIDDEN -> 400
 *   INVALID_INPUT             -> 400
 *   INVALID_SESSION_ID        -> 400 (SH-5-18, create-time)
 *   INVALID_PREDECESSOR_ID    -> 400 (SH-5-18, create-time)
 *   INVALID_JOB_KIND          -> 400 (SH-5-18, create-time)
 *   INVALID_GATE_IDS          -> 400
 *   INVALID_JOB_STATE         -> 409
 *   NO_MISSING_GATES          -> 409
 *   UNKNOWN_JOB               -> 404 (JOB_NOT_FOUND in the HTTP envelope)
 *   UNKNOWN_PREDECESSOR       -> 404 (SH-5-18, create-time)
 *   JOB_TERMINAL              -> 409
 */
function mapRegistryError(res, err) {
  const code = err && err.code;
  const details = err && err.details;
  switch (code) {
    case "INVALID_JOB_ID":
      return sendError(res, 400, "INVALID_JOB_ID", err.message, details);
    case "INVALID_JOB_STATUS":
    case "TERMINAL_STATUS_FORBIDDEN":
    case "INVALID_INPUT":
    case "INVALID_GATE_IDS":
    case "INVALID_SESSION_ID":
    case "INVALID_PREDECESSOR_ID":
    case "INVALID_JOB_KIND":
      return sendError(res, 400, code, err.message, details);
    case "INVALID_JOB_STATE":
    case "NO_MISSING_GATES":
      return sendError(res, 409, code, err.message, details);
    case "UNKNOWN_JOB":
      return sendError(res, 404, "JOB_NOT_FOUND", err.message, details);
    case "UNKNOWN_PREDECESSOR":
      return sendError(res, 404, "UNKNOWN_PREDECESSOR", err.message, details);
    case "JOB_TERMINAL":
      return sendError(res, 409, "JOB_TERMINAL", err.message, details);
    default:
      return sendError(res, 500, "REGISTRY_FAILED", (err && err.message) || "job registry call failed");
  }
}

function mapGateError(res, err) {
  const code = err && err.code;
  const details = err && err.details;
  switch (code) {
    case "INVALID_UI_COMPLETE_MODE":
    case "INVALID_GATE_STATUS":
    case "EVIDENCE_REF_REQUIRED":
    case "OVERRIDE_REASON_REQUIRED":
    case "INVALID_GATE_IDS":
    case "INVALID_USER":
      return sendError(res, 400, "INVALID_BODY", err.message, details);
    case "INVALID_JOB_ID":
      return sendError(res, 400, "INVALID_JOB_ID", err.message, details);
    case "INVALID_JOB":
    case "INVALID_GATE":
    case "INVALID_WORKSPACE":
    case "INVALID_SOURCE":
      return sendError(res, 500, "GATE_STATE_FAILED", err.message, details);
    default:
      return sendError(res, 500, "GATE_STATE_FAILED", (err && err.message) || "completion gate state failed");
  }
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
