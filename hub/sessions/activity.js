// hub/sessions/activity.js — SH-2-10 (TDD v0.5 §8.2, §23.2 #4, §25)
//
// ActivityMonitor — pure derivation + a thin driver that emits
// `session.status` runtime events ONLY when a session's derived activity
// state actually changes.
//
// What this module is responsible for:
//   - `deriveActivity(session, now, thresholds)` — pure projection per TDD
//     §8.2 verbatim. Returns `{ state, warnings }` where `state` is one of
//     the `SessionStatusEvent.status` enum values and `warnings[]` is built
//     via the per-kind factories in `hub/sessions/warnings.js` so every
//     warning is valid by construction.
//   - `deriveActivityWithSeverity(session, now, thresholds)` — same shape
//     but each warning carries a project-internal `severity` companion
//     (`"medium" | "high"`) so SH-4 can project to `AttentionItem.severity`
//     without re-deriving. Per §23.2 #4 dumb-terminal silence at the
//     escalate threshold raises severity to `"high"` but NEVER promotes the
//     warning to `kind: "approval_needed"` (which is a different kind, not
//     a severity).
//   - `ActivityMonitor.tick(sessionId)` / `.tickAll()` — driver layer that
//     reads the current session via the supplied projection, calls
//     `deriveActivity`, compares to `projection.sessions[id].status`, and
//     appends a `session.status` event ONLY on state change. Builds the
//     event the same way `hub/sessions/registry.js` does (placeholder
//     `evt_` id stripped before `runtimeStore.append`, `source: "system"`).
//
// What this module does NOT do:
//   - Synthesize `context_high` from raw stdio (forbidden per TDD §8.3).
//     ActivityMonitor only emits `quiet_terminal` and `missing_heartbeat`;
//     the §8.3 `context_high` warning is sourced from app-server / MCP
//     events by other paths.
//   - Mutate the projection directly. Reads only.
//   - Project to AttentionItem. That is SH-4's job; the `severity`
//     companion on `deriveActivityWithSeverity`'s warnings is the hook.
//
// The §8.2 algorithm in plain English:
//   1. If `session.status` is `archived` or `done`, passthrough — no
//      warnings, no event.
//   2. If the underlying process exited (or status is already `stopped`),
//      derive `stopped` — no warnings.
//   3. If an explicit structured source set the current status
//      (`mcp | adapter | ui | cli | http`), trust it — passthrough the
//      existing `warnings`. Auto-derivation never overrides a human / MCP
//      / app-server-set state.
//   4. dumb_terminal silence past the quiet threshold → `quiet` +
//      `quiet_terminal` warning.
//   5. mcp_tracked / codex_app_server / hybrid missing the heartbeat past
//      the missing-heartbeat threshold → `quiet` + `missing_heartbeat`
//      warning.
//   6. Otherwise → `active`, no warnings.

import {
  quietTerminalWarning,
  missingHeartbeatWarning,
} from "./warnings.js";

/**
 * @typedef {"starting" | "active" | "quiet" | "idle" | "waiting_for_human"
 *   | "waiting_for_approval" | "blocked" | "context_high" | "done"
 *   | "stopping" | "stopped" | "resuming" | "rolled_over" | "archived"
 *   | "unknown"} ActivityState
 */

/**
 * Default thresholds. Mirrors TDD §25 verbatim. Frozen so callers cannot
 * mutate the shared default object; pass a thresholds override to
 * `deriveActivity` / `ActivityMonitor` if you need different values.
 *
 * @type {Readonly<{
 *   heartbeatEveryMinutes: 5,
 *   missingHeartbeatAfterMinutes: 12,
 *   dumbTerminalQuietAfterMinutes: 10,
 *   dumbTerminalQuietEscalateAfterMinutes: 25,
 *   appServerDisconnectedWarningAfterSeconds: 60,
 *   contextHighPercent: 85,
 * }>}
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  heartbeatEveryMinutes: 5,
  missingHeartbeatAfterMinutes: 12,
  dumbTerminalQuietAfterMinutes: 10,
  dumbTerminalQuietEscalateAfterMinutes: 25,
  appServerDisconnectedWarningAfterSeconds: 60,
  contextHighPercent: 85,
});

/**
 * `SessionStatusEvent.status` values that deriveActivity returns early on,
 * with no warnings: the session is already in a settled terminal-ish state
 * and ActivityMonitor must not second-guess it.
 *
 * @type {readonly string[]}
 */
export const TERMINAL_STATES = Object.freeze(["archived", "done", "stopped"]);

/**
 * Tiers that publish a structured heartbeat. Per TDD §8.2 "MCP/app-server
 * /hybrid: missing expected heartbeat → quiet + missing_heartbeat warning."
 *
 * @type {readonly string[]}
 */
const HEARTBEAT_TIERS = Object.freeze(["mcp_tracked", "codex_app_server", "hybrid"]);

/**
 * `RuntimeEvent.source` values (the runtimeSource enum from
 * `schema/runtime-events.schema.json`) that count as an *explicit* set of
 * the current `session.status`. When the most recent status update came
 * from one of these sources, auto-derivation passes through — it never
 * overrides a human / MCP / app-server-set state.
 *
 *   - `mcp`     — MCP client set the state (e.g. an explicit tracker MCP).
 *   - `adapter` — Provider adapter (Codex app-server, etc.) reported a
 *                 structured state.
 *   - `ui` / `cli` / `http` — Human-initiated overrides via the hub's
 *                 user-facing surfaces.
 *
 * `system` (what ActivityMonitor itself uses) and `watcher` are deliberately
 * excluded — those represent the auto-derivation we're considering overriding.
 *
 * @type {readonly string[]}
 */
const EXPLICIT_STATUS_SOURCES = Object.freeze(["mcp", "adapter", "ui", "cli", "http"]);

/**
 * Tiers that publish a structured heartbeat (mcp_tracked / codex_app_server
 * / hybrid). Used by §8.2 to decide whether `missing_heartbeat` applies.
 *
 * @param {{ tier?: string }} session
 * @returns {boolean}
 */
export function expectsHeartbeat(session) {
  if (!session || typeof session !== "object") return false;
  return HEARTBEAT_TIERS.includes(/** @type {string} */ (session.tier));
}

/**
 * True when the session's current status was set by an explicit source
 * (MCP, adapter, or a human-facing surface). The projection in
 * `hub/runtime/projection.js` writes `statusSource: { kind: e.source,
 * eventId: e.id }` where `kind` is the runtimeSource enum value; we read
 * `.kind` and compare to EXPLICIT_STATUS_SOURCES.
 *
 * Legacy callers may set `statusSource` as a bare string — we accept both
 * shapes so this works regardless of the surrounding projection version.
 *
 * @param {{ statusSource?: { kind?: string } | string }} session
 * @returns {boolean}
 */
export function hasExplicitStructuredState(session) {
  if (!session || typeof session !== "object") return false;
  const src = session.statusSource;
  const kind = typeof src === "string" ? src : src && src.kind;
  if (typeof kind !== "string") return false;
  return EXPLICIT_STATUS_SOURCES.includes(kind);
}

/**
 * True when the underlying OS process exited (or the session is already in
 * the `stopped` state). The hub doesn't yet have a dedicated `processExited`
 * field on SessionRecord — when adapters land (SH-2-17/18) the field is
 * expected to be populated; until then `status === "stopped"` is the
 * authoritative signal.
 *
 * @param {{ processExited?: boolean, status?: string }} session
 * @returns {boolean}
 */
export function processExited(session) {
  if (!session || typeof session !== "object") return false;
  return session.processExited === true || session.status === "stopped";
}

/**
 * Minutes between `tsOrIso` and `now`. Returns `Infinity` when `tsOrIso` is
 * null/undefined so callers can compare `> threshold` without a separate
 * null guard. Negative deltas (clock skew, future timestamps) are allowed
 * to return a negative number — the threshold comparison falls through
 * cleanly in that case (the session is treated as recently active).
 *
 * @param {string | number | Date | null | undefined} tsOrIso
 * @param {Date} now
 * @returns {number}
 */
export function minutesSince(tsOrIso, now) {
  if (tsOrIso === null || tsOrIso === undefined) return Infinity;
  const t = tsOrIso instanceof Date ? tsOrIso.getTime() : new Date(tsOrIso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 60000;
}

/**
 * Derive `{ state, warnings }` from a SessionRecord + now-time. Pure: no
 * side effects, no event emission. Implements TDD §8.2 verbatim.
 *
 * @param {object} session              SessionRecord (shape per TDD §6.1)
 * @param {Date}   now                  current time
 * @param {typeof DEFAULT_THRESHOLDS} [thresholds]
 * @returns {{ state: ActivityState, warnings: object[] }}
 */
export function deriveActivity(session, now, thresholds = DEFAULT_THRESHOLDS) {
  if (!session || typeof session !== "object") {
    return { state: "unknown", warnings: [] };
  }
  // 1. Settled terminal-ish states pass through.
  if (session.status === "archived" || session.status === "done") {
    return { state: session.status, warnings: [] };
  }
  // 2. Exited process → stopped, no warnings.
  if (processExited(session)) {
    return { state: "stopped", warnings: [] };
  }
  // 3. Explicit structured state (app-server/MCP/human override) wins.
  if (hasExplicitStructuredState(session)) {
    return {
      state: session.status,
      warnings: Array.isArray(session.warnings) ? session.warnings : [],
    };
  }
  // 4. dumb_terminal: no recent raw output → quiet + quiet_terminal.
  if (session.tier === "dumb_terminal") {
    const mins = minutesSince(session.lastOutputAt, now);
    if (mins > thresholds.dumbTerminalQuietAfterMinutes) {
      return {
        state: "quiet",
        warnings: [quietTerminalWarning({ minutes: clampInfinity(mins) })],
      };
    }
  }
  // 5. mcp/app-server/hybrid: missing heartbeat → quiet + missing_heartbeat.
  if (expectsHeartbeat(session)) {
    const mins = minutesSince(session.lastStructuredEventAt, now);
    if (mins > thresholds.missingHeartbeatAfterMinutes) {
      return {
        state: "quiet",
        warnings: [missingHeartbeatWarning({ minutes: clampInfinity(mins) })],
      };
    }
  }
  // 6. Default.
  return { state: "active", warnings: [] };
}

/**
 * `quietTerminalWarning` / `missingHeartbeatWarning` reject non-finite
 * numbers (per §8.3 the field must be a finite number). When the source
 * timestamp was null/undefined, `minutesSince` returns `Infinity`; we clamp
 * to a large finite number so the §8.3 invariant holds.
 *
 * @param {number} mins
 * @returns {number}
 */
function clampInfinity(mins) {
  if (Number.isFinite(mins)) return mins;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Same as `deriveActivity`, but each warning carries a project-internal
 * `severity` companion (`"medium" | "high"`).
 *
 * Severity rules:
 *   - `quiet_terminal` minutes > `dumbTerminalQuietEscalateAfterMinutes`
 *     → `"high"` (per §23.2 #4); otherwise `"medium"`.
 *   - `missing_heartbeat` always `"medium"`. §23.2 #4 only defines an
 *     escalate threshold for dumb-terminal silence; missing-heartbeat has
 *     no escalate threshold in TDD §25.
 *
 * Per §23.2 #4 the severity NEVER promotes the warning to
 * `kind: "approval_needed"` (which is a different kind, not a severity
 * level). The `kind` returned here is always one of `quiet_terminal` /
 * `missing_heartbeat`.
 *
 * NOTE: `severity` is a project-internal projection field, NOT part of the
 * §8.3 SessionWarning wire schema. It exists so SH-4 can project to
 * `AttentionItem.severity` without re-deriving thresholds.
 *
 * @param {object} session
 * @param {Date} now
 * @param {typeof DEFAULT_THRESHOLDS} [thresholds]
 * @returns {{ state: ActivityState, warnings: object[] }}
 */
export function deriveActivityWithSeverity(session, now, thresholds = DEFAULT_THRESHOLDS) {
  const { state, warnings } = deriveActivity(session, now, thresholds);
  const annotated = warnings.map((w) => {
    if (!w || typeof w !== "object") return w;
    if (w.kind === "quiet_terminal") {
      const severity =
        typeof w.minutes === "number" &&
        w.minutes > thresholds.dumbTerminalQuietEscalateAfterMinutes
          ? "high"
          : "medium";
      return { ...w, severity };
    }
    if (w.kind === "missing_heartbeat") {
      return { ...w, severity: "medium" };
    }
    return w;
  });
  return { state, warnings: annotated };
}

/**
 * @typedef {object} ActivityMonitorDeps
 * @property {{ append: (event: object) => Promise<{ ok: true, eventId: string, rev: number }> }} runtimeStore
 * @property {{ sessions: Map<string, object> }} projection
 * @property {string} workspace
 * @property {(prefix: string) => string} makeRuntimeId
 * @property {typeof DEFAULT_THRESHOLDS} [thresholds]
 * @property {() => Date} [now]
 */

/**
 * Driver: wraps a projection + runtimeStore and emits `session.status`
 * runtime events on derived state changes.
 *
 * Per DoD #2: `tick(sessionId)` emits exactly one `session.status` event
 * when (and only when) the derived state differs from the current
 * `projection.sessions[sessionId].status`.
 */
export class ActivityMonitor {
  /**
   * @param {ActivityMonitorDeps} deps
   */
  constructor(deps) {
    const { runtimeStore, projection, workspace, makeRuntimeId, thresholds, now } = deps || {};
    if (!runtimeStore || typeof runtimeStore.append !== "function") {
      throw new Error("ActivityMonitor: runtimeStore (with append) required");
    }
    if (!projection || !(projection.sessions instanceof Map)) {
      throw new Error("ActivityMonitor: projection (with sessions Map) required");
    }
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("ActivityMonitor: workspace string required");
    }
    if (typeof makeRuntimeId !== "function") {
      throw new Error("ActivityMonitor: makeRuntimeId function required");
    }
    this.runtimeStore = runtimeStore;
    this.projection = projection;
    this.workspace = workspace;
    this.makeRuntimeId = makeRuntimeId;
    this.thresholds = thresholds || DEFAULT_THRESHOLDS;
    this.now = typeof now === "function" ? now : () => new Date();
  }

  /**
   * Derive activity for a single session and emit `session.status` ONLY
   * when the derived state differs from the projected status. Returns
   * `{ changed, state, warnings, eventId?, rev? }`.
   *
   * @param {string} sessionId
   * @returns {Promise<{ changed: boolean, state: ActivityState, warnings: object[], eventId?: string, rev?: number }>}
   */
  async tick(sessionId) {
    const session = this.projection.sessions.get(sessionId);
    if (!session) {
      return { changed: false, state: "unknown", warnings: [] };
    }
    const now = this.now();
    const { state, warnings } = deriveActivity(session, now, this.thresholds);
    if (state === session.status) {
      return { changed: false, state, warnings };
    }
    // Build and append a session.status event. Mirror registry.js: stamp a
    // placeholder evt_ id for validation, strip it so the store assigns the
    // canonical id on append.
    const event = {
      schemaVersion: 1,
      ts: now.toISOString(),
      type: "session.status",
      source: "system",
      workspace: this.workspace,
      sessionId,
      status: state,
    };
    const result = await this.runtimeStore.append(event);
    return {
      changed: true,
      state,
      warnings,
      eventId: result.eventId,
      rev: result.rev,
    };
  }

  /**
   * Tick every session in the projection. Returns an array of per-session
   * results in projection iteration order. Sessions in TERMINAL_STATES are
   * still ticked (so `archived` / `done` / `stopped` passthrough is
   * exercised), but they never produce a state change.
   *
   * @returns {Promise<Array<{ sessionId: string, changed: boolean, state: ActivityState, warnings: object[], eventId?: string, rev?: number }>>}
   */
  async tickAll() {
    const results = [];
    for (const sessionId of this.projection.sessions.keys()) {
      const r = await this.tick(sessionId);
      results.push({ sessionId, ...r });
    }
    return results;
  }
}
