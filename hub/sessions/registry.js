// hub/sessions/registry.js — SH-2-01 (TDD v0.5 §6.1, §6.2, §6.6, §23.2 #29)
//
// SessionRegistry — domain service over the runtime layer for session-shaped
// CRUD. Reads flow from RuntimeProjection; mutations flow through
// RuntimeStore.append (the same chain that drives projection updates). The
// registry never mutates the projection directly.
//
// What this module is responsible for:
//   - Validating input against the v0.7 SessionRecord shape (TDD §6.1).
//   - Rejecting shapes that §23.2 #29 explicitly forbids: `activeJobIds`,
//     `boundTasks`, `now`, `spark`. These are caught at the input boundary
//     before any event is built, so they can never reach the JSONL log.
//   - Computing `tier` from a provider/adapter descriptor when the caller
//     didn't specify it (capability vector → tier mapping per §6.1, §25).
//   - Emitting `session.started` for create and `session.status` for status
//     updates / archive, with a placeholder event id stripped before append
//     so the runtime store assigns its canonical `evt_` id.
//
// What this module does NOT do:
//   - HTTP routing (lives in `hub/api/sessions.js`; SH-1-09 / SH-2-12 /
//     SH-2-23 own those routes).
//   - Persisting the full v0.7 field set into the projection. Today the
//     projection (`hub/runtime/projection.js` `handleSessionStarted`) only
//     absorbs `id, name, tier, projectSlug, taskId, status, statusSource,
//     startedAt, warnings`. The other v0.7 inputs (sandbox, ctxMax,
//     activeJobId, agent, provider, model, cwd, repoRoot, worktreePath,
//     branch) ride through the event payload (`session.*` has
//     `additionalProperties: true` in the schema) and are absorbed by
//     subsequent tasks that extend the projection: SH-2-17/18 (provider
//     adapters), SH-2-21 (ProviderThreadRef), SH-2-24 (sandbox field). The
//     registry exposes them as inputs today so the create-side contract is
//     stable; read-side fidelity grows as the projection lights up.
//   - Computing `now: {...}` or `spark: number[]`. Those are derived per
//     render by SessionTimelineService (SH-4A-02). The registry refuses to
//     accept them on input so they cannot be written into an event.

/**
 * @typedef {"dumb_terminal" | "mcp_tracked" | "codex_app_server" | "hybrid" | "manual"} SessionTier
 */

/**
 * @typedef {"readonly" | "workspace-write" | "autoedit" | "full-auto"} Sandbox
 */

/**
 * Frozen list of allowed SessionTier values. Mirrors TDD §6.1.
 * @type {readonly SessionTier[]}
 */
export const ALLOWED_TIERS = Object.freeze([
  "dumb_terminal",
  "mcp_tracked",
  "codex_app_server",
  "hybrid",
  "manual",
]);

/**
 * Frozen list of allowed sandbox values. Mirrors TDD §6.1 / §23.2 #29.
 * @type {readonly Sandbox[]}
 */
export const ALLOWED_SANDBOX = Object.freeze([
  "readonly",
  "workspace-write",
  "autoedit",
  "full-auto",
]);

/**
 * Field names that are NEVER allowed on a SessionRecord input. Per TDD §6.1
 * "Rejected shapes" / §23.2 #29 these are either pluralized variants of a
 * single-active-job invariant, or per-render derived data that has no place
 * in durable state. Any input carrying one of these keys is rejected before
 * an event is built.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_INPUT_FIELDS = Object.freeze([
  "activeJobIds",
  "boundTasks",
  "now",
  "spark",
]);

/**
 * Optional v0.7 session fields the registry threads through into the
 * `session.started.session` payload. Each is validated for shape when
 * present; absent fields are simply omitted from the event.
 *
 * @type {readonly string[]}
 */
const V07_OPTIONAL_INPUT_FIELDS = Object.freeze([
  // pre-v0.7 fields still accepted by the projection
  "projectSlug",
  "taskId",
  // v0.7 additions (TDD §6.1)
  "activeJobId",
  "queuedJobIds",
  "sandbox",
  "ctxMax",
  // session metadata accepted by the existing POST route (projection-side
  // absorption lands in later tasks; carrying them through the event payload
  // keeps the create surface stable today)
  "agent",
  "provider",
  "model",
  "cwd",
  "repoRoot",
  "worktreePath",
  "branch",
]);

/**
 * SessionRegistry-shaped error. Carries a stable `code` so HTTP / CLI / WS
 * layers can map to status codes without sniffing the message.
 *
 * @param {string} message
 * @param {string} code
 * @param {object} [details]
 * @returns {Error & { code: string; details?: object }}
 */
function makeError(message, code, details) {
  const err = /** @type {any} */ (new Error(message));
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Throw if `input` carries any of the FORBIDDEN_INPUT_FIELDS. Caller passes
 * `context` (e.g., "create" / "updateStatus") so the error message names the
 * surface that rejected the field.
 *
 * @param {unknown} input
 * @param {string} context
 * @returns {void}
 */
export function assertNoForbiddenFields(input, context) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  for (const key of FORBIDDEN_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw makeError(
        `SessionRecord rejects \`${key}\` (TDD §6.1 / §23.2 #29; ${context})`,
        "FORBIDDEN_FIELD",
        { field: key, context },
      );
    }
  }
}

/**
 * Compute a SessionTier from an adapter / provider descriptor.
 *
 * Resolution order:
 *   1. Explicit `adapter.tier` (must be one of ALLOWED_TIERS).
 *   2. `adapter.kind === "manual"` → `manual`.
 *   3. Capability vector heuristics (per §25, addendum §5):
 *      - `explicitTrackerMcp` → `mcp_tracked`.
 *      - structured event support + `rawStdio` → `hybrid`.
 *      - structured event support (no stdio) → `codex_app_server`.
 *      - otherwise → `dumb_terminal`.
 *
 * @param {object} [adapter]
 * @param {string} [adapter.tier]
 * @param {string} [adapter.kind]
 * @param {object} [adapter.capabilities]
 * @returns {SessionTier}
 */
export function computeTierFromAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") return "dumb_terminal";

  if (typeof adapter.tier === "string") {
    if (!ALLOWED_TIERS.includes(/** @type {SessionTier} */ (adapter.tier))) {
      throw makeError(
        `computeTierFromAdapter: tier '${adapter.tier}' not in ${ALLOWED_TIERS.join("|")}`,
        "INVALID_TIER",
        { allowed: [...ALLOWED_TIERS] },
      );
    }
    return /** @type {SessionTier} */ (adapter.tier);
  }

  if (adapter.kind === "manual") return "manual";

  const c = adapter.capabilities || {};
  if (c.explicitTrackerMcp === true) return "mcp_tracked";

  const structured =
    c.structuredThread === true ||
    c.structuredTurns === true ||
    c.structuredItems === true ||
    c.structuredApprovals === true;

  if (structured && c.rawStdio === true) return "hybrid";
  if (structured) return "codex_app_server";

  return "dumb_terminal";
}

const JOB_ID_RE = /^job_[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * Validate the v0.7 optional input fields against TDD §6.1 shape constraints.
 * Mutates nothing; throws on the first violation.
 *
 * @param {object} input
 * @returns {void}
 */
function assertV07FieldShapes(input) {
  if (Object.prototype.hasOwnProperty.call(input, "sandbox")) {
    if (!ALLOWED_SANDBOX.includes(input.sandbox)) {
      throw makeError(
        `sandbox '${input.sandbox}' not in ${ALLOWED_SANDBOX.join("|")}`,
        "INVALID_SANDBOX",
        { allowed: [...ALLOWED_SANDBOX] },
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "ctxMax")) {
    const v = input.ctxMax;
    if (!Number.isInteger(v) || v <= 0) {
      throw makeError(
        "ctxMax must be a positive integer",
        "INVALID_CTX_MAX",
        { value: v },
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "activeJobId")) {
    const v = input.activeJobId;
    if (typeof v !== "string" || !JOB_ID_RE.test(v)) {
      throw makeError(
        "activeJobId must be a job_ id",
        "INVALID_ACTIVE_JOB_ID",
        { value: v },
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "queuedJobIds")) {
    const v = input.queuedJobIds;
    if (!Array.isArray(v)) {
      throw makeError("queuedJobIds must be a JobId[]", "INVALID_QUEUED_JOB_IDS");
    }
    for (let i = 0; i < v.length; i += 1) {
      if (typeof v[i] !== "string" || !JOB_ID_RE.test(v[i])) {
        throw makeError(
          `queuedJobIds[${i}] must be a job_ id`,
          "INVALID_QUEUED_JOB_IDS",
          { index: i, value: v[i] },
        );
      }
    }
  }
  for (const f of ["projectSlug", "taskId", "agent", "provider", "model", "cwd", "repoRoot", "worktreePath", "branch"]) {
    if (Object.prototype.hasOwnProperty.call(input, f)) {
      if (typeof input[f] !== "string" || input[f].length === 0) {
        throw makeError(`${f} must be a non-empty string when present`, "INVALID_INPUT", { field: f });
      }
    }
  }
}

/**
 * @typedef {object} SessionRegistryDeps
 * @property {{ append: (event: object) => Promise<{ ok: true; eventId: string; rev: number }> }} runtimeStore
 * @property {{ sessions: Map<string, object>; toSnapshots(): { sessions: object[] } }} projection
 * @property {(prefix: string) => string} makeRuntimeId
 * @property {(event: object) => true} validateRuntimeEvent
 * @property {string} workspace
 * @property {() => string} [now]                ISO-8601 timestamp source (tests inject)
 */

/**
 * Domain service: session-shaped CRUD over the runtime layer.
 */
export class SessionRegistry {
  /**
   * @param {SessionRegistryDeps} deps
   */
  constructor(deps) {
    const { runtimeStore, projection, makeRuntimeId, validateRuntimeEvent, workspace, now } = deps || {};
    if (!runtimeStore || typeof runtimeStore.append !== "function") {
      throw new Error("SessionRegistry: runtimeStore (with append) required");
    }
    if (!projection || !(projection.sessions instanceof Map) || typeof projection.toSnapshots !== "function") {
      throw new Error("SessionRegistry: projection (with sessions Map + toSnapshots) required");
    }
    if (typeof makeRuntimeId !== "function") {
      throw new Error("SessionRegistry: makeRuntimeId function required");
    }
    if (typeof validateRuntimeEvent !== "function") {
      throw new Error("SessionRegistry: validateRuntimeEvent function required");
    }
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("SessionRegistry: workspace string required");
    }
    this.runtimeStore = runtimeStore;
    this.projection = projection;
    this.makeRuntimeId = makeRuntimeId;
    this.validateRuntimeEvent = validateRuntimeEvent;
    this.workspace = workspace;
    this.now = typeof now === "function" ? now : () => new Date().toISOString();
  }

  /**
   * Snapshot of every session in FIFO arrival order. Each record is a
   * read-only reference to the projection's stored object — callers must
   * treat the result as immutable.
   *
   * @returns {object[]}
   */
  list() {
    return this.projection.toSnapshots().sessions;
  }

  /**
   * Look up a session by id. Returns null when no such session exists.
   *
   * @param {string} sessionId
   * @returns {object | null}
   */
  get(sessionId) {
    if (typeof sessionId !== "string") return null;
    return this.projection.sessions.get(sessionId) || null;
  }

  /**
   * Create a new session via a `session.started` runtime event.
   *
   * Accepts a v0.7 SessionRecord input shape. Tier may be passed explicitly
   * or computed from an `adapter` capability descriptor. Forbidden fields
   * (TDD §6.1 / §23.2 #29) reject before any event is built.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {SessionTier} [input.tier]            required if `adapter` is omitted
   * @param {object}  [input.adapter]             provider/adapter descriptor for tier inference
   * @param {string}  [input.source]              RuntimeEvent.source (default "system")
   * @param {string}  [input.projectSlug]
   * @param {string}  [input.taskId]
   * @param {string}  [input.activeJobId]
   * @param {string[]} [input.queuedJobIds]
   * @param {Sandbox} [input.sandbox]
   * @param {number}  [input.ctxMax]
   * @param {string}  [input.agent]
   * @param {string}  [input.provider]
   * @param {string}  [input.model]
   * @param {string}  [input.cwd]
   * @param {string}  [input.repoRoot]
   * @param {string}  [input.worktreePath]
   * @param {string}  [input.branch]
   * @returns {Promise<{ sessionId: string; rev: number; eventId: string; session: object | null }>}
   */
  async create(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw makeError("create: input must be an object", "INVALID_INPUT");
    }
    assertNoForbiddenFields(input, "create");

    const { name, tier, adapter, source = "system" } = input;
    if (typeof name !== "string" || name.length === 0) {
      throw makeError("create: name required (non-empty string)", "INVALID_INPUT", { field: "name" });
    }

    let resolvedTier = tier;
    if (resolvedTier === undefined) {
      resolvedTier = computeTierFromAdapter(adapter);
    }
    if (!ALLOWED_TIERS.includes(/** @type {SessionTier} */ (resolvedTier))) {
      throw makeError(
        `create: tier '${resolvedTier}' not in ${ALLOWED_TIERS.join("|")}`,
        "INVALID_TIER",
        { allowed: [...ALLOWED_TIERS] },
      );
    }

    assertV07FieldShapes(input);

    const sessionId = this.makeRuntimeId("ses");
    /** @type {Record<string, any>} */
    const sessionPayload = { id: sessionId, name, tier: resolvedTier };
    for (const f of V07_OPTIONAL_INPUT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, f)) sessionPayload[f] = input[f];
    }

    // Build the event with a placeholder evt_ id so schema validation can run
    // before the store assigns the canonical id (mirrors the dance in
    // hub/api/sessions.js POST handler).
    const eventForValidation = {
      schemaVersion: 1,
      id: this.makeRuntimeId("evt"),
      ts: this.now(),
      type: "session.started",
      source,
      workspace: this.workspace,
      session: sessionPayload,
    };
    this.validateRuntimeEvent(eventForValidation);

    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
    const result = await this.runtimeStore.append(eventForAppend);
    return {
      sessionId,
      rev: result.rev,
      eventId: result.eventId,
      session: this.get(sessionId),
    };
  }

  /**
   * Update a session's activity status via a `session.status` event.
   * Rejects forbidden fields and unknown sessions.
   *
   * @param {string} sessionId
   * @param {object} input
   * @param {string} input.status            ActivityState enum value
   * @param {string} [input.comment]
   * @param {string} [input.source="system"]
   * @returns {Promise<{ rev: number; eventId: string; session: object | null }>}
   */
  async updateStatus(sessionId, input) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw makeError("updateStatus: sessionId required", "INVALID_INPUT");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw makeError("updateStatus: input must be an object", "INVALID_INPUT");
    }
    assertNoForbiddenFields(input, "updateStatus");

    const { status, comment, source = "system" } = input;
    if (typeof status !== "string" || status.length === 0) {
      throw makeError("updateStatus: status required (non-empty string)", "INVALID_INPUT", { field: "status" });
    }
    if (comment !== undefined && (typeof comment !== "string" || comment.length === 0)) {
      throw makeError("updateStatus: comment must be a non-empty string when present", "INVALID_INPUT", { field: "comment" });
    }
    if (!this.projection.sessions.get(sessionId)) {
      throw makeError(`updateStatus: unknown session '${sessionId}'`, "UNKNOWN_SESSION", { sessionId });
    }

    const eventForValidation = {
      schemaVersion: 1,
      id: this.makeRuntimeId("evt"),
      ts: this.now(),
      type: "session.status",
      source,
      workspace: this.workspace,
      sessionId,
      status,
      ...(comment ? { comment } : {}),
    };
    this.validateRuntimeEvent(eventForValidation);

    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
    const result = await this.runtimeStore.append(eventForAppend);
    return { rev: result.rev, eventId: result.eventId, session: this.get(sessionId) };
  }

  /**
   * Archive a session by emitting a `session.status` event with status
   * "archived". Convenience wrapper over `updateStatus`.
   *
   * @param {string} sessionId
   * @param {{ comment?: string; source?: string }} [opts]
   * @returns {Promise<{ rev: number; eventId: string; session: object | null }>}
   */
  async archive(sessionId, opts) {
    return this.updateStatus(sessionId, {
      status: "archived",
      ...(opts && opts.comment ? { comment: opts.comment } : {}),
      ...(opts && opts.source ? { source: opts.source } : {}),
    });
  }
}
