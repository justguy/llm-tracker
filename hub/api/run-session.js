// hub/api/run-session.js — sh-3-03 (TDD v0.5 §6.7, §8A.1, §12.0; PRD §6.7)
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
// Launch is intentionally a 501 LAUNCH_NOT_AVAILABLE stub: the full path
// (sh-3-05 RunSessionService) requires JobRegistry (sh-5-01), VerifyPack
// composition (sh-5-04 full impl), ContextPack (sh-8-01), and TaskClaim
// (sh-3-04) — none of which exist on v2-t2t4 yet. The endpoint validates
// the request shape so callers get the same INVALID_BODY errors they will
// see once the underlying services are wired.
//
// Active jobs are not yet available either: JobRegistry (sh-5-01) is not
// implemented, so candidate scoring receives `jobs: []` and the
// "task already has active job" penalty cannot fire. Sessions come from
// the live RuntimeProjection (shared with /api/sessions).
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
  const { store, draftStore, projection } = deps || {};
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
  // STUB: sh-3-05 RunSessionService is not yet implemented. Validate body
  // shape so callers get a meaningful 4xx for bad inputs, then return 501
  // with a code that documents the dependency.
  app.post("/api/run-session/launch", (req, res) => {
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
    const { draftId, expectedTrackerRev, claimMode } = body;
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

    // Reject unknown drafts up-front so the 501 only fires when a launch
    // *could* succeed once RunSessionService lands.
    if (!draftStore.get(draftId)) {
      return sendError(res, 404, "UNKNOWN_DRAFT", `draft not found or expired: ${draftId}`);
    }

    return sendError(
      res,
      501,
      "LAUNCH_NOT_AVAILABLE",
      "RunSessionService (sh-3-05) is not yet wired; POST /api/run-session/launch is a stub",
      { pendingTasks: ["sh-3-05", "sh-5-01", "sh-3-04"] },
    );
  });
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
