// hub/context-packs/service.js — SH-8-01 (TDD v0.5 §10)
//
// ContextPackService — scaffolding for the per-kind context-pack dispatch
// surface. This module declares the canonical §10.1 pack-kind union and the
// §10.2 deterministic source list, and exposes a class whose per-kind methods
// are intentional stubs until the composers land in SH-8-02 (and the rollover
// algorithm lands in SH-8-03; start-prompt template lands later still).
//
// What this module is responsible for:
//   - Declaring `CONTEXT_PACK_KINDS` (§10.1) and `DETERMINISTIC_SOURCES`
//     (§10.2) as deeply-frozen, immutable shapes future composers can rely on.
//   - Validating constructor dependencies in the same shape JobRegistry uses
//     (jobRegistry, projection, workspace, plus runtimeStore/now slots that
//     composers will lean on later).
//   - Dispatching `build(kind, params)` to the right per-kind method, with a
//     stable `INVALID_KIND` error for unknown kinds.
//
// What this module does NOT do:
//   - Compose any pack. Each per-kind method throws a stable `NOT_IMPLEMENTED`
//     error tagged with the kind and the tracker id of the composer task.
//   - HTTP routing (lives in hub/api/jobs.js, which already 501s the
//     `GET /api/jobs/:jobId/context-pack?kind=...` route until SH-8-02).
//   - Rollover algorithm or start-prompt template — separate tasks.
//
// Callers should use `service.build(kind, params)` for kind-dispatched access,
// or the per-kind methods directly. Until SH-8-02 lands, every call throws.

/**
 * @typedef {typeof CONTEXT_PACK_KINDS[number]} ContextPackKind
 */

/**
 * Canonical TDD §10.1 pack-kind union. Eight kinds, ordered as declared in the
 * TDD. Frozen so callers can rely on identity and ordering.
 *
 * @type {readonly ["start","resume","rollover","handoff","review","verify","closeout","changed_since"]}
 */
export const CONTEXT_PACK_KINDS = Object.freeze([
  "start",
  "resume",
  "rollover",
  "handoff",
  "review",
  "verify",
  "closeout",
  "changed_since",
]);

/**
 * Type guard: returns true when `value` is one of the §10.1 kinds.
 *
 * @param {unknown} value
 * @returns {value is ContextPackKind}
 */
export function isContextPackKind(value) {
  return typeof value === "string" && CONTEXT_PACK_KINDS.includes(/** @type {ContextPackKind} */ (value));
}

/**
 * Canonical TDD §10.2 deterministic source list. Twelve entries, in §10.2
 * order:
 *
 *   1.  /api/projects/:slug/tasks/:taskId/brief  → tracker.brief
 *   2.  /why                                     → tracker.why
 *   3.  /execute                                 → tracker.execute
 *   4.  /verify                                  → tracker.verify
 *   5.  /handoff                                 → tracker.handoff
 *   6.  /changed?fromRev=                        → tracker.changed
 *   7.  /history                                 → tracker.history
 *   8.  /since/:rev                              → tracker.since_rev
 *   9.  snapshots/history                        → snapshots.history
 *   10. runtime job/session/skill events         → runtime.events
 *   11. repo watcher events                      → repo.watcher
 *   12. git status/diff/log                      → git.evidence
 *
 * Each entry is frozen; the outer array is frozen. Composers will look up
 * sources by `id`; ordering is preserved for any §10.2 audit.
 */
export const DETERMINISTIC_SOURCES = Object.freeze([
  Object.freeze({ id: "tracker.brief",    reference: "/api/projects/:slug/tasks/:taskId/brief" }),
  Object.freeze({ id: "tracker.why",      reference: "/why" }),
  Object.freeze({ id: "tracker.execute",  reference: "/execute" }),
  Object.freeze({ id: "tracker.verify",   reference: "/verify" }),
  Object.freeze({ id: "tracker.handoff",  reference: "/handoff" }),
  Object.freeze({ id: "tracker.changed",  reference: "/changed?fromRev=" }),
  Object.freeze({ id: "tracker.history",  reference: "/history" }),
  Object.freeze({ id: "tracker.since_rev",reference: "/since/:rev" }),
  Object.freeze({ id: "snapshots.history",reference: "snapshots/history" }),
  Object.freeze({ id: "runtime.events",   reference: "runtime job/session/skill events" }),
  Object.freeze({ id: "repo.watcher",     reference: "repo watcher events" }),
  Object.freeze({ id: "git.evidence",     reference: "git status/diff/log" }),
]);

/**
 * Build a service-shaped Error. The `code` field is the stable contract for
 * HTTP/CLI/WS layers; the message is for humans. Mirrors the helper in
 * hub/jobs/registry.js.
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
 * @typedef {object} ContextPackServiceDeps
 * @property {{ get: (jobId: string) => object | null }} jobRegistry
 * @property {{ jobs: Map<string, object> }} projection
 * @property {object} [runtimeStore]  reserved for composers (SH-8-02+)
 * @property {string} workspace
 * @property {() => string} [now]      reserved for composers (SH-8-02+)
 */

/**
 * Domain service: per-kind context-pack composition. Skeleton only until the
 * composers land at SH-8-02 (rollover at SH-8-03).
 */
export class ContextPackService {
  /**
   * @param {ContextPackServiceDeps} deps
   */
  constructor(deps) {
    const { jobRegistry, projection, runtimeStore, workspace, now } = deps || {};
    if (!jobRegistry || typeof jobRegistry.get !== "function") {
      throw new Error("ContextPackService: jobRegistry (with get) required");
    }
    if (!projection || !(projection.jobs instanceof Map)) {
      throw new Error("ContextPackService: projection (with jobs Map) required");
    }
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("ContextPackService: workspace string required");
    }
    this.jobRegistry = jobRegistry;
    this.projection = projection;
    this.runtimeStore = runtimeStore; // reserved for composers
    this.workspace = workspace;
    this.now = typeof now === "function" ? now : () => new Date().toISOString();
  }

  /**
   * Dispatch to the per-kind composer. Validates `kind` against §10.1.
   *
   * @param {ContextPackKind} kind
   * @param {object} [params]
   * @returns {object}
   */
  build(kind, params) {
    if (!isContextPackKind(kind)) {
      throw makeError(
        `build: kind '${kind}' not in ${CONTEXT_PACK_KINDS.join("|")}`,
        "INVALID_KIND",
        { allowed: [...CONTEXT_PACK_KINDS] },
      );
    }
    switch (kind) {
      case "start":          return this.buildStartPack(params);
      case "resume":         return this.buildResumePack(params);
      case "rollover":       return this.buildRolloverPack(params);
      case "handoff":        return this.buildHandoffPack(params);
      case "review":         return this.buildReviewPack(params);
      case "verify":         return this.buildVerifyPack(params);
      case "closeout":       return this.buildCloseoutPack(params);
      case "changed_since":  return this.buildChangedSincePack(params);
      // istanbul ignore next — exhaustive switch; guarded by isContextPackKind
      default: throw makeError(`build: unreachable kind '${kind}'`, "INVALID_KIND");
    }
  }

  /** `start` pack — composer governed by TDD §10.3; lands at SH-8-02.
   *  @param {object} [_params] @returns {object} */
  buildStartPack(_params) { throw stubError("buildStartPack", "start", "SH-8-02"); }

  /** `resume` pack — composer governed by TDD §10.3; lands at SH-8-02.
   *  @param {object} [_params] @returns {object} */
  buildResumePack(_params) { throw stubError("buildResumePack", "resume", "SH-8-02"); }

  /** `rollover` pack — algorithm governed by TDD §10.3 / §21; lands at SH-8-03
   *  (separate task from the other composers).
   *  @param {object} [_params] @returns {object} */
  buildRolloverPack(_params) { throw stubError("buildRolloverPack", "rollover", "SH-8-03"); }

  /** `handoff` pack — composer governed by TDD §10.3; lands at SH-8-02.
   *  @param {object} [_params] @returns {object} */
  buildHandoffPack(_params) { throw stubError("buildHandoffPack", "handoff", "SH-8-02"); }

  /** `review` pack — composer governed by TDD §10.3; lands at SH-8-02.
   *  @param {object} [_params] @returns {object} */
  buildReviewPack(_params) { throw stubError("buildReviewPack", "review", "SH-8-02"); }

  /** `verify` pack — composer governed by TDD §10.3; lands at SH-8-02.
   *  @param {object} [_params] @returns {object} */
  buildVerifyPack(_params) { throw stubError("buildVerifyPack", "verify", "SH-8-02"); }

  /** `closeout` pack — composer governed by TDD §10.3; lands at SH-8-02.
   *  @param {object} [_params] @returns {object} */
  buildCloseoutPack(_params) { throw stubError("buildCloseoutPack", "closeout", "SH-8-02"); }

  /** `changed_since` pack — composer governed by TDD §10.3; lands at SH-8-02.
   *  @param {object} [_params] @returns {object} */
  buildChangedSincePack(_params) { throw stubError("buildChangedSincePack", "changed_since", "SH-8-02"); }
}

/**
 * Build a stable NOT_IMPLEMENTED error for a per-kind stub. Centralized to keep
 * the per-method bodies one-liners.
 *
 * @param {string} method
 * @param {ContextPackKind} kind
 * @param {"SH-8-02" | "SH-8-03"} plannedAt
 * @returns {Error & { code: string; details: object }}
 */
function stubError(method, kind, plannedAt) {
  return makeError(`${method}: composer lands with ${plannedAt}`, "NOT_IMPLEMENTED", { kind, plannedAt });
}
