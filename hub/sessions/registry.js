// hub/sessions/registry.js — SH-2-01 (TDD v0.5 §6.1, §6.2, §6.6, §23.2 #29)
//                            SH-2-21 (addendum §7 — ProviderThreadRef +
//                                    ProviderCapabilities on input surface)
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
//     projection (`hub/runtime/projection.js` `handleSessionStarted`) absorbs
//     the current card-facing subset (`id, name, tier, projectSlug, taskId,
//     agent, provider, model, cwd, repoRoot, worktreePath, branch, status,
//     statusSource, startedAt, warnings`). The other v0.7 inputs (sandbox,
//     ctxMax, activeJobId, providerThread, providerCapabilities) ride through
//     the event payload (`session.*` has `additionalProperties: true` in the
//     schema) and are absorbed by subsequent tasks that extend the projection:
//     SH-2-17/18 (provider adapters absorb providerThread /
//     providerCapabilities via `session.provider.*` events), SH-2-24
//     (sandbox field). The registry exposes them as inputs today so the
//     create-side contract is stable; read-side fidelity grows as the
//     projection lights up.
//   - Computing `now: {...}` or `spark: number[]`. Those are derived per
//     render by SessionTimelineService (SH-4A-02). The registry refuses to
//     accept them on input so they cannot be written into an event.

import { validateProviderCapabilities } from "../providers/capabilities.js";
import { isSessionId } from "../runtime/ids.js";

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
  "predecessorSessionId",
  "successorSessionId",
  // v0.7 addendum §7: runtime-only ProviderThreadRef + ProviderCapabilities.
  // Ride through the event payload (additionalProperties: true) — never
  // written into durable tracker JSON. Projection absorption is deferred to
  // SH-2-17/SH-2-18 (provider adapters that drive `session.provider.*`).
  "providerThread",
  "providerCapabilities",
]);

/**
 * Allowed transports on a ProviderThreadRef (addendum §7).
 * @type {readonly ("stdio"|"unix"|"websocket"|"pty"|"manual")[]}
 */
const PROVIDER_THREAD_TRANSPORTS = Object.freeze([
  "stdio",
  "unix",
  "websocket",
  "pty",
  "manual",
]);

/**
 * Optional string-typed fields on ProviderThreadRef (addendum §7). When
 * present each must be a non-empty string.
 * @type {readonly string[]}
 */
const PROVIDER_THREAD_OPTIONAL_STRING_FIELDS = Object.freeze([
  "threadId",
  "turnId",
  "processHandleId",
  "providerSessionId",
  "cwd",
  "repoRoot",
  "worktreePath",
  "branch",
  "model",
  "resumedFromThreadId",
  "forkedFromThreadId",
  "schemaVersion",
]);

const PROVIDER_THREAD_ALL_KEYS = new Set([
  "providerId",
  "transport",
  ...PROVIDER_THREAD_OPTIONAL_STRING_FIELDS,
]);

const WORKTREE_METADATA_FIELDS = Object.freeze(["worktreePath", "branch"]);
const SESSION_LINEAGE_FIELDS = Object.freeze(["predecessorSessionId", "successorSessionId"]);

/**
 * Validate the shape of a ProviderThreadRef (addendum §7). Throws TypeError
 * with a field-pointed message when the ref is not an object, missing
 * required fields, carries a bad transport, has an unknown key, or has a
 * non-string optional field.
 *
 * The "no unknown keys" rule is stricter than the addendum implies; it
 * prevents typos from silently flowing through the schema's
 * `additionalProperties: true` and getting absorbed by SH-2-17/18 as
 * surprises.
 *
 * @param {unknown} ref
 * @returns {void}
 */
export function assertValidProviderThreadRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    throw new TypeError("ProviderThreadRef must be an object");
  }
  const r = /** @type {Record<string, unknown>} */ (ref);
  if (typeof r.providerId !== "string" || r.providerId.length === 0) {
    throw new TypeError("ProviderThreadRef.providerId required (non-empty string)");
  }
  if (typeof r.transport !== "string" || !PROVIDER_THREAD_TRANSPORTS.includes(/** @type {any} */ (r.transport))) {
    throw new TypeError(
      `ProviderThreadRef.transport must be one of ${PROVIDER_THREAD_TRANSPORTS.join("|")}`,
    );
  }
  for (const key of Object.keys(r)) {
    if (!PROVIDER_THREAD_ALL_KEYS.has(key)) {
      throw new TypeError(`ProviderThreadRef: unknown key '${key}'`);
    }
  }
  for (const f of PROVIDER_THREAD_OPTIONAL_STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, f)) {
      const v = r[f];
      if (typeof v !== "string" || v.length === 0) {
        throw new TypeError(`ProviderThreadRef.${f} must be a non-empty string when present`);
      }
    }
  }
}

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
  if (Object.prototype.hasOwnProperty.call(input, "providerThread")) {
    try {
      assertValidProviderThreadRef(input.providerThread);
    } catch (cause) {
      throw makeError(
        /** @type {Error} */ (cause).message,
        "INVALID_PROVIDER_THREAD",
        { field: "providerThread" },
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "providerCapabilities")) {
    try {
      validateProviderCapabilities(input.providerCapabilities);
    } catch (cause) {
      throw makeError(
        /** @type {Error} */ (cause).message,
        "INVALID_PROVIDER_CAPABILITIES",
        { field: "providerCapabilities" },
      );
    }
  }
}

function assertWorktreeMetadataShapes(input, context) {
  for (const f of WORKTREE_METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, f)) {
      if (typeof input[f] !== "string" || input[f].length === 0) {
        throw makeError(`${context}: ${f} must be a non-empty string when present`, "INVALID_INPUT", { field: f });
      }
    }
  }
}

function assertSessionLineageShapes(input, context) {
  for (const f of SESSION_LINEAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, f)) {
      if (typeof input[f] !== "string" || !isSessionId(input[f])) {
        throw makeError(`${context}: ${f} must be a ses_ id when present`, "INVALID_SESSION_ID", { field: f });
      }
    }
  }
}

function pickWorktreeMetadata(input) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const f of WORKTREE_METADATA_FIELDS) {
    if (typeof input[f] === "string" && input[f].length > 0) out[f] = input[f];
  }
  return out;
}

function pickSessionLineage(input) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const f of SESSION_LINEAGE_FIELDS) {
    if (typeof input[f] === "string" && isSessionId(input[f])) out[f] = input[f];
  }
  return out;
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
    /** @type {Map<string, { predecessorSessionId?: string; successorSessionId?: string }>} */
    this.sessionLineage = new Map();
  }

  /**
   * Snapshot of every session in FIFO arrival order. Each record is a
   * read-only reference to the projection's stored object — callers must
   * treat the result as immutable.
   *
   * @returns {object[]}
   */
  list() {
    return this.projection.toSnapshots().sessions.map((session) => this.#enrichSession(session));
  }

  /**
   * Look up a session by id. Returns null when no such session exists.
   *
   * @param {string} sessionId
   * @returns {object | null}
   */
  get(sessionId) {
    if (typeof sessionId !== "string") return null;
    const session = this.projection.sessions.get(sessionId);
    return session ? this.#enrichSession(session) : null;
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
   * @param {string}  [input.predecessorSessionId]
   * @param {string}  [input.successorSessionId]
   * @param {object}  [input.providerThread]        ProviderThreadRef (addendum §7); runtime-only, rides through event payload, never persisted to tracker JSON
   * @param {object}  [input.providerCapabilities]  ProviderCapabilities (addendum §5); runtime-only, same persistence rules as providerThread
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
    assertSessionLineageShapes(input, "create");
    if (
      typeof input.predecessorSessionId === "string" &&
      !this.projection.sessions.get(input.predecessorSessionId)
    ) {
      throw makeError(
        `create: predecessor session '${input.predecessorSessionId}' not found`,
        "UNKNOWN_PREDECESSOR_SESSION",
        { predecessorSessionId: input.predecessorSessionId },
      );
    }

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
    if (typeof input.predecessorSessionId === "string") {
      this.#recordLineage(input.predecessorSessionId, sessionId);
    }
    return {
      sessionId,
      rev: result.rev,
      eventId: result.eventId,
      session: this.get(sessionId),
    };
  }

  /**
   * Mark a predecessor session as rolled over and link it to its successor in
   * one append-only event. The projection does not yet persist lineage fields,
   * so this registry also keeps a local read-through index for callers using
   * this instance; the durable event carries the same pair for replay once the
   * projection absorbs the v0.7 lineage fields.
   *
   * @param {string} predecessorSessionId
   * @param {string} successorSessionId
   * @param {{ reason?: string; comment?: string; source?: string; idempotencyKey?: string }} [input]
   * @returns {Promise<{ rev: number; eventId: string; predecessor: object | null; successor: object | null }>}
   */
  async linkSuccessor(predecessorSessionId, successorSessionId, input = {}) {
    if (typeof predecessorSessionId !== "string" || !isSessionId(predecessorSessionId)) {
      throw makeError("linkSuccessor: predecessorSessionId must be a ses_ id", "INVALID_SESSION_ID", { field: "predecessorSessionId" });
    }
    if (typeof successorSessionId !== "string" || !isSessionId(successorSessionId)) {
      throw makeError("linkSuccessor: successorSessionId must be a ses_ id", "INVALID_SESSION_ID", { field: "successorSessionId" });
    }
    if (predecessorSessionId === successorSessionId) {
      throw makeError("linkSuccessor: predecessor and successor must be different sessions", "INVALID_INPUT");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw makeError("linkSuccessor: input must be an object", "INVALID_INPUT");
    }
    assertNoForbiddenFields(input, "linkSuccessor");
    const predecessor = this.projection.sessions.get(predecessorSessionId);
    if (!predecessor) {
      throw makeError(`linkSuccessor: unknown predecessor session '${predecessorSessionId}'`, "UNKNOWN_SESSION", { sessionId: predecessorSessionId });
    }
    const successor = this.projection.sessions.get(successorSessionId);
    if (!successor) {
      throw makeError(`linkSuccessor: unknown successor session '${successorSessionId}'`, "UNKNOWN_SESSION", { sessionId: successorSessionId });
    }

    const { reason, comment, source = "system", idempotencyKey } = input;
    if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
      throw makeError("linkSuccessor: reason must be a non-empty string when present", "INVALID_INPUT", { field: "reason" });
    }
    if (comment !== undefined && (typeof comment !== "string" || comment.length === 0)) {
      throw makeError("linkSuccessor: comment must be a non-empty string when present", "INVALID_INPUT", { field: "comment" });
    }

    const eventForValidation = {
      schemaVersion: 1,
      id: this.makeRuntimeId("evt"),
      ts: this.now(),
      type: "session.status",
      source,
      workspace: this.workspace,
      sessionId: predecessorSessionId,
      status: "rolled_over",
      successorSessionId,
      predecessorSessionId,
      ...(reason ? { reason } : {}),
      ...(comment ? { comment } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    this.validateRuntimeEvent(eventForValidation);

    const { id: _placeholderEventId, ...eventForAppend } = eventForValidation;
    const result = await this.runtimeStore.append(eventForAppend);
    this.#recordLineage(predecessorSessionId, successorSessionId);
    return {
      rev: result.rev,
      eventId: result.eventId,
      predecessor: this.get(predecessorSessionId),
      successor: this.get(successorSessionId),
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
   * Record a worktree/branch binding update for a session. The event uses the
   * generic `session.task_attached` runtime variant with a distinct mode so
   * the append-only log captures the binding even before a dedicated schema
   * variant exists.
   *
   * @param {string} sessionId
   * @param {{ worktreePath?: string; branch?: string; source?: string; idempotencyKey?: string }} input
   * @returns {Promise<{ rev: number; eventId: string; session: object | null }>}
   */
  async updateWorktreeBinding(sessionId, input) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw makeError("updateWorktreeBinding: sessionId required", "INVALID_INPUT");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw makeError("updateWorktreeBinding: input must be an object", "INVALID_INPUT");
    }
    assertNoForbiddenFields(input, "updateWorktreeBinding");
    assertWorktreeMetadataShapes(input, "updateWorktreeBinding");
    const metadata = pickWorktreeMetadata(input);
    if (Object.keys(metadata).length === 0) {
      throw makeError("updateWorktreeBinding: worktreePath or branch required", "INVALID_INPUT");
    }
    if (!this.projection.sessions.get(sessionId)) {
      throw makeError(`updateWorktreeBinding: unknown session '${sessionId}'`, "UNKNOWN_SESSION", { sessionId });
    }

    const { source = "system", idempotencyKey } = input;
    const eventForValidation = {
      schemaVersion: 1,
      id: this.makeRuntimeId("evt"),
      ts: this.now(),
      type: "session.task_attached",
      source,
      workspace: this.workspace,
      sessionId,
      mode: "worktree_bound",
      ...metadata,
      ...(idempotencyKey ? { idempotencyKey } : {}),
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

  #recordLineage(predecessorSessionId, successorSessionId) {
    this.sessionLineage.set(predecessorSessionId, {
      ...(this.sessionLineage.get(predecessorSessionId) || {}),
      successorSessionId,
    });
    this.sessionLineage.set(successorSessionId, {
      ...(this.sessionLineage.get(successorSessionId) || {}),
      predecessorSessionId,
    });
  }

  #enrichSession(session) {
    if (!session || typeof session !== "object") return session;
    const lineage = this.sessionLineage.get(session.id) || {};
    const projected = pickSessionLineage(session);
    const merged = { ...projected, ...lineage };
    return Object.keys(merged).length > 0 ? { ...session, ...merged } : session;
  }
}
