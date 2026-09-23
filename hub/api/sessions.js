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
//   POST  /api/sessions/:sessionId/message           — operator message to provider-backed session
//   POST  /api/sessions/:sessionId/token/rotate      — rotate session token (gated on tokenStore dep)
//   POST  /api/sessions/:sessionId/stdio/capture     — toggle stdio disk capture (gated on tokenStore dep)
//
// Error envelope: `{ error: { code, message, details? } }`.

import { log } from "../logging/index.js";
import { requireSessionToken } from "./middleware/session-token.js";
import {
  createSessionAskEvent,
  createSessionInterruptEvent,
  createSessionModelChangedEvent,
  createSessionRepoBoundEvent,
  createSessionSandboxChangedEvent,
  createSessionStdioCaptureChangedEvent,
  createSessionTaskAttachedEvent,
  createSessionTaskUnboundEvent,
  createSessionWarningEvent,
} from "../runtime/events.js";
import { isJobId } from "../runtime/ids.js";
import { SessionTaskLedgerService } from "../sessions/task-ledger.js";
import { DEFAULT_THRESHOLDS } from "../sessions/activity.js";
import { contextHighWarning } from "../sessions/warnings.js";
import { buildAttachTaskPreflight } from "../run-session/attach-preflight.js";
import { TERMINAL_JOB_STATUS } from "../jobs/registry.js";
import { BUILT_IN_PROFILES_BY_ID } from "../jobs/profiles.js";
import { buildRolloverPack } from "../context-packs/rollover.js";

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

const ATTACH_CONFIRM_ALLOWED_FIELDS = new Set([
  ...ATTACH_PREVIEW_ALLOWED_FIELDS,
  "claimMode",
  "force",
  "idempotencyKey",
]);
const BIND_TASK_ALLOWED_FIELDS = new Set([
  ...ATTACH_PREVIEW_ALLOWED_FIELDS,
  "idempotencyKey",
]);
const UNBIND_TASK_ALLOWED_FIELDS = new Set(["reason", "force", "cascadeQueued", "idempotencyKey"]);
const REPO_WORKTREE_ALLOWED_FIELDS = new Set(["repoRoot", "worktreePath", "idempotencyKey"]);
const ATTACH_CLAIM_MODES = new Set(["fail_if_active", "join", "force"]);
const ATTACH_CANCEL_ALLOWED_FIELDS = new Set(["summary", "idempotencyKey"]);
const ATTACH_REORDER_ALLOWED_FIELDS = new Set(["jobIds"]);
const RESTART_ALLOWED_FIELDS = new Set(["preset", "model", "keepCtx", "sandbox", "reason", "idempotencyKey"]);
const RESTART_QUIET_ALLOWED_FIELDS = new Set(["dryRun", "reason", "idempotencyKey"]);
const LIVE_MODEL_SWAP_ALLOWED_FIELDS = new Set(["model", "keepCtx", "idempotencyKey"]);
const INTERRUPT_ALLOWED_FIELDS = new Set(["reason", "idempotencyKey"]);
const MESSAGE_ALLOWED_FIELDS = new Set(["message", "text", "idempotencyKey"]);
const RESTART_PRESETS = new Set(["model", "sandbox"]);
const SANDBOXES = new Set(["readonly", "workspace-write", "autoedit", "full-auto"]);
const ACTIVE_JOB_STATUSES = new Set(["starting", "running", "blocked", "verifying"]);
const DEFAULT_ATTACH_PROFILE_ID = "code-implementer";

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
 * @property {{ capabilities?(providerId: string): object, swapModel?(providerId: string, threadRef: object, request: object): Promise<object>, interrupt?(providerId: string, threadRef: object): Promise<object>, steer?(providerId: string, threadRef: object, input: object): Promise<object>, send?(providerId: string, threadRef: object, input: object): Promise<object> }} [providerBroker]
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
    providerBroker,
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
  const runSerializedAttach = createPerSessionSerializer();
  const queuedAutoStarter = createQueuedAutoStarter({
    jobRegistry,
    projection,
    attach,
    runSerialized: runSerializedAttach,
  });
  if (jobRegistry && typeof jobRegistry.onJobCompleted === "function") {
    jobRegistry.onJobCompleted(({ sessionId, jobId, previousStatus }) => {
      if (ACTIVE_JOB_STATUSES.has(previousStatus)) {
        queuedAutoStarter.schedule(sessionId, jobId);
      }
    });
  }

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

  // --- POST /api/sessions/:sessionId/repo-worktree --------------------------
  app.post("/api/sessions/:sessionId/repo-worktree", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }

    const unknown = unknownFields(body, REPO_WORKTREE_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }

    const repoRoot = body.repoRoot;
    const worktreePath = body.worktreePath;
    const idempotencyKey = body.idempotencyKey;
    if (repoRoot !== undefined && (typeof repoRoot !== "string" || repoRoot.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`repoRoot` must be a non-empty string when present");
    }
    if (worktreePath !== undefined && (typeof worktreePath !== "string" || worktreePath.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`worktreePath` must be a non-empty string when present");
    }
    if (repoRoot === undefined && worktreePath === undefined) {
      return sendError(res, 400, "INVALID_BODY", "`repoRoot` or `worktreePath` is required");
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`idempotencyKey` must be a non-empty string when present");
    }

    return runSerializedAttach(sessionId, async () => {
      const session = projection.sessions.get(sessionId) || null;
      if (!session) {
        return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
      }

      let bindEvent;
      try {
        bindEvent = createSessionRepoBoundEvent({
          sessionId,
          ...(repoRoot !== undefined ? { repoRoot } : {}),
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          ...(typeof session.repoRoot === "string" ? { previousRepoRoot: session.repoRoot } : {}),
          ...(typeof session.worktreePath === "string" ? { previousWorktreePath: session.worktreePath } : {}),
          workspace,
          source: "http",
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
      } catch (err) {
        return sendError(res, 400, "INVALID_BODY", err.message || "failed to create session.repo_bound event");
      }

      let appendResult;
      try {
        appendResult = await runtimeStore.append(bindEvent);
      } catch (err) {
        return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
      }

      return res.status(200).json({
        ok: true,
        mode: "repo_worktree_bound",
        sessionId,
        session: projection.sessions.get(sessionId) || {
          ...session,
          ...(repoRoot !== undefined ? { repoRoot } : {}),
          ...(worktreePath !== undefined ? { worktreePath } : {}),
        },
        rev: appendResult.rev,
        eventId: appendResult.eventId,
      });
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

  // --- POST /api/sessions/:sessionId/attach-task --------------------------
  app.post("/api/sessions/:sessionId/attach-task", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    if (!hasAttachJobRegistry(jobRegistry)) {
      return sendError(res, 501, "ATTACH_JOB_REGISTRY_UNAVAILABLE", "attach-task confirm requires JobRegistry wiring");
    }

    const bodyOrError = validateAttachConfirmBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;

    return runSerializedAttach(sessionId, async () => {
      const session = projection.sessions.get(sessionId) || null;
      const projectSlug = body.projectSlug || session?.projectSlug || "";
      const project =
        projectSlug && store && typeof store.get === "function"
          ? store.get(projectSlug)
          : null;
      const tasks = Array.isArray(project?.data?.tasks) ? project.data.tasks : [];
      const task = tasks.find((item) => item && item.id === body.taskId) || null;
      const snapshots = projection.toSnapshots();
      const sessions = snapshots.sessions || [];
      const jobs = jobRegistry.list();

      let preflight;
      try {
        preflight = buildAttachTaskPreflight({
          sessionId,
          projectSlug,
          taskId: body.taskId,
          session,
          task,
          sessions,
          jobs,
          profileId: body.profileId,
          estBriefTokens: body.estBriefTokens,
          contextBriefTokens: body.contextBriefTokens,
          contextBudget: body.contextBudget,
          config: { attach },
        });
      } catch (err) {
        return sendError(res, 500, "ATTACH_PREFLIGHT_FAILED", err.message || "attach preflight failed");
      }
      if (preflight.hasFail) {
        return sendError(res, 409, "ATTACH_PREFLIGHT_FAILED", "attach preflight failed", { preflight });
      }

      const profileId = body.profileId || DEFAULT_ATTACH_PROFILE_ID;
      const profile = BUILT_IN_PROFILES_BY_ID.get(profileId);
      const activeJob = firstActiveJobForSession(jobRegistry, sessionId);
      const predecessorJobId = activeJob?.id || null;
      const mode = predecessorJobId ? "queued" : "started";

      let created;
      try {
        created = await jobRegistry.create({
          sessionId,
          projectSlug,
          taskId: body.taskId,
          profileId,
          kind: profile?.kind || "code",
          ...(predecessorJobId ? { predecessorJobId } : {}),
          ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
          source: "http",
        });
      } catch (err) {
        return mapAttachRegistryError(res, err);
      }

      let attachEvent;
      try {
        attachEvent = createSessionTaskAttachedEvent({
          sessionId,
          jobId: created.jobId,
          projectSlug,
          taskId: body.taskId,
          profileId,
          mode,
          ...(predecessorJobId ? { predecessorJobId } : {}),
          workspace,
          source: "http",
        });
      } catch (err) {
        return sendError(res, 400, "INVALID_BODY", err.message || "failed to create session.task_attached event");
      }

      let attachAppend;
      try {
        attachAppend = await runtimeStore.append(attachEvent);
      } catch (err) {
        return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
      }

      return res.status(201).json({
        ok: true,
        mode,
        sessionId,
        jobId: created.jobId,
        ...(predecessorJobId ? { predecessorJobId } : {}),
        job: jobRegistry.get(created.jobId) || created.job,
        session: projection.sessions.get(sessionId) || session,
        preflight,
        rev: attachAppend.rev,
        eventId: attachAppend.eventId,
        jobEventId: created.eventId,
      });
    });
  });

  // --- POST /api/sessions/:sessionId/bind-task ----------------------------
  app.post("/api/sessions/:sessionId/bind-task", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    if (!hasAttachJobRegistry(jobRegistry)) {
      return sendError(res, 501, "BIND_JOB_REGISTRY_UNAVAILABLE", "bind-task requires JobRegistry wiring");
    }

    const bodyOrError = validateBindTaskBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;

    return runSerializedAttach(sessionId, async () => {
      const session = projection.sessions.get(sessionId) || null;
      if (!session) {
        return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
      }
      const existingJobs = jobRegistry.listBySession(sessionId);
      if (session.taskId || session.activeJobId || existingJobs.length > 0) {
        return sendError(
          res,
          409,
          "SESSION_ALREADY_BOUND",
          "session already has task or job state; bind-task only creates the first JobRecord",
          {
            sessionId,
            taskId: session.taskId || null,
            activeJobId: session.activeJobId || null,
            jobIds: existingJobs.map((job) => job.id),
          },
        );
      }

      const projectSlug = body.projectSlug || session.projectSlug || "";
      const project =
        projectSlug && store && typeof store.get === "function"
          ? store.get(projectSlug)
          : null;
      const tasks = Array.isArray(project?.data?.tasks) ? project.data.tasks : [];
      const task = tasks.find((item) => item && item.id === body.taskId) || null;
      const snapshots = projection.toSnapshots();
      const sessions = snapshots.sessions || [];
      const jobs = jobRegistry.list();

      let preflight;
      try {
        preflight = buildAttachTaskPreflight({
          sessionId,
          projectSlug,
          taskId: body.taskId,
          session,
          task,
          sessions,
          jobs,
          profileId: body.profileId,
          estBriefTokens: body.estBriefTokens,
          contextBriefTokens: body.contextBriefTokens,
          contextBudget: body.contextBudget,
          config: { attach },
        });
      } catch (err) {
        return sendError(res, 500, "BIND_PREFLIGHT_FAILED", err.message || "bind-task preflight failed");
      }
      if (preflight.hasFail) {
        return sendError(res, 409, "BIND_PREFLIGHT_FAILED", "bind-task preflight failed", { preflight });
      }

      const profileId = body.profileId || DEFAULT_ATTACH_PROFILE_ID;
      const profile = BUILT_IN_PROFILES_BY_ID.get(profileId);
      let created;
      try {
        created = await jobRegistry.create({
          sessionId,
          projectSlug,
          taskId: body.taskId,
          profileId,
          kind: profile?.kind || "code",
          ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
          source: "http",
        });
      } catch (err) {
        return mapAttachRegistryError(res, err);
      }

      let attachEvent;
      try {
        attachEvent = createSessionTaskAttachedEvent({
          sessionId,
          jobId: created.jobId,
          projectSlug,
          taskId: body.taskId,
          profileId,
          mode: "started",
          workspace,
          source: "http",
        });
      } catch (err) {
        return sendError(res, 400, "INVALID_BODY", err.message || "failed to create session.task_attached event");
      }

      let attachAppend;
      try {
        attachAppend = await runtimeStore.append(attachEvent);
      } catch (err) {
        return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
      }

      return res.status(201).json({
        ok: true,
        mode: "started",
        sessionId,
        jobId: created.jobId,
        job: jobRegistry.get(created.jobId) || created.job,
        session: projection.sessions.get(sessionId) || session,
        preflight,
        rev: attachAppend.rev,
        eventId: attachAppend.eventId,
        jobEventId: created.eventId,
      });
    });
  });

  // --- POST /api/sessions/:sessionId/unbind-task --------------------------
  app.post("/api/sessions/:sessionId/unbind-task", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    if (!hasAttachJobRegistry(jobRegistry)) {
      return sendError(res, 501, "UNBIND_JOB_REGISTRY_UNAVAILABLE", "unbind-task requires JobRegistry wiring");
    }

    const bodyOrError = validateUnbindTaskBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;

    return runSerializedAttach(sessionId, async () => {
      const session = projection.sessions.get(sessionId) || null;
      if (!session) {
        return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
      }

      const sessionJobs = jobRegistry.listBySession(sessionId);
      const mirroredActiveJob =
        typeof session.activeJobId === "string" && session.activeJobId.length > 0
          ? jobRegistry.get(session.activeJobId)
          : null;
      const activeJob = mirroredActiveJob || firstActiveJobForSession(jobRegistry, sessionId);
      const previousTaskId =
        typeof session.taskId === "string" && session.taskId.length > 0
          ? session.taskId
          : typeof activeJob?.taskId === "string" && activeJob.taskId.length > 0
            ? activeJob.taskId
            : null;
      const previousActiveJobId =
        typeof session.activeJobId === "string" && session.activeJobId.length > 0
          ? session.activeJobId
          : activeJob?.id;
      if (!previousTaskId) {
        return sendError(res, 409, "SESSION_NOT_BOUND", "session has no task or active job to unbind", { sessionId });
      }

      const activeJobIsRunning = activeJob && ACTIVE_JOB_STATUSES.has(activeJob.status);
      if (activeJobIsRunning && !body.force) {
        return sendError(
          res,
          409,
          "ACTIVE_JOB_RUNNING",
          "active job is running; pass force:true to cancel it before unbinding",
          { sessionId, jobId: activeJob.id, status: activeJob.status },
        );
      }

      const cancelledJobIds = [];
      const reason = body.reason || "session task unbound";
      try {
        if (body.force && activeJobIsRunning) {
          const result = await jobRegistry.cancel(activeJob.id, {
            summary: reason,
            source: "http",
            ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:active` } : {}),
          });
          if (result.job?.id) cancelledJobIds.push(result.job.id);
        }
        if (body.force && body.cascadeQueued) {
          for (const job of sessionJobs.filter((item) => item && item.status === "queued")) {
            queuedAutoStarter.cancel(job.id);
            const result = await jobRegistry.cancel(job.id, {
              summary: reason,
              source: "http",
              ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:queued:${job.id}` } : {}),
            });
            if (result.job?.id) cancelledJobIds.push(result.job.id);
          }
        }
      } catch (err) {
        return mapAttachRegistryError(res, err);
      }

      let unboundEvent;
      try {
        unboundEvent = createSessionTaskUnboundEvent({
          sessionId,
          previousTaskId,
          ...(typeof previousActiveJobId === "string" && previousActiveJobId.length > 0
            ? { previousActiveJobId }
            : {}),
          ...(body.reason ? { reason: body.reason } : {}),
          force: body.force,
          cascadeQueued: body.cascadeQueued,
          cancelledJobIds,
          workspace,
          source: "http",
          ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:unbind` } : {}),
        });
      } catch (err) {
        return sendError(res, 400, "INVALID_BODY", err.message || "failed to create session.task_unbound event");
      }

      let appendResult;
      try {
        appendResult = await runtimeStore.append(unboundEvent);
      } catch (err) {
        return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
      }

      return res.status(200).json({
        ok: true,
        mode: "untasked",
        sessionId,
        previousTaskId,
        ...(typeof previousActiveJobId === "string" && previousActiveJobId.length > 0
          ? { previousActiveJobId }
          : {}),
        force: body.force,
        cancelledJobIds,
        session: projection.sessions.get(sessionId) || null,
        rev: appendResult.rev,
        eventId: appendResult.eventId,
      });
    });
  });

  // --- POST /api/sessions/:sessionId/queue/:jobId/cancel ------------------
  app.post("/api/sessions/:sessionId/queue/:jobId/cancel", async (req, res) => {
    const { sessionId, jobId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    if (!isJobId(jobId)) {
      return sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    }
    if (!hasAttachJobRegistry(jobRegistry)) {
      return sendError(res, 501, "ATTACH_JOB_REGISTRY_UNAVAILABLE", "queue cancel requires JobRegistry wiring");
    }
    const body = req.body || {};
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const unknown = unknownFields(body, ATTACH_CANCEL_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }
    if (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`summary` must be a non-empty string when present");
    }
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`idempotencyKey` must be a non-empty string when present");
    }

    return runSerializedAttach(sessionId, async () => {
      const job = jobRegistry.get(jobId);
      if (!job) {
        return sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
      }
      if (job.sessionId !== sessionId) {
        return sendError(res, 400, "SESSION_MISMATCH", "queued job does not belong to session", {
          expected: sessionId,
          actual: job.sessionId,
        });
      }
      if (job.status !== "queued") {
        return sendError(res, 409, "JOB_NOT_QUEUED", `job '${jobId}' is ${job.status}`, { jobId, status: job.status });
      }
      queuedAutoStarter.cancel(jobId);
      try {
        const result = await jobRegistry.cancel(jobId, {
          summary: body.summary || "cancelled from session queue",
          ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
          source: "http",
        });
        return res.status(200).json({
          ok: true,
          sessionId,
          jobId,
          job: result.job,
          session: projection.sessions.get(sessionId) || null,
          rev: result.rev,
          eventId: result.eventId,
        });
      } catch (err) {
        return mapAttachRegistryError(res, err);
      }
    });
  });

  // --- POST /api/sessions/:sessionId/queue/reorder ------------------------
  app.post("/api/sessions/:sessionId/queue/reorder", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    if (!hasAttachJobRegistry(jobRegistry)) {
      return sendError(res, 501, "ATTACH_JOB_REGISTRY_UNAVAILABLE", "queue reorder requires JobRegistry wiring");
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const unknown = unknownFields(body, ATTACH_REORDER_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }
    if (!Array.isArray(body.jobIds) || body.jobIds.some((jobId) => !isJobId(jobId))) {
      return sendError(res, 400, "INVALID_BODY", "`jobIds` must be a JobId[]");
    }

    return runSerializedAttach(sessionId, async () => {
      const queued = queuedJobsForSession(jobRegistry, projection, sessionId);
      const currentIds = queued.map((job) => job.id);
      if (!sameSet(body.jobIds, currentIds)) {
        return sendError(res, 409, "QUEUE_REORDER_MISMATCH", "`jobIds` must be a permutation of the current queued jobs", {
          expected: currentIds,
          actual: body.jobIds,
        });
      }

      const eventForValidation = {
        schemaVersion: 1,
        id: makeRuntimeId("evt"),
        ts: new Date().toISOString(),
        type: "session.task_attached",
        source: "http",
        workspace,
        sessionId,
        mode: "queue_reordered",
        queuedJobIds: body.jobIds,
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

      return res.status(200).json({
        ok: true,
        sessionId,
        queuedJobIds: body.jobIds,
        session: projection.sessions.get(sessionId) || null,
        rev: appendResult.rev,
        eventId: appendResult.eventId,
      });
    });
  });

  // --- POST /api/sessions/scope/restart-quiet ----------------------------
  app.post("/api/sessions/scope/restart-quiet", async (req, res) => {
    const bodyOrError = validateRestartQuietBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;
    const candidates = listQuietTerminalRestartCandidates(projection);
    const affected = candidates.map(restartQuietAffectedSummary);
    if (body.dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        affected,
        restarted: [],
        errors: [],
        rev: projection.rev,
      });
    }

    const restarted = [];
    const errors = [];
    for (const session of candidates) {
      let result;
      try {
        result = await runSerializedAttach(session.id, () =>
          restartQuietSession({
            sessionId: session.id,
            restart: body,
            runtimeStore,
            projection,
            makeRuntimeId,
            validateRuntimeEvent,
            workspace,
            jobRegistry,
          }),
        );
      } catch (err) {
        result = {
          error: {
            code: err?.code || "RESTART_QUIET_FAILED",
            message: err?.message || "quiet restart failed",
            ...(err?.details ? { details: err.details } : {}),
          },
        };
      }
      if (result.error) {
        errors.push({ sessionId: session.id, ...result.error });
      } else {
        restarted.push(result);
      }
    }

    const revs = restarted.map((item) => item.rev).filter((rev) => Number.isFinite(rev));
    return res.status(errors.length > 0 && restarted.length === 0 ? 500 : 200).json({
      ok: errors.length === 0,
      dryRun: false,
      affected,
      restarted,
      errors,
      rev: revs.length > 0 ? Math.max(...revs) : projection.rev,
    });
  });

  // --- POST /api/sessions/:sessionId/restart ------------------------------
  app.post("/api/sessions/:sessionId/restart", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    const bodyOrError = validateRestartBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;

    return runSerializedAttach(sessionId, async () => {
      const predecessor = projection.sessions.get(sessionId) || null;
      if (!predecessor) {
        return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
      }

      const successorSessionId = makeRuntimeId("ses");
      const successorPayload = successorSessionPayload({
        predecessor,
        successorSessionId,
        restart: body,
      });
      const rolloverPack = buildRolloverPack({
        triggerSource: "manual",
        session: predecessor,
        sessionId,
        projectSlug: predecessor.projectSlug,
        taskId: predecessor.taskId,
        reason: body.reason || restartReason(body),
        ...(body.keepCtx === false ? { advisoryHandoff: null } : {}),
      });

      const ts = new Date().toISOString();
      const startedForValidation = {
        schemaVersion: 1,
        id: makeRuntimeId("evt"),
        ts,
        type: "session.started",
        source: "http",
        workspace,
        session: successorPayload,
        idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:successor-session` : undefined,
      };
      if (!startedForValidation.idempotencyKey) delete startedForValidation.idempotencyKey;
      try {
        validateRuntimeEvent(startedForValidation);
      } catch (err) {
        return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
          errors: err.errors,
        });
      }

      let startedAppend;
      try {
        const { id: _placeholderEventId, ...startedForAppend } = startedForValidation;
        startedAppend = await runtimeStore.append(startedForAppend);
      } catch (err) {
        return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
      }

      let changedEventId = null;
      let changedRev = startedAppend.rev;
      try {
        const changedEvent = body.preset === "model"
          ? createSessionModelChangedEvent({
              sessionId: successorSessionId,
              model: body.model,
              ...(typeof predecessor.model === "string" ? { previousModel: predecessor.model } : {}),
              reason: body.reason || "restart with new model",
              workspace,
              source: "http",
              ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:model` } : {}),
            })
          : createSessionSandboxChangedEvent({
              sessionId: successorSessionId,
              sandbox: body.sandbox,
              ...(typeof predecessor.sandbox === "string" ? { previousSandbox: predecessor.sandbox } : {}),
              reason: body.reason || "restart with stricter sandbox",
              workspace,
              source: "http",
              ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:sandbox` } : {}),
            });
        const changedAppend = await runtimeStore.append(changedEvent);
        changedEventId = changedAppend.eventId;
        changedRev = changedAppend.rev;
      } catch (err) {
        return sendError(res, 500, "RESTART_CHANGE_EVENT_FAILED", err.message || "failed to append restart change event");
      }

      const predecessorStatusEvent = {
        schemaVersion: 1,
        id: makeRuntimeId("evt"),
        ts,
        type: "session.status",
        source: "http",
        workspace,
        sessionId,
        status: "rolled_over",
        successorSessionId,
        predecessorSessionId: sessionId,
        reason: body.reason || restartReason(body),
        idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:predecessor-rolled-over` : undefined,
      };
      if (!predecessorStatusEvent.idempotencyKey) delete predecessorStatusEvent.idempotencyKey;
      try {
        validateRuntimeEvent(predecessorStatusEvent);
      } catch (err) {
        return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
          errors: err.errors,
        });
      }

      let rolledOverAppend;
      try {
        const { id: _placeholderEventId, ...eventForAppend } = predecessorStatusEvent;
        rolledOverAppend = await runtimeStore.append(eventForAppend);
      } catch (err) {
        return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
      }

      let successorJob = null;
      let predecessorJob = null;
      let rolloverJobEventId = null;
      let jobEventId = null;
      if (hasRestartJobRegistry(jobRegistry) && typeof predecessor.activeJobId === "string") {
        const activeJob = jobRegistry.get(predecessor.activeJobId);
        if (activeJob && ACTIVE_JOB_STATUSES.has(activeJob.status)) {
          try {
            const created = await jobRegistry.create({
              sessionId: successorSessionId,
              projectSlug: activeJob.projectSlug || predecessor.projectSlug,
              taskId: activeJob.taskId || predecessor.taskId,
              profileId: activeJob.profileId || DEFAULT_ATTACH_PROFILE_ID,
              kind: activeJob.kind || "code",
              predecessorJobId: activeJob.id,
              ...(predecessor.worktreePath ? { worktreePath: predecessor.worktreePath } : {}),
              ...(predecessor.branch ? { branch: predecessor.branch } : {}),
              ...(activeJob.verifyPack ? { verifyPack: activeJob.verifyPack } : {}),
              source: "http",
              ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:successor-job` } : {}),
            });
            jobEventId = created.eventId;
            const rolledJob = await jobRegistry.rollOverToSuccessor(activeJob.id, {
              successorJobId: created.jobId,
              reason: body.reason || restartReason(body),
              summary: body.preset === "sandbox"
                ? "rolled over for stricter sandbox restart"
                : "rolled over for model restart",
              source: "http",
              ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:job-rollover` } : {}),
            });
            rolloverJobEventId = rolledJob.rolloverEventId;
            successorJob = rolledJob.successorJob || created.job;
            predecessorJob = rolledJob.job;
          } catch (err) {
            return mapAttachRegistryError(res, err);
          }
        }
      }

      const successor = {
        ...(projection.sessions.get(successorSessionId) || successorPayload),
        predecessorSessionId: sessionId,
        ...(body.preset === "sandbox" ? { sandbox: body.sandbox } : {}),
        ...(body.preset === "model" ? { model: body.model } : {}),
      };
      const updatedPredecessor = {
        ...(projection.sessions.get(sessionId) || predecessor),
        successorSessionId,
      };
      res.status(201).json({
        ok: true,
        preset: body.preset,
        sessionId,
        successorSessionId,
        predecessor: updatedPredecessor,
        successor,
        rolloverPack,
        pendingApprovalsCarriedOver: false,
        warnings: body.preset === "sandbox"
          ? [{ kind: "pending_approvals_not_carried_over", severity: "medium" }]
          : [],
        rev: Math.max(changedRev, rolledOverAppend.rev),
        eventId: startedAppend.eventId,
        changedEventId,
        rolledOverEventId: rolledOverAppend.eventId,
        ...(jobEventId ? { jobEventId } : {}),
        ...(rolloverJobEventId ? { rolloverJobEventId } : {}),
        ...(predecessorJob ? { predecessorJob } : {}),
        ...(successorJob ? { successorJob } : {}),
      });
    });
  });

  // --- POST /api/sessions/:sessionId/model/swap-live ----------------------
  app.post("/api/sessions/:sessionId/model/swap-live", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    const bodyOrError = validateLiveModelSwapBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;

    return runSerializedAttach(sessionId, async () => {
      const session = projection.sessions.get(sessionId) || null;
      if (!session) {
        return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
      }
      const capabilities = modelSwapCapabilities(session, providerBroker);
      if (capabilities.modelSwapMidThread !== true) {
        return sendError(
          res,
          409,
          "PROVIDER_CAPABILITY_MISSING",
          "provider does not support live mid-thread model swap",
          {
            capability: "modelSwapMidThread",
            disabledReason: "Missing providerCapabilities.modelSwapMidThread; use restart-with-new-model successor path",
            fallback: {
              endpoint: `/api/sessions/${sessionId}/restart`,
              body: { preset: "model", model: body.model, keepCtx: body.keepCtx },
            },
          },
        );
      }

      let providerResult = null;
      try {
        providerResult = await dispatchLiveModelSwap(providerBroker, session, body);
      } catch (err) {
        return mapProviderActionError(res, err, "LIVE_MODEL_SWAP_FAILED");
      }

      let changedAppend;
      try {
        changedAppend = await runtimeStore.append(createSessionModelChangedEvent({
          sessionId,
          model: body.model,
          ...(typeof session.model === "string" ? { previousModel: session.model } : {}),
          reason: liveModelSwapReason(body),
          workspace,
          source: "http",
          ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:model-swap-live` } : {}),
        }));
      } catch (err) {
        return sendError(res, 500, "MODEL_SWAP_EVENT_FAILED", err.message || "failed to append model swap event");
      }

      const updatedSession = {
        ...session,
        model: body.model,
        lastActivityAt: changedAppend.event?.ts || new Date().toISOString(),
      };
      return res.status(200).json({
        ok: true,
        mode: "live_model_swap",
        sessionId,
        model: body.model,
        previousModel: typeof session.model === "string" ? session.model : null,
        keepCtx: body.keepCtx,
        session: updatedSession,
        providerResult,
        fallback: null,
        rev: changedAppend.rev,
        eventId: changedAppend.eventId,
      });
    });
  });

  // --- POST /api/sessions/:sessionId/interrupt ----------------------------
  app.post("/api/sessions/:sessionId/interrupt", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    const bodyOrError = validateInterruptBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;

    return runSerializedAttach(sessionId, async () => {
      const session = projection.sessions.get(sessionId) || null;
      if (!session) {
        return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
      }
      const capabilities = providerCapabilitiesForSession(session, providerBroker);
      if (capabilities.turnInterrupt !== true) {
        return sendError(res, 409, "PROVIDER_CAPABILITY_MISSING", "provider does not support interrupt", {
          capability: "turnInterrupt",
          disabledReason: "Provider capability 'turnInterrupt' required",
        });
      }

      let providerResult = null;
      try {
        providerResult = await dispatchSessionInterrupt(providerBroker, session);
      } catch (err) {
        return mapProviderActionError(res, err, "SESSION_INTERRUPT_FAILED");
      }

      let interruptAppend;
      try {
        interruptAppend = await runtimeStore.append(createSessionInterruptEvent({
          sessionId,
          byUser: "operator",
          ...(body.reason ? { reason: body.reason } : {}),
          workspace,
          source: "http",
          ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:interrupt` } : {}),
        }));
      } catch (err) {
        return sendError(res, 500, "SESSION_INTERRUPT_EVENT_FAILED", err.message || "failed to append interrupt event");
      }

      return res.status(200).json({
        ok: true,
        mode: "interrupt",
        sessionId,
        reason: body.reason || null,
        providerResult,
        rev: interruptAppend.rev,
        eventId: interruptAppend.eventId,
      });
    });
  });

  // --- POST /api/sessions/:sessionId/message ------------------------------
  app.post("/api/sessions/:sessionId/message", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    const bodyOrError = validateMessageBody(req.body);
    if (bodyOrError.error) {
      return sendError(res, 400, bodyOrError.code, bodyOrError.error, bodyOrError.details);
    }
    const body = bodyOrError.value;

    return runSerializedAttach(sessionId, async () => {
      const session = projection.sessions.get(sessionId) || null;
      if (!session) {
        return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
      }
      const capabilities = sessionMessageCapabilities(session, providerBroker);
      if (!capabilities.canSend) {
        return sendError(res, 409, "PROVIDER_CAPABILITY_MISSING", "provider does not support operator messages", {
          capability: "structuredChat|turnSteer|stdinWrite",
          disabledReason: capabilities.disabledReason,
        });
      }

      let providerResult = null;
      try {
        providerResult = await dispatchSessionMessage(providerBroker, session, body, capabilities);
      } catch (err) {
        return mapProviderActionError(res, err, "SESSION_MESSAGE_FAILED");
      }
      if (providerResult?.dispatched !== true) {
        return sendError(res, 409, "PROVIDER_MESSAGE_UNAVAILABLE", providerResult?.reason || "provider message dispatch unavailable", {
          disabledReason: providerResult?.reason || "provider broker or threadRef unavailable",
        });
      }

      const eventForValidation = createSessionOperatorMessageEvent({
        sessionId,
        message: body.message,
        workspace,
        source: "http",
        id: makeRuntimeId("evt"),
        validateRuntimeEvent,
        ...(body.idempotencyKey ? { idempotencyKey: `${body.idempotencyKey}:message` } : {}),
      });
      let appendResult;
      try {
        const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
        appendResult = await runtimeStore.append(eventForAppend);
      } catch (err) {
        return sendError(res, 500, "SESSION_MESSAGE_EVENT_FAILED", err.message || "failed to append message event");
      }

      return res.status(200).json({
        ok: true,
        mode: providerResult.method,
        sessionId,
        message: {
          role: "operator",
          text: body.message,
          ts: eventForValidation.ts,
        },
        providerResult,
        rev: appendResult.rev,
        eventId: appendResult.eventId,
      });
    });
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

function hasAttachJobRegistry(jobRegistry) {
  return !!(
    jobRegistry &&
    typeof jobRegistry.create === "function" &&
    typeof jobRegistry.get === "function" &&
    typeof jobRegistry.list === "function" &&
    typeof jobRegistry.listBySession === "function" &&
    typeof jobRegistry.checkpoint === "function" &&
    typeof jobRegistry.cancel === "function"
  );
}

function unknownFields(body, allowed) {
  const unknown = [];
  for (const key of Object.keys(body || {})) {
    if (!allowed.has(key)) unknown.push(key);
  }
  return unknown;
}

function validateAttachConfirmBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_BODY", error: "request body must be a JSON object" };
  }
  const unknown = unknownFields(body, ATTACH_CONFIRM_ALLOWED_FIELDS);
  if (unknown.length > 0) {
    return {
      code: "UNKNOWN_FIELDS",
      error: `unknown body field(s): ${unknown.join(", ")}`,
      details: { unknown },
    };
  }
  const { taskId, profileId, estBriefTokens, contextBriefTokens, contextBudget, claimMode, force, idempotencyKey } = body;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return { code: "INVALID_BODY", error: "`taskId` is required (non-empty string)" };
  }
  if ("projectSlug" in body && (typeof body.projectSlug !== "string" || body.projectSlug.length === 0)) {
    return { code: "INVALID_BODY", error: "`projectSlug` must be a non-empty string when present" };
  }
  if (profileId !== undefined && (typeof profileId !== "string" || profileId.length === 0)) {
    return { code: "INVALID_BODY", error: "`profileId` must be a non-empty string when present" };
  }
  for (const [field, value] of Object.entries({ estBriefTokens, contextBriefTokens })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return { code: "INVALID_BODY", error: `\`${field}\` must be a non-negative number when present` };
    }
  }
  if (contextBudget !== undefined && (!contextBudget || typeof contextBudget !== "object" || Array.isArray(contextBudget))) {
    return { code: "INVALID_BODY", error: "`contextBudget` must be a JSON object when present" };
  }
  if (claimMode !== undefined && (typeof claimMode !== "string" || !ATTACH_CLAIM_MODES.has(claimMode))) {
    return {
      code: "INVALID_BODY",
      error: `\`claimMode\` must be one of: ${[...ATTACH_CLAIM_MODES].join(", ")}`,
      details: { allowed: [...ATTACH_CLAIM_MODES] },
    };
  }
  if (force !== undefined && typeof force !== "boolean") {
    return { code: "INVALID_BODY", error: "`force` must be a boolean when present" };
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
    return { code: "INVALID_BODY", error: "`idempotencyKey` must be a non-empty string when present" };
  }
  return { value: body };
}

function validateBindTaskBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_BODY", error: "request body must be a JSON object" };
  }
  const unknown = unknownFields(body, BIND_TASK_ALLOWED_FIELDS);
  if (unknown.length > 0) {
    return {
      code: "UNKNOWN_FIELDS",
      error: `unknown body field(s): ${unknown.join(", ")}`,
      details: { unknown },
    };
  }
  const { taskId, profileId, estBriefTokens, contextBriefTokens, contextBudget, idempotencyKey } = body;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return { code: "INVALID_BODY", error: "`taskId` is required (non-empty string)" };
  }
  if ("projectSlug" in body && (typeof body.projectSlug !== "string" || body.projectSlug.length === 0)) {
    return { code: "INVALID_BODY", error: "`projectSlug` must be a non-empty string when present" };
  }
  if (profileId !== undefined && (typeof profileId !== "string" || profileId.length === 0)) {
    return { code: "INVALID_BODY", error: "`profileId` must be a non-empty string when present" };
  }
  for (const [field, value] of Object.entries({ estBriefTokens, contextBriefTokens })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return { code: "INVALID_BODY", error: `\`${field}\` must be a non-negative number when present` };
    }
  }
  if (contextBudget !== undefined && (!contextBudget || typeof contextBudget !== "object" || Array.isArray(contextBudget))) {
    return { code: "INVALID_BODY", error: "`contextBudget` must be a JSON object when present" };
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
    return { code: "INVALID_BODY", error: "`idempotencyKey` must be a non-empty string when present" };
  }
  return { value: body };
}

function validateUnbindTaskBody(body) {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_BODY", error: "request body must be a JSON object" };
  }
  const unknown = unknownFields(body, UNBIND_TASK_ALLOWED_FIELDS);
  if (unknown.length > 0) {
    return {
      code: "UNKNOWN_FIELDS",
      error: `unknown body field(s): ${unknown.join(", ")}`,
      details: { unknown },
    };
  }
  const { reason, force = false, cascadeQueued = false, idempotencyKey } = body;
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    return { code: "INVALID_BODY", error: "`reason` must be a non-empty string when present" };
  }
  if (force !== undefined && typeof force !== "boolean") {
    return { code: "INVALID_BODY", error: "`force` must be a boolean when present" };
  }
  if (cascadeQueued !== undefined && typeof cascadeQueued !== "boolean") {
    return { code: "INVALID_BODY", error: "`cascadeQueued` must be a boolean when present" };
  }
  if (cascadeQueued && !force) {
    return { code: "INVALID_BODY", error: "`cascadeQueued` requires force:true" };
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
    return { code: "INVALID_BODY", error: "`idempotencyKey` must be a non-empty string when present" };
  }
  return {
    value: {
      ...(reason ? { reason } : {}),
      force,
      cascadeQueued,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function validateRestartBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_BODY", error: "request body must be a JSON object" };
  }
  const unknown = unknownFields(body, RESTART_ALLOWED_FIELDS);
  if (unknown.length > 0) {
    return {
      code: "UNKNOWN_FIELDS",
      error: `unknown body field(s): ${unknown.join(", ")}`,
      details: { unknown },
    };
  }
  const { preset, model, keepCtx = true, sandbox, reason, idempotencyKey } = body;
  if (typeof preset !== "string" || !RESTART_PRESETS.has(preset)) {
    return {
      code: "INVALID_BODY",
      error: `\`preset\` must be one of: ${[...RESTART_PRESETS].join(", ")}`,
      details: { allowed: [...RESTART_PRESETS] },
    };
  }
  if (preset === "model" && (typeof model !== "string" || model.length === 0)) {
    return { code: "INVALID_BODY", error: "`model` is required for preset:model" };
  }
  if (preset === "sandbox" && (typeof sandbox !== "string" || !SANDBOXES.has(sandbox))) {
    return {
      code: "INVALID_BODY",
      error: `\`sandbox\` must be one of: ${[...SANDBOXES].join(", ")}`,
      details: { allowed: [...SANDBOXES] },
    };
  }
  if (keepCtx !== undefined && typeof keepCtx !== "boolean") {
    return { code: "INVALID_BODY", error: "`keepCtx` must be a boolean when present" };
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    return { code: "INVALID_BODY", error: "`reason` must be a non-empty string when present" };
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
    return { code: "INVALID_BODY", error: "`idempotencyKey` must be a non-empty string when present" };
  }
  return {
    value: {
      preset,
      ...(preset === "model" ? { model } : {}),
      ...(preset === "sandbox" ? { sandbox } : {}),
      keepCtx,
      ...(reason ? { reason } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function validateRestartQuietBody(body) {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_BODY", error: "request body must be a JSON object" };
  }
  const unknown = unknownFields(body, RESTART_QUIET_ALLOWED_FIELDS);
  if (unknown.length > 0) {
    return {
      code: "UNKNOWN_FIELDS",
      error: `unknown body field(s): ${unknown.join(", ")}`,
      details: { unknown },
    };
  }
  const { dryRun = false, reason, idempotencyKey } = body;
  if (typeof dryRun !== "boolean") {
    return { code: "INVALID_BODY", error: "`dryRun` must be a boolean when present" };
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    return { code: "INVALID_BODY", error: "`reason` must be a non-empty string when present" };
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
    return { code: "INVALID_BODY", error: "`idempotencyKey` must be a non-empty string when present" };
  }
  return {
    value: {
      dryRun,
      ...(reason ? { reason } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function validateLiveModelSwapBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_BODY", error: "request body must be a JSON object" };
  }
  const unknown = unknownFields(body, LIVE_MODEL_SWAP_ALLOWED_FIELDS);
  if (unknown.length > 0) {
    return {
      code: "UNKNOWN_FIELDS",
      error: `unknown body field(s): ${unknown.join(", ")}`,
      details: { unknown },
    };
  }
  const { model, keepCtx = true, idempotencyKey } = body;
  if (typeof model !== "string" || model.length === 0) {
    return { code: "INVALID_BODY", error: "`model` is required (non-empty string)" };
  }
  if (keepCtx !== undefined && typeof keepCtx !== "boolean") {
    return { code: "INVALID_BODY", error: "`keepCtx` must be a boolean when present" };
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
    return { code: "INVALID_BODY", error: "`idempotencyKey` must be a non-empty string when present" };
  }
  return {
    value: {
      model,
      keepCtx,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function validateInterruptBody(body) {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_BODY", error: "request body must be a JSON object" };
  }
  const unknown = unknownFields(body, INTERRUPT_ALLOWED_FIELDS);
  if (unknown.length > 0) {
    return {
      code: "UNKNOWN_FIELDS",
      error: `unknown body field(s): ${unknown.join(", ")}`,
      details: { unknown },
    };
  }
  const { reason, idempotencyKey } = body;
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    return { code: "INVALID_BODY", error: "`reason` must be a non-empty string when present" };
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
    return { code: "INVALID_BODY", error: "`idempotencyKey` must be a non-empty string when present" };
  }
  return {
    value: {
      ...(reason ? { reason } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function successorSessionPayload({ predecessor, successorSessionId, restart }) {
  const session = {
    id: successorSessionId,
    name: restart.preset === "model"
      ? `${predecessor.name || "Session"} - Restart with new model`
      : `${predecessor.name || "Session"} - Restart with stricter sandbox`,
    tier: predecessor.tier || "manual",
    predecessorSessionId: predecessor.id,
  };
  for (const field of POST_OPTIONAL_STRING_FIELDS) {
    if (typeof predecessor[field] === "string" && predecessor[field].length > 0) {
      session[field] = predecessor[field];
    }
  }
  if (restart.preset === "model") session.model = restart.model;
  if (restart.preset === "sandbox") session.sandbox = restart.sandbox;
  return session;
}

function quietRestartSuccessorSessionPayload({ predecessor, successorSessionId }) {
  const session = {
    id: successorSessionId,
    name: `${predecessor.name || "Session"} - Restart after quiet terminal`,
    tier: predecessor.tier || "manual",
    predecessorSessionId: predecessor.id,
  };
  for (const field of POST_OPTIONAL_STRING_FIELDS) {
    if (typeof predecessor[field] === "string" && predecessor[field].length > 0) {
      session[field] = predecessor[field];
    }
  }
  if (typeof predecessor.sandbox === "string" && predecessor.sandbox.length > 0) {
    session.sandbox = predecessor.sandbox;
  }
  return session;
}

function restartReason(body) {
  return body.preset === "sandbox"
    ? "restart with stricter sandbox"
    : "restart with new model";
}

function liveModelSwapReason(body) {
  return body.keepCtx === false
    ? "live model swap with re-seeded context"
    : "live model swap";
}

function validateMessageBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "request body must be a JSON object", code: "INVALID_BODY" };
  }
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (!MESSAGE_ALLOWED_FIELDS.has(key)) unknown.push(key);
  }
  if (unknown.length > 0) {
    return {
      error: `unknown body field(s): ${unknown.join(", ")}`,
      code: "UNKNOWN_FIELDS",
      details: { unknown },
    };
  }
  const message = stringOrNull(body.message) || stringOrNull(body.text);
  if (!message) {
    return { error: "`message` is required (non-empty string)", code: "INVALID_BODY" };
  }
  if (body.idempotencyKey !== undefined && !stringOrNull(body.idempotencyKey)) {
    return { error: "`idempotencyKey` must be a non-empty string when present", code: "INVALID_BODY" };
  }
  return {
    value: {
      message,
      ...(stringOrNull(body.idempotencyKey) ? { idempotencyKey: stringOrNull(body.idempotencyKey) } : {}),
    },
  };
}

function modelSwapCapabilities(session, providerBroker) {
  return providerCapabilitiesForSession(session, providerBroker);
}

function providerCapabilitiesForSession(session, providerBroker) {
  if (session && typeof session.providerCapabilities === "object" && !Array.isArray(session.providerCapabilities)) {
    return session.providerCapabilities;
  }
  const providerId = providerIdForSession(session);
  if (providerId && providerBroker && typeof providerBroker.capabilities === "function") {
    try {
      const caps = providerBroker.capabilities(providerId);
      if (caps && typeof caps === "object" && !Array.isArray(caps)) return caps;
    } catch {
      return {};
    }
  }
  return {};
}

async function dispatchLiveModelSwap(providerBroker, session, body) {
  const providerId = providerIdForSession(session);
  const threadRef = threadRefForSession(session);
  const request = liveModelSwapProviderRequest(session, body);
  if (!providerBroker || !providerId || !threadRef) {
    return { dispatched: false, reason: "provider broker or threadRef unavailable", request };
  }
  if (typeof providerBroker.swapModel === "function") {
    const result = await providerBroker.swapModel(providerId, threadRef, request);
    return { dispatched: true, method: "swapModel", result: result || null, request };
  }
  if (typeof providerBroker.send === "function") {
    const result = await providerBroker.send(providerId, threadRef, request.instruction);
    return { dispatched: true, method: "send", result: result || null, request };
  }
  return { dispatched: false, reason: "provider broker does not expose swapModel or send", request };
}

async function dispatchSessionInterrupt(providerBroker, session) {
  const providerId = providerIdForSession(session);
  const threadRef = threadRefForSession(session);
  if (!providerBroker || !providerId || !threadRef) {
    return { dispatched: false, reason: "provider broker or threadRef unavailable" };
  }
  if (typeof providerBroker.interrupt === "function") {
    const result = await providerBroker.interrupt(providerId, threadRef);
    return { dispatched: true, method: "interrupt", result: result || null };
  }
  return { dispatched: false, reason: "provider broker does not expose interrupt" };
}

function sessionMessageCapabilities(session, providerBroker) {
  const capabilities = providerCapabilitiesForSession(session, providerBroker);
  const structured =
    capabilities.structuredChat === true ||
    capabilities.turnSteer === true;
  const stdin = capabilities.stdinWrite === true;
  const canSend = structured || stdin;
  const reasons = [];
  if (!canSend) reasons.push("missing structuredChat, turnSteer, or stdinWrite capability");
  if (!providerBroker) reasons.push("provider broker unavailable");
  if (!providerIdForSession(session)) reasons.push("providerId unavailable");
  if (!threadRefForSession(session)) reasons.push("provider thread unavailable");
  return {
    capabilities,
    structured,
    stdin,
    canSend: canSend && reasons.length === 0,
    disabledReason: reasons.join("; ") || "",
  };
}

async function dispatchSessionMessage(providerBroker, session, body, messageCapabilities) {
  const providerId = providerIdForSession(session);
  const threadRef = threadRefForSession(session);
  const text = body.message;
  if (!providerBroker || !providerId || !threadRef) {
    return { dispatched: false, reason: "provider broker or threadRef unavailable" };
  }

  if ((messageCapabilities.structured || messageCapabilities.stdin) && typeof providerBroker.send === "function") {
    const input = {
      text: messageCapabilities.stdin && !text.endsWith("\n") ? `${text}\n` : text,
      message: text,
      prompt: text,
      userInitiated: true,
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    };
    const result = await providerBroker.send(providerId, threadRef, input);
    return { dispatched: true, method: "send", result: result || null, request: { ...input, text } };
  }

  if (messageCapabilities.structured && typeof providerBroker.steer === "function") {
    try {
      const request = {
        message: text,
        prompt: text,
        userInitiated: true,
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      };
      const result = await providerBroker.steer(providerId, threadRef, request);
      return { dispatched: true, method: "steer", result: result || null, request };
    } catch (err) {
      if (!messageCapabilities.stdin || typeof providerBroker.send !== "function") throw err;
    }
  }

  return { dispatched: false, reason: "provider broker does not expose steer or send" };
}

function createSessionOperatorMessageEvent({ sessionId, message, workspace, source = "http", id, idempotencyKey, validateRuntimeEvent }) {
  const event = {
    schemaVersion: 1,
    id,
    ts: new Date().toISOString(),
    type: "session.output",
    source,
    workspace,
    sessionId,
    stream: "structured",
    bytes: Buffer.byteLength(message, "utf8"),
    preview: message.slice(0, 240),
    kind: "message",
    role: "operator",
    text: message,
    message,
  };
  if (idempotencyKey) event.idempotencyKey = idempotencyKey;
  validateRuntimeEvent(event);
  return event;
}

function providerIdForSession(session) {
  if (!session || typeof session !== "object") return null;
  return stringOrNull(session.providerId) || stringOrNull(session.provider) || null;
}

function threadRefForSession(session) {
  if (!session || typeof session !== "object") return null;
  const rawRef = session.threadRef && typeof session.threadRef === "object" && !Array.isArray(session.threadRef)
    ? { ...session.threadRef }
    : session.providerThread && typeof session.providerThread === "object" && !Array.isArray(session.providerThread)
      ? { ...session.providerThread }
      : {};
  const threadId = stringOrNull(rawRef.threadId) ||
    stringOrNull(rawRef.id) ||
    stringOrNull(session.threadId) ||
    stringOrNull(session.providerThreadId);
  if (!threadId) return null;
  return {
    ...rawRef,
    threadId,
    ...(providerIdForSession(session) ? { providerId: providerIdForSession(session) } : {}),
  };
}

function liveModelSwapProviderRequest(session, body) {
  const instruction = body.keepCtx === false
    ? {
        kind: "model_swap_reseed",
        role: "system",
        model: body.model,
        keepCtx: false,
        content: "Switch model and re-seed this thread using only the task brief and changed-since context pack.",
        reseed: {
          ...(typeof session.projectSlug === "string" ? { projectSlug: session.projectSlug } : {}),
          ...(typeof session.taskId === "string" ? { taskId: session.taskId } : {}),
          contextPack: "task_brief_changed_since",
        },
      }
    : {
        kind: "model_swap_system_note",
        role: "system",
        model: body.model,
        keepCtx: true,
        content: `Switch to model ${body.model} and continue this existing thread.`,
      };
  return {
    model: body.model,
    keepCtx: body.keepCtx,
    instruction,
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
  };
}

function listQuietTerminalRestartCandidates(projection) {
  if (!projection?.sessions || !(projection.sessions instanceof Map)) return [];
  return [...projection.sessions.values()].filter(isQuietTerminalRestartCandidate);
}

function isQuietTerminalRestartCandidate(session) {
  return Boolean(
    session &&
      session.status === "quiet" &&
      Array.isArray(session.warnings) &&
      session.warnings.some((warning) => warning && warning.kind === "quiet_terminal"),
  );
}

function restartQuietAffectedSummary(session) {
  return {
    sessionId: session.id,
    name: typeof session.name === "string" ? session.name : null,
    status: session.status,
    warningKinds: Array.isArray(session.warnings)
      ? session.warnings.map((warning) => warning?.kind).filter((kind) => typeof kind === "string")
      : [],
    ...(typeof session.projectSlug === "string" ? { projectSlug: session.projectSlug } : {}),
    ...(typeof session.taskId === "string" ? { taskId: session.taskId } : {}),
    ...(typeof session.activeJobId === "string" ? { activeJobId: session.activeJobId } : {}),
  };
}

async function restartQuietSession({
  sessionId,
  restart,
  runtimeStore,
  projection,
  makeRuntimeId,
  validateRuntimeEvent,
  workspace,
  jobRegistry,
}) {
  const predecessor = projection.sessions.get(sessionId) || null;
  if (!isQuietTerminalRestartCandidate(predecessor)) {
    return {
      error: {
        code: "SESSION_OUT_OF_SCOPE",
        message: "session no longer matches quiet_terminal restart scope",
      },
    };
  }

  const successorSessionId = makeRuntimeId("ses");
  const successorPayload = quietRestartSuccessorSessionPayload({
    predecessor,
    successorSessionId,
  });
  const reason = restart.reason || "restart quiet terminal session";
  const idempotencyPrefix = restart.idempotencyKey
    ? `${restart.idempotencyKey}:${sessionId}`
    : null;
  const rolloverPack = buildRolloverPack({
    triggerSource: "quiet_terminal",
    session: predecessor,
    sessionId,
    projectSlug: predecessor.projectSlug,
    taskId: predecessor.taskId,
    reason,
  });

  const ts = new Date().toISOString();
  const startedForValidation = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts,
    type: "session.started",
    source: "http",
    workspace,
    session: successorPayload,
    idempotencyKey: idempotencyPrefix ? `${idempotencyPrefix}:successor-session` : undefined,
  };
  if (!startedForValidation.idempotencyKey) delete startedForValidation.idempotencyKey;
  const startedAppend = await appendValidatedRuntimeEvent({
    runtimeStore,
    validateRuntimeEvent,
    eventForValidation: startedForValidation,
  });

  const predecessorStatusEvent = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts,
    type: "session.status",
    source: "http",
    workspace,
    sessionId,
    status: "rolled_over",
    successorSessionId,
    predecessorSessionId: sessionId,
    reason,
    idempotencyKey: idempotencyPrefix ? `${idempotencyPrefix}:predecessor-rolled-over` : undefined,
  };
  if (!predecessorStatusEvent.idempotencyKey) delete predecessorStatusEvent.idempotencyKey;
  const rolledOverAppend = await appendValidatedRuntimeEvent({
    runtimeStore,
    validateRuntimeEvent,
    eventForValidation: predecessorStatusEvent,
  });

  let successorJob = null;
  let predecessorJob = null;
  let rolloverJobEventId = null;
  let jobEventId = null;
  if (hasRestartJobRegistry(jobRegistry) && typeof predecessor.activeJobId === "string") {
    const activeJob = jobRegistry.get(predecessor.activeJobId);
    if (activeJob && ACTIVE_JOB_STATUSES.has(activeJob.status)) {
      const created = await jobRegistry.create({
        sessionId: successorSessionId,
        projectSlug: activeJob.projectSlug || predecessor.projectSlug,
        taskId: activeJob.taskId || predecessor.taskId,
        profileId: activeJob.profileId || DEFAULT_ATTACH_PROFILE_ID,
        kind: activeJob.kind || "code",
        predecessorJobId: activeJob.id,
        ...(predecessor.worktreePath ? { worktreePath: predecessor.worktreePath } : {}),
        ...(predecessor.branch ? { branch: predecessor.branch } : {}),
        ...(activeJob.verifyPack ? { verifyPack: activeJob.verifyPack } : {}),
        source: "http",
        ...(idempotencyPrefix ? { idempotencyKey: `${idempotencyPrefix}:successor-job` } : {}),
      });
      jobEventId = created.eventId;
      const rolledJob = await jobRegistry.rollOverToSuccessor(activeJob.id, {
        successorJobId: created.jobId,
        reason,
        summary: "rolled over for quiet terminal restart",
        source: "http",
        ...(idempotencyPrefix ? { idempotencyKey: `${idempotencyPrefix}:job-rollover` } : {}),
      });
      rolloverJobEventId = rolledJob.rolloverEventId;
      successorJob = rolledJob.successorJob || created.job;
      predecessorJob = rolledJob.job;
    }
  }

  const successor = {
    ...(projection.sessions.get(successorSessionId) || successorPayload),
    predecessorSessionId: sessionId,
  };
  const updatedPredecessor = {
    ...(projection.sessions.get(sessionId) || predecessor),
    successorSessionId,
  };
  return {
    sessionId,
    successorSessionId,
    predecessor: updatedPredecessor,
    successor,
    rolloverPack,
    rev: Math.max(startedAppend.rev, rolledOverAppend.rev),
    eventId: startedAppend.eventId,
    rolledOverEventId: rolledOverAppend.eventId,
    ...(jobEventId ? { jobEventId } : {}),
    ...(rolloverJobEventId ? { rolloverJobEventId } : {}),
    ...(predecessorJob ? { predecessorJob } : {}),
    ...(successorJob ? { successorJob } : {}),
  };
}

async function appendValidatedRuntimeEvent({ runtimeStore, validateRuntimeEvent, eventForValidation }) {
  try {
    validateRuntimeEvent(eventForValidation);
  } catch (err) {
    const error = new Error(err.message || "event failed schema validation");
    error.code = "INVALID_BODY";
    error.details = { errors: err.errors };
    throw error;
  }
  const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
  return runtimeStore.append(eventForAppend);
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasRestartJobRegistry(jobRegistry) {
  return Boolean(
    hasAttachJobRegistry(jobRegistry) &&
    typeof jobRegistry.rollOverToSuccessor === "function",
  );
}

function firstActiveJobForSession(jobRegistry, sessionId) {
  const jobs = jobRegistry
    .listBySession(sessionId)
    .filter((job) => job && ACTIVE_JOB_STATUSES.has(job.status));
  if (jobs.length === 0) return null;
  jobs.sort(compareJobActivityOrder);
  return jobs[0];
}

function queuedJobsForSession(jobRegistry, projection, sessionId) {
  if (!hasAttachJobRegistry(jobRegistry)) return [];
  const all = jobRegistry.listBySession(sessionId).filter((job) => job && job.status === "queued");
  const byId = new Map(all.map((job) => [job.id, job]));
  const session = projection?.sessions?.get(sessionId) || null;
  const out = [];
  if (Array.isArray(session?.queuedJobIds)) {
    for (const jobId of session.queuedJobIds) {
      const job = byId.get(jobId);
      if (job && !out.some((item) => item.id === job.id)) out.push(job);
    }
  }
  const rest = all
    .filter((job) => !out.some((item) => item.id === job.id))
    .sort(compareJobActivityOrder);
  return [...out, ...rest];
}

function compareJobActivityOrder(a, b) {
  const aAt = a.startedAt || a.queuedAt || "";
  const bAt = b.startedAt || b.queuedAt || "";
  if (aAt < bAt) return -1;
  if (aAt > bAt) return 1;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const seen = new Set(a);
  if (seen.size !== a.length) return false;
  return b.every((item) => seen.has(item));
}

function createQueuedAutoStarter({ jobRegistry, projection, attach, runSerialized }) {
  const timers = new Map();
  const rawGrace = attach?.autoStartQueuedOnCompletionGraceSec;
  const graceSec = Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : 5;
  const delayMs = Math.max(0, Math.round(graceSec * 1000));

  function cancel(jobId) {
    const timer = timers.get(jobId);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(jobId);
  }

  function schedule(sessionId, predecessorJobId) {
    if (!isSessionIdShape(sessionId) || !hasAttachJobRegistry(jobRegistry)) return;
    const queued = queuedJobsForSession(jobRegistry, projection, sessionId)[0];
    if (!queued || timers.has(queued.id)) return;
    const timer = setTimeout(() => {
      timers.delete(queued.id);
      runSerialized(sessionId, async () => {
        const current = jobRegistry.get(queued.id);
        if (!current || current.status !== "queued") return;
        const firstQueued = queuedJobsForSession(jobRegistry, projection, sessionId)[0];
        if (!firstQueued || firstQueued.id !== current.id) return;
        if (firstActiveJobForSession(jobRegistry, sessionId)) return;
        if (current.predecessorJobId) {
          const predecessor = jobRegistry.get(current.predecessorJobId);
          if (predecessor && !TERMINAL_JOB_STATUS.includes(predecessor.status)) return;
        } else if (predecessorJobId) {
          const predecessor = jobRegistry.get(predecessorJobId);
          if (predecessor && !TERMINAL_JOB_STATUS.includes(predecessor.status)) return;
        }
        try {
          await jobRegistry.checkpoint(current.id, {
            status: "running",
            summary: "auto-start queued task after predecessor completed",
            source: "system",
          });
        } catch {
          // Timer callbacks cannot report through the original HTTP response.
          // The job remains queued; a later completion or manual action can
          // retry through the same public endpoints.
        }
      }).catch(() => {});
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    timers.set(queued.id, timer);
  }

  return { cancel, schedule };
}

function mapAttachRegistryError(res, err) {
  const code = err?.code || "JOB_REGISTRY_FAILED";
  if (code === "UNKNOWN_JOB" || code === "UNKNOWN_PREDECESSOR") {
    return sendError(res, 404, code, err.message || "job not found", err.details);
  }
  if (code === "JOB_TERMINAL" || code === "INVALID_JOB_STATE") {
    return sendError(res, 409, code, err.message || "job state conflict", err.details);
  }
  if (String(code).startsWith("INVALID") || code === "TERMINAL_STATUS_FORBIDDEN") {
    return sendError(res, 400, code, err.message || "invalid job registry input", err.details);
  }
  return sendError(res, 500, code, err?.message || "job registry failed", err?.details);
}

function mapProviderActionError(res, err, fallbackCode) {
  const code = err?.code || fallbackCode || "PROVIDER_ACTION_FAILED";
  if (code === "PROVIDER_OPERATION_NOT_SUPPORTED" || code === "PROVIDER_NOT_FOUND") {
    return sendError(res, 501, code, err.message || "provider action is not implemented", err.details);
  }
  if (String(code).startsWith("PROVIDER_INVALID") || String(code).startsWith("INVALID")) {
    return sendError(res, 400, code, err.message || "invalid provider action request", err.details);
  }
  return sendError(res, 500, code, err?.message || "provider action failed", err?.details);
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
