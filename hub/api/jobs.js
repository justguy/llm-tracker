// hub/api/jobs.js — SH-5-09 (TDD v0.5 §12.2, §11.5.1)
//
// HTTP routes for the JobRecord lifecycle. Every mutation flows through the
// JobRegistry (SH-5-01), which owns the runtime event emission and the
// terminal-state guard. Routes never touch RuntimeProjection directly.
//
// Endpoints (TDD §12.2):
//   GET    /api/jobs                            — list JobRecord[]
//   GET    /api/jobs/:jobId                     — fetch a single JobRecord
//   POST   /api/jobs/:jobId/checkpoint          — emit job.checkpoint
//   POST   /api/jobs/:jobId/complete            — JobCompleteResult union
//   POST   /api/jobs/:jobId/cancel              — emit job.completed (cancelled)
//   POST   /api/jobs/:jobId/rollover            — emit job.rollover_requested
//   POST   /api/jobs/:jobId/unblock             — emit job.unblocked (SH-5-16)
//   GET    /api/jobs/:jobId/context-pack        — 501 stub (SH-8-02)
//
// The `/complete` route implements the JobCompleteResult union (§11.5.1):
//   { ok: true,  mode: "completed", jobId }
//   { ok: false, mode: "gates_pending", missing[], requiresOverride, overridePromptUrl }
// The third union variant (`completed_via_override`) is the response shape of
// SH-5-15's `/complete-override` endpoint and is out of scope here.
//
// Error envelope mirrors hub/api/sessions.js: `{ error: { code, message, details? } }`.

import { isJobId } from "../runtime/ids.js";

const CHECKPOINT_ALLOWED_FIELDS = new Set(["status", "summary", "idempotencyKey"]);
const COMPLETE_ALLOWED_FIELDS = new Set(["summary", "idempotencyKey"]);
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
    typeof jobRegistry.cancel !== "function" ||
    typeof jobRegistry.requestRollover !== "function" ||
    typeof jobRegistry.unblock !== "function"
  ) {
    throw new Error("registerJobsRoutes: jobRegistry (with list/get/checkpoint/complete/cancel/requestRollover/unblock) required");
  }

  // --- GET /api/jobs ------------------------------------------------------
  app.get("/api/jobs", (_req, res) => {
    res.status(200).json({ jobs: jobRegistry.list() });
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
    if (body !== undefined && body !== null) {
      if (typeof body !== "object" || Array.isArray(body)) {
        return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
      }
      if (Object.keys(body).length > 0) {
        const unknown = rejectUnknownFields(body, COMPLETE_ALLOWED_FIELDS);
        if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
        summary = body.summary;
        idempotencyKey = body.idempotencyKey;
      }
    }

    // Inspect the projection record's completionGates. Until SH-5-04 lands,
    // this field is generally absent — in which case the common path runs.
    const existing = jobRegistry.get(jobId);
    if (!existing) {
      return sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
    }
    const gates = Array.isArray(existing.completionGates) ? existing.completionGates : [];
    const missing = gates.filter(
      (g) => g && g.required === true && g.status !== "satisfied" && g.status !== "overridden",
    );
    if (missing.length > 0) {
      return res.status(200).json({
        ok: false,
        mode: "gates_pending",
        missing,
        requiresOverride: true,
        overridePromptUrl: `/api/jobs/${jobId}/complete-override`,
      });
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
 *   INVALID_JOB_STATE         -> 409
 *   UNKNOWN_JOB               -> 404 (JOB_NOT_FOUND in the HTTP envelope)
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
      return sendError(res, 400, code, err.message, details);
    case "INVALID_JOB_STATE":
      return sendError(res, 409, code, err.message, details);
    case "UNKNOWN_JOB":
      return sendError(res, 404, "JOB_NOT_FOUND", err.message, details);
    case "JOB_TERMINAL":
      return sendError(res, 409, "JOB_TERMINAL", err.message, details);
    default:
      return sendError(res, 500, "REGISTRY_FAILED", (err && err.message) || "job registry call failed");
  }
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
