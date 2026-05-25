// hub/run-session/service.js — SH-3-05 (TDD v0.5 §6.7, §8A.1, §11.5; PRD §6.7)
//
// RunSessionService: orchestration layer between the draft store, JobRegistry,
// RuntimeStore, and (future) ContextPackService. Every Run Session entry point
// (task card, swimlane, Hub, CLI, attach) funnels through `service.launch()`,
// which returns a `RunLaunchResult` consumed by the HTTP layer in
// hub/api/run-session.js.
//
// Out of scope:
//   - HTTP routing — hub/api/run-session.js maps results to status codes.
//   - Attention engine — DoD-2's unbound_session attention emission is
//     surfaced as `warnings: ["unbound_session"]` on the result. Wiring the
//     attention engine is deferred to a follow-up review hardening.
//   - ContextPack composition — SH-8-02 owns the composer. We try the
//     contextPackService when supplied but never fail the launch if it
//     throws NOT_IMPLEMENTED. Returned `contextPackRef` is null until then.
//   - VerifyPack persistence onto JobRecord — DONE in SH-5-04: the composed
//     pack is passed into jobRegistry.create() and re-read from the
//     projection so the launch result's `verifyPack` field is the SAME
//     frozen reference now stored immutably on the JobRecord. Later patches
//     to task.verify cannot widen or alter the in-flight pack.

import { stampVerifyPack } from "../jobs/verify-pack.js";
import { BUILT_IN_PROFILES_BY_ID } from "../jobs/profiles.js";
import { evaluateTaskClaim } from "./task-claim.js";

// Map from RunSessionDraft.runtime → SessionRecord.tier (TDD §6.1 enum).
const RUNTIME_TO_TIER = Object.freeze({
  codex_app_server: "codex_app_server",
  dumb_terminal: "dumb_terminal",
  mcp_tracked: "mcp_tracked",
  manual: "manual",
});
const DEFAULT_TIER = "manual";

// Map from JobProfile.id → JobKind. We pull from BUILT_IN_PROFILES_BY_ID when
// possible; this table is the fallback when a draft's profileId isn't a known
// built-in.
const DEFAULT_JOB_KIND = "code";

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function freezeResult(result) {
  return deepFreeze(result);
}

function isNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function packWithItemsOrNull(pack) {
  return pack && Array.isArray(pack.items) && pack.items.length > 0 ? pack : null;
}

/**
 * Derive a SessionRecord.tier from a draft. Drafts use `runtime` to hint at
 * the launcher kind; we map that to the canonical SessionRecord tier enum.
 *
 * @param {object} draft
 * @returns {string}
 */
function tierFromDraft(draft) {
  const runtime = draft && typeof draft.runtime === "string" ? draft.runtime : null;
  if (runtime && Object.prototype.hasOwnProperty.call(RUNTIME_TO_TIER, runtime)) {
    return RUNTIME_TO_TIER[runtime];
  }
  return DEFAULT_TIER;
}

/**
 * Derive a SessionRecord.name from a draft. We prefer task id (most informative
 * for task_backed drafts), fall back to project slug for untasked/attach drafts,
 * and finally to a static placeholder so a session always has a non-empty name.
 *
 * @param {object} draft
 * @returns {string}
 */
function nameFromDraft(draft) {
  if (isNonEmptyString(draft.taskId)) return draft.taskId;
  if (isNonEmptyString(draft.projectSlug)) return draft.projectSlug;
  return "untitled session";
}

/**
 * Derive a JobKind from a draft.profileId. Unknown profileId falls back to
 * "code" so the registry's INVALID_JOB_KIND error never fires for a real
 * launch — the validation surface for profileId lives one layer up.
 *
 * @param {string | undefined} profileId
 * @returns {string}
 */
function jobKindForProfile(profileId) {
  if (!isNonEmptyString(profileId)) return DEFAULT_JOB_KIND;
  const profile = BUILT_IN_PROFILES_BY_ID.get(profileId);
  return profile?.kind || DEFAULT_JOB_KIND;
}

/**
 * @typedef {object} RunSessionServiceDeps
 * @property {{ get(slug: string): { data?: object; rev?: number } | null }} store
 * @property {{ get(id: string): object | null }} draftStore
 * @property {{ sessions: Map<string, object>; toSnapshots(): object }} projection
 * @property {{ list(): object[]; create(input: object): Promise<{ jobId: string; rev: number; eventId: string; job: object | null }>; cancel(jobId: string, opts?: object): Promise<object> }} jobRegistry
 * @property {{ append(event: object): Promise<{ rev: number; eventId: string }> }} runtimeStore
 * @property {(prefix: string) => string} makeRuntimeId
 * @property {(event: object) => true} validateRuntimeEvent
 * @property {string} workspace
 * @property {() => string} [now]
 * @property {{ build(kind: string, input: object): Promise<object> }} [contextPackService]
 */

/**
 * @typedef {object} RunLaunchInput
 * @property {string} draftId
 * @property {number} [expectedTrackerRev]
 * @property {("fail_if_active"|"join"|"force")} [claimMode]
 * @property {string} [forceReason]
 * @property {string} [forceUser]
 */

/**
 * @typedef {(
 *   | { ok: true; mode: "created";  sessionId: string; jobId: string;        taskClaimed: true;  verifyPack: object | null; contextPackRef: object | null; warnings?: string[] }
 *   | { ok: true; mode: "joined";   sessionId: string; jobId: string;        taskClaimed: false; verifyPack: object | null; contextPackRef: object | null; warnings?: string[] }
 *   | { ok: true; mode: "untasked"; sessionId: string; jobId: null;          taskClaimed: false; warnings: string[] }
 *   | { ok: true; mode: "attached"; sessionId: string; jobId: string | null; taskClaimed: boolean; verifyPack: object | null; contextPackRef: object | null; warnings?: string[] }
 *   | { ok: false; error: "task_claim_conflict"; activeJobId: string }
 *   | { ok: false; error: "stale_tracker_rev"; currentRev: number }
 *   | { ok: false; error: "unknown_draft" }
 *   | { ok: false; error: "unknown_project" | "unknown_task" | "unknown_session" }
 *   | { ok: false; error: "invalid_input"; detail: string }
 * )} RunLaunchResult
 */

/**
 * Orchestrates Run Session launches. See module docblock for scope notes.
 */
export class RunSessionService {
  /**
   * @param {RunSessionServiceDeps} deps
   */
  constructor(deps) {
    const {
      store,
      draftStore,
      projection,
      jobRegistry,
      runtimeStore,
      makeRuntimeId,
      validateRuntimeEvent,
      workspace,
      contextPackService,
      now,
    } = deps || {};
    if (!store || typeof store.get !== "function") {
      throw new Error("RunSessionService: store (with get) required");
    }
    if (!draftStore || typeof draftStore.get !== "function") {
      throw new Error("RunSessionService: draftStore (with get) required");
    }
    if (!projection || !(projection.sessions instanceof Map)) {
      throw new Error("RunSessionService: projection (with sessions Map) required");
    }
    if (
      !jobRegistry ||
      typeof jobRegistry.list !== "function" ||
      typeof jobRegistry.create !== "function" ||
      typeof jobRegistry.cancel !== "function"
    ) {
      throw new Error("RunSessionService: jobRegistry (with list + create + cancel) required");
    }
    if (!runtimeStore || typeof runtimeStore.append !== "function") {
      throw new Error("RunSessionService: runtimeStore (with append) required");
    }
    if (typeof makeRuntimeId !== "function") {
      throw new Error("RunSessionService: makeRuntimeId function required");
    }
    if (typeof validateRuntimeEvent !== "function") {
      throw new Error("RunSessionService: validateRuntimeEvent function required");
    }
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("RunSessionService: workspace string required");
    }

    this.store = store;
    this.draftStore = draftStore;
    this.projection = projection;
    this.jobRegistry = jobRegistry;
    this.runtimeStore = runtimeStore;
    this.makeRuntimeId = makeRuntimeId;
    this.validateRuntimeEvent = validateRuntimeEvent;
    this.workspace = workspace;
    this.contextPackService = contextPackService || null;
    this.now = typeof now === "function" ? now : () => new Date().toISOString();
  }

  /**
   * Launch a Run Session. Routes on draft.mode and returns a frozen
   * RunLaunchResult; never throws on validation errors (returns the
   * `{ ok: false, error }` shape instead) so the HTTP layer can map cleanly.
   *
   * @param {RunLaunchInput} input
   * @returns {Promise<RunLaunchResult>}
   */
  async launch(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return freezeResult({ ok: false, error: "invalid_input", detail: "input must be an object" });
    }
    const { draftId, expectedTrackerRev, claimMode, forceReason, forceUser } = input;
    if (!isNonEmptyString(draftId)) {
      return freezeResult({ ok: false, error: "invalid_input", detail: "draftId must be a non-empty string" });
    }
    if (expectedTrackerRev !== undefined && !isNonNegativeInt(expectedTrackerRev)) {
      return freezeResult({
        ok: false,
        error: "invalid_input",
        detail: "expectedTrackerRev must be a non-negative integer when present",
      });
    }

    const draft = this.draftStore.get(draftId);
    if (!draft) {
      return freezeResult({ ok: false, error: "unknown_draft" });
    }

    if (draft.mode === "task_backed") {
      return this.#launchTaskBacked({ draft, expectedTrackerRev, claimMode, forceReason, forceUser });
    }
    if (draft.mode === "untasked") {
      return this.#launchUntasked({ draft });
    }
    if (draft.mode === "attach_existing") {
      return this.#launchAttach({ draft, expectedTrackerRev, claimMode, forceReason, forceUser });
    }
    return freezeResult({
      ok: false,
      error: "invalid_input",
      detail: `unsupported draft.mode: ${JSON.stringify(draft.mode)}`,
    });
  }

  /**
   * Build a session.started event payload for a draft. Returned event omits
   * `id` (the RuntimeStore assigns evt_ ids); validation gets an event with a
   * placeholder id so AJV's required check is satisfied.
   *
   * @param {object} draft
   * @param {{ withTaskId: boolean }} options
   * @returns {{ sessionId: string; eventForAppend: object; eventForValidation: object }}
   */
  #buildSessionStartedEvent(draft, { withTaskId }) {
    const sessionId = this.makeRuntimeId("ses");
    const sessionPayload = {
      id: sessionId,
      name: nameFromDraft(draft),
      tier: tierFromDraft(draft),
      ...(isNonEmptyString(draft.projectSlug) ? { projectSlug: draft.projectSlug } : {}),
      ...(withTaskId && isNonEmptyString(draft.taskId) ? { taskId: draft.taskId } : {}),
      ...(isNonEmptyString(draft.repoRoot) ? { repoRoot: draft.repoRoot } : {}),
      ...(isNonEmptyString(draft.cwd) ? { cwd: draft.cwd } : {}),
      ...(isNonEmptyString(draft.branch) ? { branch: draft.branch } : {}),
    };
    const eventForValidation = {
      schemaVersion: 1,
      id: this.makeRuntimeId("evt"),
      ts: this.now(),
      type: "session.started",
      source: "http",
      workspace: this.workspace,
      session: sessionPayload,
    };
    this.validateRuntimeEvent(eventForValidation);
    const { id: _evtId, ...eventForAppend } = eventForValidation;
    return { sessionId, eventForAppend, eventForValidation };
  }

  /**
   * task_backed launch (DoD 1): validate task, claim it, create session +
   * job, stamp verify pack, attempt context pack composition.
   */
  async #launchTaskBacked({ draft, expectedTrackerRev, claimMode, forceReason, forceUser }) {
    if (!isNonEmptyString(draft.projectSlug)) {
      return freezeResult({
        ok: false,
        error: "invalid_input",
        detail: "task_backed draft missing projectSlug",
      });
    }
    const project = this.store.get(draft.projectSlug);
    if (!project) {
      return freezeResult({ ok: false, error: "unknown_project" });
    }
    const tasks = Array.isArray(project.data?.tasks) ? project.data.tasks : [];
    const task = tasks.find((t) => t && t.id === draft.taskId);
    if (!task) {
      return freezeResult({ ok: false, error: "unknown_task" });
    }

    const currentTrackerRev = isNonNegativeInt(project.rev) ? project.rev : 0;
    const activeJobs = this.jobRegistry
      .list()
      .filter((job) => job.projectSlug === draft.projectSlug && job.taskId === draft.taskId);

    const claim = evaluateTaskClaim({
      projectSlug: draft.projectSlug,
      taskId: draft.taskId,
      claimMode,
      ...(expectedTrackerRev !== undefined ? { expectedTrackerRev } : {}),
      currentTrackerRev,
      activeJobs,
      ...(forceReason !== undefined ? { forceReason } : {}),
      ...(forceUser !== undefined ? { forceUser } : {}),
    });

    if (claim.ok === false) {
      if (claim.error === "stale_tracker_rev") {
        return freezeResult({ ok: false, error: "stale_tracker_rev", currentRev: claim.currentRev });
      }
      if (claim.error === "task_claim_conflict") {
        return freezeResult({ ok: false, error: "task_claim_conflict", activeJobId: claim.activeJobId });
      }
      // force_requires_reason / invalid_input from task-claim — bubble up as
      // invalid_input so the HTTP layer maps to 400 with the policy detail.
      return freezeResult({
        ok: false,
        error: "invalid_input",
        detail: claim.detail || claim.error,
      });
    }

    // Forced claim: append the override event before cancelling the active job
    // and creating the replacement so the audit record precedes mutations.
    if (claim.mode === "forced" && claim.overrideEvent) {
      const { source: _claimSource, ...overrideRest } = claim.overrideEvent;
      // task-claim emits source="system" because it lacks transport context;
      // we override to "http" because the launch is funnelled through HTTP.
      const overrideForValidation = {
        schemaVersion: 1,
        id: this.makeRuntimeId("evt"),
        ts: this.now(),
        source: "http",
        workspace: this.workspace,
        ...overrideRest,
      };
      this.validateRuntimeEvent(overrideForValidation);
      const { id: _overrideId, ...overrideForAppend } = overrideForValidation;
      await this.runtimeStore.append(overrideForAppend);
      if (isNonEmptyString(claim.activeJobId)) {
        await this.jobRegistry.cancel(claim.activeJobId, {
          source: "http",
          summary: `pre-empted by forced launch for ${draft.projectSlug}/${draft.taskId}`,
        });
      }
    }

    // Compose verify pack now that we have project + task. Empty packs are
    // legal because task.verify is optional; JobRegistry persists only
    // non-empty packs.
    const verifyPack = packWithItemsOrNull(stampVerifyPack({
      task,
      tracker: { meta: { rev: currentTrackerRev } },
      stampedAt: this.now(),
    }));

    // Create session.
    const { sessionId, eventForAppend } = this.#buildSessionStartedEvent(draft, { withTaskId: true });
    await this.runtimeStore.append(eventForAppend);

    // Create job. Joined launches attach as successor and queue behind the
    // active job. Forced launches cancel the predecessor above, then start a
    // fresh running job.
    const predecessor =
      claim.mode === "joined" && isNonEmptyString(claim.activeJobId)
        ? claim.activeJobId
        : null;
    const created = await this.jobRegistry.create({
      sessionId,
      projectSlug: draft.projectSlug,
      taskId: draft.taskId,
      profileId: isNonEmptyString(draft.profileId) ? draft.profileId : "code-implementer",
      kind: jobKindForProfile(draft.profileId),
      source: "http",
      ...(predecessor ? { predecessorJobId: predecessor } : {}),
      ...(verifyPack ? { verifyPack } : {}),
    });

    const contextPackRef = await this.#buildContextPackSafely({
      sessionId,
      jobId: created.jobId,
      draft,
    });

    // Read the pack back from the projection so the launch result and the
    // JobRecord share a single source of truth (SH-5-04 DoD line 3).
    const persistedPack = created.job?.verifyPack ?? null;

    const resultMode = claim.mode === "joined" ? "joined" : "created";
    return freezeResult({
      ok: true,
      mode: resultMode,
      sessionId,
      jobId: created.jobId,
      taskClaimed: resultMode === "created",
      verifyPack: persistedPack,
      contextPackRef,
    });
  }

  /**
   * untasked launch (DoD 2): creates a session with no JobRecord. The
   * `unbound_session` warning is the placeholder for the attention engine
   * wiring deferred to a follow-up.
   */
  async #launchUntasked({ draft }) {
    const { sessionId, eventForAppend } = this.#buildSessionStartedEvent(draft, { withTaskId: false });
    await this.runtimeStore.append(eventForAppend);
    return freezeResult({
      ok: true,
      mode: "untasked",
      sessionId,
      jobId: null,
      taskClaimed: false,
      warnings: ["unbound_session"],
    });
  }

  /**
   * attach_existing launch (DoD 3): binds a new JobRecord to an existing
   * SessionRecord. No new session.started event is emitted — the existing
   * session funnel already covered that audit step.
   */
  async #launchAttach({ draft, expectedTrackerRev, claimMode, forceReason, forceUser }) {
    const existingSessionId =
      typeof draft.attachExistingSessionId === "string"
        ? draft.attachExistingSessionId
        : typeof draft.sessionId === "string"
          ? draft.sessionId
          : null;
    if (!isNonEmptyString(existingSessionId)) {
      return freezeResult({
        ok: false,
        error: "invalid_input",
        detail: "attach_existing draft missing existing sessionId (attachExistingSessionId or sessionId)",
      });
    }
    if (!this.projection.sessions.get(existingSessionId)) {
      return freezeResult({ ok: false, error: "unknown_session" });
    }

    // RunSessionDraft schema (hub/run-session/drafts.js) forbids `taskId` on
    // non-task_backed modes, so attach drafts carry the task linkage on a
    // separate field. We accept either `attachTaskId` (preferred) or fall back
    // to no-task attach. The job + claim policy then use this surrogate.
    const attachTaskId = isNonEmptyString(draft.attachTaskId) ? draft.attachTaskId : null;

    // No task → attach with no job. Rare but legal (e.g. attaching a long-
    // running shell to an existing session for observability only).
    if (!attachTaskId) {
      return freezeResult({
        ok: true,
        mode: "attached",
        sessionId: existingSessionId,
        jobId: null,
        taskClaimed: false,
        verifyPack: null,
        contextPackRef: null,
      });
    }

    if (!isNonEmptyString(draft.projectSlug)) {
      return freezeResult({
        ok: false,
        error: "invalid_input",
        detail: "attach_existing draft with attachTaskId requires projectSlug",
      });
    }
    const project = this.store.get(draft.projectSlug);
    if (!project) {
      return freezeResult({ ok: false, error: "unknown_project" });
    }
    const tasks = Array.isArray(project.data?.tasks) ? project.data.tasks : [];
    const task = tasks.find((t) => t && t.id === attachTaskId);
    if (!task) {
      return freezeResult({ ok: false, error: "unknown_task" });
    }

    const currentTrackerRev = isNonNegativeInt(project.rev) ? project.rev : 0;
    const activeJobs = this.jobRegistry
      .list()
      .filter((job) => job.projectSlug === draft.projectSlug && job.taskId === attachTaskId);

    const claim = evaluateTaskClaim({
      projectSlug: draft.projectSlug,
      taskId: attachTaskId,
      claimMode,
      ...(expectedTrackerRev !== undefined ? { expectedTrackerRev } : {}),
      currentTrackerRev,
      activeJobs,
      ...(forceReason !== undefined ? { forceReason } : {}),
      ...(forceUser !== undefined ? { forceUser } : {}),
    });

    if (claim.ok === false) {
      if (claim.error === "stale_tracker_rev") {
        return freezeResult({ ok: false, error: "stale_tracker_rev", currentRev: claim.currentRev });
      }
      if (claim.error === "task_claim_conflict") {
        return freezeResult({ ok: false, error: "task_claim_conflict", activeJobId: claim.activeJobId });
      }
      return freezeResult({
        ok: false,
        error: "invalid_input",
        detail: claim.detail || claim.error,
      });
    }

    if (claim.mode === "forced" && claim.overrideEvent) {
      const { source: _claimSource, ...overrideRest } = claim.overrideEvent;
      const overrideForValidation = {
        schemaVersion: 1,
        id: this.makeRuntimeId("evt"),
        ts: this.now(),
        source: "http",
        workspace: this.workspace,
        ...overrideRest,
      };
      this.validateRuntimeEvent(overrideForValidation);
      const { id: _overrideId, ...overrideForAppend } = overrideForValidation;
      await this.runtimeStore.append(overrideForAppend);
      if (isNonEmptyString(claim.activeJobId)) {
        await this.jobRegistry.cancel(claim.activeJobId, {
          source: "http",
          summary: `pre-empted by forced attach for ${draft.projectSlug}/${attachTaskId}`,
        });
      }
    }

    const verifyPack = packWithItemsOrNull(stampVerifyPack({
      task,
      tracker: { meta: { rev: currentTrackerRev } },
      stampedAt: this.now(),
    }));

    const predecessor =
      claim.mode === "joined" && isNonEmptyString(claim.activeJobId)
        ? claim.activeJobId
        : null;
    const created = await this.jobRegistry.create({
      sessionId: existingSessionId,
      projectSlug: draft.projectSlug,
      taskId: attachTaskId,
      profileId: isNonEmptyString(draft.profileId) ? draft.profileId : "code-implementer",
      kind: jobKindForProfile(draft.profileId),
      source: "http",
      ...(predecessor ? { predecessorJobId: predecessor } : {}),
      ...(verifyPack ? { verifyPack } : {}),
    });

    const contextPackRef = await this.#buildContextPackSafely({
      sessionId: existingSessionId,
      jobId: created.jobId,
      draft,
    });

    // Single source of truth: prefer the pack now persisted on the JobRecord.
    const persistedPack = created.job?.verifyPack ?? null;

    return freezeResult({
      ok: true,
      mode: "attached",
      sessionId: existingSessionId,
      jobId: created.jobId,
      taskClaimed: claim.mode !== "joined",
      verifyPack: persistedPack,
      contextPackRef,
    });
  }

  /**
   * Best-effort context-pack composition. SH-8-02 owns the real composer;
   * until then we tolerate any throw (including NOT_IMPLEMENTED) and return
   * null so the launch still succeeds.
   *
   * TODO(sh-8-02): replace this try/catch with a hard requirement once the
   * ContextPackService composer ships.
   */
  async #buildContextPackSafely({ sessionId, jobId, draft }) {
    if (!this.contextPackService || typeof this.contextPackService.build !== "function") {
      return null;
    }
    try {
      const pack = await this.contextPackService.build("start", { sessionId, jobId, draft });
      return pack || null;
    } catch {
      return null;
    }
  }
}
