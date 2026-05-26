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
//   GET    /api/jobs/:jobId/skill-plan          — build/read SkillPlan for job profile
//
// The `/complete` route implements the JobCompleteResult union (§11.5.1):
//   { ok: true,  mode: "completed", jobId }
//   { ok: false, mode: "gates_pending", missing[], requiresOverride, overridePromptUrl }
//   { ok: true,  mode: "completed_via_override", jobId, overrideEventId }
//
// Error envelope mirrors hub/api/sessions.js: `{ error: { code, message, details? } }`.

import { isJobId, isSkillRunId } from "../runtime/ids.js";
import { TERMINAL_JOB_STATUS } from "../jobs/registry.js";
import { buildSkillPlan } from "../jobs/skill-plan.js";
import { BUILT_IN_PROFILES } from "../jobs/profiles.js";
import { SkillsRegistry } from "../skills/registry.js";
import { requireSessionToken } from "./middleware/session-token.js";
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
const SKILL_RUN_START_ALLOWED_FIELDS = new Set(["skillId", "sessionId", "summary", "source", "evidence"]);
const SKILL_RUN_PATCH_ALLOWED_FIELDS = new Set(["status", "skillId", "sessionId", "summary", "source", "evidence"]);
const SKILL_RUN_OVERRIDE_ALLOWED_FIELDS = new Set(["reason", "skillId", "sessionId", "summary", "source", "evidence", "user"]);

const CONTEXT_PACK_KINDS = new Set(["start", "resume", "rollover", "verify", "handoff"]);
const SKILL_RUN_FINISH_STATUSES = new Set(["succeeded", "failed", "skipped", "overridden"]);
const SKILL_EVENT_SOURCES = new Set(["http", "mcp"]);
const SKILL_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;

/**
 * @typedef {object} RegisterDeps
 * @property {import("../jobs/registry.js").JobRegistry} jobRegistry
 * @property {import("../skills/registry.js").SkillsRegistry} [skillsRegistry]
 * @property {import("../sessions/auth/tokens.js").SessionTokenStore} [tokenStore]
 * @property {import("../runtime/store.js").RuntimeStore} [runtimeStore]
 * @property {(prefix: string) => string} [makeRuntimeId]
 * @property {(event: object) => true} [validateRuntimeEvent]
 * @property {string} [workspace]
 * @property {object[]} [jobProfiles]
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
  const {
    jobRegistry,
    tokenStore,
    runtimeStore,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace,
  } = deps || {};
  const skillsRegistry = deps?.skillsRegistry || new SkillsRegistry();
  const jobProfiles = Array.isArray(deps?.jobProfiles) ? deps.jobProfiles : BUILT_IN_PROFILES;
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
  const tokenMiddleware =
    tokenStore && typeof tokenStore.validate === "function"
      ? requireSessionToken({
          tokenStore,
          ...(runtimeStore && typeof makeRuntimeId === "function" && typeof validateRuntimeEvent === "function" && typeof workspace === "string"
            ? { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace }
            : {}),
          getSessionId: (req) => sessionIdForJobMutation(req, jobRegistry),
        })
      : null;
  const requireToken = tokenMiddleware ? [tokenMiddleware] : [];

  // --- GET /api/skills ----------------------------------------------------
  app.get("/api/skills", (_req, res) => {
    res.status(200).json({ skills: skillsRegistry.list() });
  });

  // --- GET /api/skills/:skillId ------------------------------------------
  app.get("/api/skills/:skillId", (req, res) => {
    const { skillId } = req.params;
    if (!isValidSkillId(skillId)) {
      return sendError(res, 400, "INVALID_SKILL_ID", `not a valid skill id: ${skillId}`);
    }
    const skill = skillsRegistry.get(skillId);
    if (!skill) {
      return sendError(res, 404, "UNKNOWN_SKILL", `skill not found: ${skillId}`);
    }
    return res.status(200).json({ skill });
  });

  // --- GET /api/job-profiles ---------------------------------------------
  app.get("/api/job-profiles", (_req, res) => {
    res.status(200).json({ profiles: jobProfiles });
  });

  // --- GET /api/jobs ------------------------------------------------------
  app.get("/api/jobs", (_req, res) => {
    res.status(200).json({ jobs: jobRegistry.list() });
  });

  // --- POST /api/projects/:slug/tasks/:taskId/jobs ------------------------
  // SH-5-18. §12.2 start/create route — JobRegistry.create() picks the right
  // verb (`job.started` vs `job.queued`) based on `predecessorJobId`.
  app.post("/api/projects/:slug/tasks/:taskId/jobs", ...requireToken, async (req, res) => {
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

  // --- POST /api/jobs/:jobId/skill-runs ----------------------------------
  app.post("/api/jobs/:jobId/skill-runs", ...requireToken, async (req, res) => {
    const prepared = prepareSkillRunRequest({
      req,
      res,
      jobRegistry,
      skillsRegistry,
      allowedFields: SKILL_RUN_START_ALLOWED_FIELDS,
      requireBody: true,
      requireActiveJob: true,
      requireSkillId: true,
    });
    if (!prepared) return;
    if (!assertSkillRuntimeDeps(res, { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace })) return;

    const skillRunId = makeRuntimeId("skr");
    const source = resolveSkillEventSource(prepared.body.source);
    if (source.error) return sendError(res, 400, "INVALID_BODY", source.error);

    const event = {
      schemaVersion: 1,
      id: makeRuntimeId("evt"),
      ts: new Date().toISOString(),
      type: "skill.run.started",
      source: source.value,
      workspace,
      skillRunId,
      skillId: prepared.skillId,
      jobId: prepared.job.id,
      sessionId: prepared.sessionId,
      ...(prepared.body.summary !== undefined ? { summary: prepared.body.summary } : {}),
      ...(prepared.body.evidence !== undefined ? { evidence: prepared.body.evidence } : {}),
    };

    const result = await appendRuntimeEvent(res, {
      event,
      runtimeStore,
      validateRuntimeEvent,
    });
    if (!result) return;
    const skillRun = jobRegistry.projection?.skillRuns?.get(skillRunId) || null;
    return res.status(201).json({
      jobId: prepared.job.id,
      sessionId: prepared.sessionId,
      skillRunId,
      skillId: prepared.skillId,
      eventId: result.eventId,
      rev: result.rev,
      skillRun,
    });
  });

  // --- PATCH /api/jobs/:jobId/skill-runs/:runId ---------------------------
  app.patch("/api/jobs/:jobId/skill-runs/:runId", ...requireToken, async (req, res) => {
    const { runId } = req.params;
    if (!isSkillRunId(runId)) {
      return sendError(res, 400, "INVALID_SKILL_RUN_ID", `not a valid skr_ id: ${runId}`);
    }
    const prepared = prepareSkillRunRequest({
      req,
      res,
      jobRegistry,
      skillsRegistry,
      allowedFields: SKILL_RUN_PATCH_ALLOWED_FIELDS,
      requireBody: true,
      requireActiveJob: true,
      requireSkillId: false,
    });
    if (!prepared) return;
    if (!assertSkillRuntimeDeps(res, { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace })) return;

    const existingRun = jobRegistry.projection?.skillRuns?.get(runId) || null;
    if (existingRun?.jobId && existingRun.jobId !== prepared.job.id) {
      return sendError(res, 409, "SKILL_RUN_JOB_MISMATCH", `skill run ${runId} does not belong to ${prepared.job.id}`);
    }

    const status = prepared.body.status;
    if (typeof status !== "string" || !SKILL_RUN_FINISH_STATUSES.has(status)) {
      return sendError(
        res,
        400,
        "INVALID_BODY",
        `status must be one of: ${[...SKILL_RUN_FINISH_STATUSES].join(", ")}`,
        { allowed: [...SKILL_RUN_FINISH_STATUSES] },
      );
    }

    const skillId = prepared.skillId || existingRun?.skillId;
    if (!isValidSkillId(skillId)) {
      return sendError(res, 400, "INVALID_SKILL_ID", "skillId required unless the skill run was previously started");
    }
    if (!skillsRegistry.has(skillId)) {
      return sendError(res, 404, "UNKNOWN_SKILL", `skill not found: ${skillId}`);
    }

    const source = resolveSkillEventSource(prepared.body.source);
    if (source.error) return sendError(res, 400, "INVALID_BODY", source.error);
    const event = {
      schemaVersion: 1,
      id: makeRuntimeId("evt"),
      ts: new Date().toISOString(),
      type: "skill.run.finished",
      source: source.value,
      workspace,
      skillRunId: runId,
      skillId,
      jobId: prepared.job.id,
      sessionId: prepared.sessionId,
      status,
      ...(prepared.body.summary !== undefined ? { summary: prepared.body.summary } : {}),
      ...(prepared.body.evidence !== undefined ? { evidence: prepared.body.evidence } : {}),
    };

    const result = await appendRuntimeEvent(res, {
      event,
      runtimeStore,
      validateRuntimeEvent,
    });
    if (!result) return;
    return res.status(200).json({
      jobId: prepared.job.id,
      sessionId: prepared.sessionId,
      skillRunId: runId,
      skillId,
      status,
      eventId: result.eventId,
      rev: result.rev,
      skillRun: jobRegistry.projection?.skillRuns?.get(runId) || null,
      job: jobRegistry.get(prepared.job.id),
    });
  });

  // --- POST /api/jobs/:jobId/skill-runs/:runId/override -------------------
  app.post("/api/jobs/:jobId/skill-runs/:runId/override", ...requireToken, async (req, res) => {
    const { runId } = req.params;
    if (!isSkillRunId(runId)) {
      return sendError(res, 400, "INVALID_SKILL_RUN_ID", `not a valid skr_ id: ${runId}`);
    }
    const prepared = prepareSkillRunRequest({
      req,
      res,
      jobRegistry,
      skillsRegistry,
      allowedFields: SKILL_RUN_OVERRIDE_ALLOWED_FIELDS,
      requireBody: true,
      requireActiveJob: true,
      requireSkillId: false,
    });
    if (!prepared) return;
    if (!assertSkillRuntimeDeps(res, { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace })) return;
    const reason = prepared.body.reason;
    if (typeof reason !== "string" || reason.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`reason` is required for skill run override");
    }

    const existingRun = jobRegistry.projection?.skillRuns?.get(runId) || null;
    const skillId = prepared.skillId || existingRun?.skillId;
    if (!isValidSkillId(skillId)) {
      return sendError(res, 400, "INVALID_SKILL_ID", "skillId required unless the skill run was previously started");
    }
    if (!skillsRegistry.has(skillId)) {
      return sendError(res, 404, "UNKNOWN_SKILL", `skill not found: ${skillId}`);
    }
    const source = resolveSkillEventSource(prepared.body.source);
    if (source.error) return sendError(res, 400, "INVALID_BODY", source.error);

    const event = {
      schemaVersion: 1,
      id: makeRuntimeId("evt"),
      ts: new Date().toISOString(),
      type: "skill.run.finished",
      source: source.value,
      workspace,
      skillRunId: runId,
      skillId,
      jobId: prepared.job.id,
      sessionId: prepared.sessionId,
      status: "overridden",
      summary: prepared.body.summary || reason,
      reason,
      ...(prepared.body.user !== undefined ? { user: prepared.body.user } : {}),
      ...(prepared.body.evidence !== undefined ? { evidence: prepared.body.evidence } : {}),
    };

    const result = await appendRuntimeEvent(res, {
      event,
      runtimeStore,
      validateRuntimeEvent,
    });
    if (!result) return;
    return res.status(200).json({
      jobId: prepared.job.id,
      sessionId: prepared.sessionId,
      skillRunId: runId,
      skillId,
      status: "overridden",
      eventId: result.eventId,
      rev: result.rev,
      skillRun: jobRegistry.projection?.skillRuns?.get(runId) || null,
      job: jobRegistry.get(prepared.job.id),
    });
  });

  // --- PATCH /api/jobs/:jobId ---------------------------------------------
  // SH-5-18. Thin delegation to JobRegistry.checkpoint — reconciles §12.2's
  // generic lifecycle update with the explicit checkpoint route below.
  app.patch("/api/jobs/:jobId", ...requireToken, async (req, res) => {
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
  app.post("/api/jobs/:jobId/checkpoint", ...requireToken, async (req, res) => {
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
  app.post("/api/jobs/:jobId/complete", ...requireToken, async (req, res) => {
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
  app.post("/api/jobs/:jobId/complete-override", ...requireToken, async (req, res) => {
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
  app.post("/api/jobs/:jobId/cancel", ...requireToken, async (req, res) => {
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
  app.post("/api/jobs/:jobId/rollover", ...requireToken, async (req, res) => {
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
  app.post("/api/jobs/:jobId/unblock", ...requireToken, async (req, res) => {
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

  // --- GET /api/jobs/:jobId/skill-plan ------------------------------------
  app.get("/api/jobs/:jobId/skill-plan", (req, res) => {
    const { jobId } = req.params;
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    const job = jobRegistry.get(jobId);
    if (!job) {
      return sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
    }
    if (Array.isArray(job.skillPlan)) {
      return res.status(200).json({
        jobId,
        profileId: job.profileId,
        skillPlan: job.skillPlan,
      });
    }
    try {
      let nextId = 0;
      const skillPlan = buildSkillPlan({
        profileId: job.profileId,
        skillsRegistry,
        makeId: () => `skill_plan_${String(++nextId).padStart(3, "0")}`,
      });
      return res.status(200).json({
        jobId,
        profileId: job.profileId,
        skillPlan,
      });
    } catch (err) {
      return mapSkillPlanError(res, err);
    }
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

function sessionIdForJobMutation(req, jobRegistry) {
  const jobId = req?.params?.jobId;
  if (isJobId(jobId)) {
    const job = jobRegistry.get(jobId);
    if (typeof job?.sessionId === "string" && job.sessionId.length > 0) {
      return job.sessionId;
    }
  }
  const sessionId = req?.body?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function isValidSkillId(value) {
  return typeof value === "string" && SKILL_ID_RE.test(value);
}

function resolveSkillEventSource(value) {
  if (value === undefined || value === null || value === "") return { value: "http" };
  if (typeof value !== "string" || !SKILL_EVENT_SOURCES.has(value)) {
    return { error: `source must be one of: ${[...SKILL_EVENT_SOURCES].join(", ")}` };
  }
  return { value };
}

function assertSkillRuntimeDeps(res, deps) {
  const { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace } = deps || {};
  if (
    !runtimeStore ||
    typeof runtimeStore.append !== "function" ||
    typeof makeRuntimeId !== "function" ||
    typeof validateRuntimeEvent !== "function" ||
    typeof workspace !== "string" ||
    workspace.length === 0
  ) {
    sendError(
      res,
      501,
      "NOT_IMPLEMENTED",
      "skill-run endpoints require runtimeStore, makeRuntimeId, validateRuntimeEvent, and workspace wiring.",
    );
    return false;
  }
  return true;
}

function prepareSkillRunRequest({
  req,
  res,
  jobRegistry,
  skillsRegistry,
  allowedFields,
  requireBody,
  requireActiveJob,
  requireSkillId,
}) {
  const { jobId } = req.params;
  if (!isJobId(jobId)) {
    sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    return null;
  }
  const job = jobRegistry.get(jobId);
  if (!job) {
    sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
    return null;
  }
  if (requireActiveJob && TERMINAL_JOB_STATUS.includes(job.status)) {
    sendError(res, 409, "JOB_TERMINAL", `job '${jobId}' is terminal (${job.status})`, {
      jobId,
      status: job.status,
    });
    return null;
  }

  let body = req.body;
  if (requireBody) {
    body = requireObjectBody(req, res);
    if (body === undefined) return null;
  } else if (body === undefined || body === null) {
    body = {};
  }
  const unknown = rejectUnknownFields(body, allowedFields);
  if (unknown) {
    sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    return null;
  }

  const sessionId = body.sessionId === undefined ? job.sessionId : body.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId !== job.sessionId) {
    sendError(res, 400, "SESSION_MISMATCH", "skill run sessionId must match the job sessionId", {
      expected: job.sessionId,
      actual: sessionId,
    });
    return null;
  }

  const skillId = body.skillId;
  if (skillId !== undefined || requireSkillId) {
    if (!isValidSkillId(skillId)) {
      sendError(res, 400, "INVALID_SKILL_ID", "skillId must match ^[a-z0-9][a-z0-9_.:-]{0,127}$");
      return null;
    }
    if (!skillsRegistry.has(skillId)) {
      sendError(res, 404, "UNKNOWN_SKILL", `skill not found: ${skillId}`);
      return null;
    }
  }
  if (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length === 0)) {
    sendError(res, 400, "INVALID_BODY", "`summary` must be a non-empty string when present");
    return null;
  }
  if (body.evidence !== undefined && !Array.isArray(body.evidence)) {
    sendError(res, 400, "INVALID_BODY", "`evidence` must be an array when present");
    return null;
  }
  if (body.user !== undefined && (typeof body.user !== "string" || body.user.length === 0)) {
    sendError(res, 400, "INVALID_BODY", "`user` must be a non-empty string when present");
    return null;
  }

  return {
    job,
    body,
    sessionId,
    skillId: typeof skillId === "string" ? skillId : null,
  };
}

async function appendRuntimeEvent(res, { event, runtimeStore, validateRuntimeEvent }) {
  try {
    validateRuntimeEvent(event);
  } catch (err) {
    sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
      errors: err.errors,
    });
    return null;
  }
  const { id: _placeholderEventId, ...eventForAppend } = event;
  try {
    return await runtimeStore.append(eventForAppend);
  } catch (err) {
    sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    return null;
  }
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

function mapSkillPlanError(res, err) {
  const code = err && err.code;
  const details = err && err.details;
  switch (code) {
    case "UNKNOWN_PROFILE":
      return sendError(res, 404, "UNKNOWN_PROFILE", err.message, details);
    case "INVALID_INPUT":
      return sendError(res, 500, "SKILL_PLAN_FAILED", err.message, details);
    default:
      return sendError(res, 500, "SKILL_PLAN_FAILED", (err && err.message) || "skill plan composition failed");
  }
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
