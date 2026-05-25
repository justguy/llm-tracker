// hub/api/run-session.js — sh-3-03 + sh-3-05 (TDD v0.5 §6.7, §8A.1, §12.0; PRD §6.7)
//
// HTTP routes for the Run Session funnel. Every task-card, swimlane, Hub,
// CLI, and attach entry point converges on these endpoints:
//
//   GET   /api/run-candidates?projectSlug=<slug>&laneId=<laneId>
//   POST  /api/run-session/draft
//   GET   /api/run-session/drafts/:draftId
//   PATCH /api/run-session/drafts/:draftId
//   POST  /api/run-session/launch
//
// Launch is now live (sh-3-05) — RunSessionService composes the launch
// result and this layer maps it to HTTP. The endpoint still owns body-shape
// validation; the service owns task-claim, session/job creation, and
// VerifyPack stamping.
//
// Active jobs in candidate scoring: still pass-through `jobs: []` for the
// scorer because sh-3-08 owns the live wiring. The launch path consumes the
// JobRegistry directly through the service.
//
// Error envelope mirrors hub/api/sessions.js: `{ error: { code, message, details? } }`.

import { scoreRunCandidates } from "../run-session/candidates.js";
import {
  isRunSessionDraftId,
  RUN_SESSION_DRAFT_SOURCES,
  RUN_SESSION_DRAFT_MODES,
} from "../run-session/drafts.js";

const CANDIDATES_ALLOWED_QUERY = new Set(["projectSlug", "laneId"]);
const LAUNCH_ALLOWED_FIELDS = new Set([
  "draftId",
  "expectedTrackerRev",
  "claimMode",
  "forceReason",
  "forceUser",
]);
const LAUNCH_CLAIM_MODES = new Set(["fail_if_active", "join", "force"]);

/**
 * @typedef {object} RegisterDeps
 * @property {{ get(slug: string): { data?: object, rev?: number } | null }} store
 *   Tracker Store (hub/store.js). `entry.data.tasks[]` feeds the scorer.
 * @property {ReturnType<import("../run-session/drafts.js").createDraftStore>} draftStore
 * @property {{ toSnapshots(): { sessions: object[] } }} projection
 *   RuntimeProjection — supplies the active sessions list for worktree
 *   conflict scoring.
 * @property {{ launch(input: object): Promise<object> }} runSessionService
 *   sh-3-05 RunSessionService — orchestrates POST /api/run-session/launch.
 */

/**
 * Mount the Run Session HTTP routes on an Express app.
 *
 * @param {import("express").Express} app
 * @param {RegisterDeps} deps
 */
export function registerRunSessionRoutes(app, deps) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new Error("registerRunSessionRoutes: express app required");
  }
  const { store, draftStore, projection, runSessionService } = deps || {};
  if (!store || typeof store.get !== "function") {
    throw new Error("registerRunSessionRoutes: store (with get) required");
  }
  if (
    !draftStore ||
    typeof draftStore.create !== "function" ||
    typeof draftStore.get !== "function" ||
    typeof draftStore.update !== "function"
  ) {
    throw new Error("registerRunSessionRoutes: draftStore required");
  }
  if (!projection || typeof projection.toSnapshots !== "function") {
    throw new Error("registerRunSessionRoutes: projection (with toSnapshots) required");
  }
  if (!runSessionService || typeof runSessionService.launch !== "function") {
    throw new Error("registerRunSessionRoutes: runSessionService (with launch) required");
  }

  // --- GET /api/run-candidates --------------------------------------------
  app.get("/api/run-candidates", (req, res) => {
    const unknown = [];
    for (const key of Object.keys(req.query || {})) {
      if (!CANDIDATES_ALLOWED_QUERY.has(key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown query field(s): ${unknown.join(", ")}`, { unknown });
    }

    const { projectSlug, laneId } = req.query;
    if (typeof projectSlug !== "string" || projectSlug.length === 0) {
      return sendError(res, 400, "INVALID_QUERY", "`projectSlug` is required (non-empty string)");
    }
    if (laneId !== undefined && (typeof laneId !== "string" || laneId.length === 0)) {
      return sendError(res, 400, "INVALID_QUERY", "`laneId` must be a non-empty string when present");
    }

    const entry = store.get(projectSlug);
    if (!entry) {
      return sendError(res, 404, "UNKNOWN_PROJECT", `project not found: ${projectSlug}`);
    }

    const tasks = Array.isArray(entry.data?.tasks) ? entry.data.tasks : [];
    const sessions = projection.toSnapshots().sessions || [];

    let candidates;
    try {
      candidates = scoreRunCandidates({
        tasks,
        sessions,
        // JobRegistry (sh-5-01) is not yet implemented; pass [] until then.
        jobs: [],
        options: {
          projectSlug,
          ...(laneId ? { laneId } : {}),
        },
      });
    } catch (err) {
      return sendError(res, 500, "SCORING_FAILED", err.message || "run-candidate scoring failed");
    }

    res.status(200).json({
      candidates,
      projectSlug,
      laneId: laneId ?? null,
      rev: entry.rev ?? null,
    });
  });

  // --- POST /api/run-session/draft ----------------------------------------
  app.post("/api/run-session/draft", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    if ("id" in body || "createdAt" in body || "expiresAt" in body) {
      return sendError(res, 400, "INVALID_BODY", "client-supplied id/createdAt/expiresAt are not allowed");
    }

    let draft;
    try {
      draft = draftStore.create(body);
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "draft creation rejected", {
        allowedSources: [...RUN_SESSION_DRAFT_SOURCES],
        allowedModes: [...RUN_SESSION_DRAFT_MODES],
      });
    }
    res.status(201).json({ draft });
  });

  // --- GET /api/run-session/drafts/:draftId -------------------------------
  app.get("/api/run-session/drafts/:draftId", (req, res) => {
    const { draftId } = req.params;
    if (!isRunSessionDraftId(draftId)) {
      return sendError(res, 400, "INVALID_DRAFT_ID", `not a valid draft_ id: ${draftId}`);
    }
    const draft = draftStore.get(draftId);
    if (!draft) {
      return sendError(res, 404, "UNKNOWN_DRAFT", `draft not found or expired: ${draftId}`);
    }
    res.status(200).json({ draft });
  });

  // --- PATCH /api/run-session/drafts/:draftId -----------------------------
  app.patch("/api/run-session/drafts/:draftId", (req, res) => {
    const { draftId } = req.params;
    if (!isRunSessionDraftId(draftId)) {
      return sendError(res, 400, "INVALID_DRAFT_ID", `not a valid draft_ id: ${draftId}`);
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    if ("id" in body || "createdAt" in body || "expiresAt" in body) {
      return sendError(res, 400, "INVALID_BODY", "id/createdAt/expiresAt are immutable");
    }

    // Disambiguate "not found / expired" from "validation failed" so the
    // 404 vs 400 distinction stays predictable for callers.
    if (!draftStore.get(draftId)) {
      return sendError(res, 404, "UNKNOWN_DRAFT", `draft not found or expired: ${draftId}`);
    }

    let draft;
    try {
      draft = draftStore.update(draftId, body);
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "draft update rejected");
    }
    res.status(200).json({ draft });
  });

  // --- POST /api/run-session/launch ---------------------------------------
  // sh-3-05: live RunSessionService. Body validation lives here; the service
  // returns a frozen RunLaunchResult that we translate into HTTP shapes.
  app.post("/api/run-session/launch", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const unknown = [];
    for (const key of Object.keys(body)) {
      if (!LAUNCH_ALLOWED_FIELDS.has(key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }
    const { draftId, expectedTrackerRev, claimMode, forceReason, forceUser } = body;
    if (!isRunSessionDraftId(draftId)) {
      return sendError(res, 400, "INVALID_BODY", "`draftId` is required (draft_<24-hex>)");
    }
    if (
      expectedTrackerRev !== undefined &&
      !(Number.isInteger(expectedTrackerRev) && expectedTrackerRev >= 0)
    ) {
      return sendError(res, 400, "INVALID_BODY", "`expectedTrackerRev` must be a non-negative integer when present");
    }
    if (claimMode !== undefined && !LAUNCH_CLAIM_MODES.has(claimMode)) {
      return sendError(
        res,
        400,
        "INVALID_BODY",
        `\`claimMode\` must be one of: ${[...LAUNCH_CLAIM_MODES].join(", ")}`,
        { allowed: [...LAUNCH_CLAIM_MODES] },
      );
    }
    if (forceReason !== undefined && (typeof forceReason !== "string" || forceReason.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`forceReason` must be a non-empty string when present");
    }
    if (forceUser !== undefined && (typeof forceUser !== "string" || forceUser.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`forceUser` must be a non-empty string when present");
    }

    // Reject unknown drafts up-front so the service never wastes work on a
    // dead launch. (The service also handles unknown_draft itself; this guard
    // keeps the 404 path identical to the GET/PATCH endpoints.)
    if (!draftStore.get(draftId)) {
      return sendError(res, 404, "UNKNOWN_DRAFT", `draft not found or expired: ${draftId}`);
    }

    const launchInput = {
      draftId,
      ...(expectedTrackerRev !== undefined ? { expectedTrackerRev } : {}),
      ...(claimMode !== undefined ? { claimMode } : {}),
      ...(forceReason !== undefined ? { forceReason } : {}),
      ...(forceUser !== undefined ? { forceUser } : {}),
    };

    let result;
    try {
      result = await runSessionService.launch(launchInput);
    } catch (err) {
      return sendError(res, 500, "LAUNCH_FAILED", err.message || "RunSessionService.launch threw");
    }

    if (result.ok === true) {
      // 201 for any successful launch (created/joined/untasked/attached); the
      // body is the result without the `ok` discriminator so callers see the
      // mode-shaped record directly.
      const { ok: _ok, ...payload } = result;
      return res.status(201).json(payload);
    }

    switch (result.error) {
      case "stale_tracker_rev":
        return sendError(
          res,
          409,
          "STALE_TRACKER_REV",
          `tracker rev has moved on (current: ${result.currentRev})`,
          { currentRev: result.currentRev },
        );
      case "task_claim_conflict":
        return sendError(
          res,
          409,
          "TASK_CLAIM_CONFLICT",
          `task already has an active job: ${result.activeJobId}`,
          { activeJobId: result.activeJobId },
        );
      case "unknown_draft":
        return sendError(res, 404, "UNKNOWN_DRAFT", `draft not found or expired: ${draftId}`);
      case "unknown_project":
        return sendError(res, 404, "UNKNOWN_PROJECT", "project referenced by draft not found");
      case "unknown_task":
        return sendError(res, 404, "UNKNOWN_TASK", "task referenced by draft not found");
      case "unknown_session":
        return sendError(res, 404, "UNKNOWN_SESSION", "session referenced by attach draft not found");
      case "invalid_input":
        return sendError(res, 400, "INVALID_BODY", result.detail || "invalid launch input");
      default:
        return sendError(res, 500, "LAUNCH_FAILED", `unknown launch result error: ${result.error}`);
    }
  });
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
