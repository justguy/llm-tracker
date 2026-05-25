// hub/attention/engine.js — SH-4-02 (TDD v0.5 §8A.3, §8A.4, §25;
//                                     PRD v0.5 §6.1 unbound-session v0.7)
//
// AttentionEngine — the orchestrator that turns runtime/tracker state into a
// sorted AttentionItem[]. SH-4-02 ships only the `unbound_session` rule
// (v0.7); SH-4-03 fills the other per-kind rule slots that this module
// already exposes via `registerRule(kind, ruleFn)`.
//
// What this module is responsible for:
//   - Owning a rule registry keyed by AttentionKind (§6.8). The engine
//     iterates registered rules over the input snapshots and collects each
//     rule's emitted items.
//   - Implementing the v0.7 `unbound_session` rule end-to-end: raise when
//     `session.taskId === undefined` and age past
//     `untaskedSessions.unboundAttentionAfterMinutes` (default 5);
//     escalate severity low → medium → high at 1h / 6h;
//     surface `autoArchive: true` once age >= `unboundAutoArchiveAfterHours`
//     (default 72) so a future runtime hook can archive the session.
//   - Sorting the emitted item set per §8A.3 (Critical → Low; stable
//     tie-break by `createdAt` ASC, then `dedupeKey` ASC).
//   - Driving an injected `AttentionProjection` so `compute()` doubles as a
//     "apply the freshly-computed set" call when a projection is wired in.
//
// What this module does NOT do (deferred to later SH-4 tasks):
//   - Generate items for any kind other than `unbound_session`. The slot for
//     every other kind is registered as `null` (a no-op) so sh-4-03 can plug
//     real rules without restructuring.
//   - Persist ack / snooze / clear runtime events. Per §8A.3 the engine is
//     pure projection; ack/snooze lives in sh-4-05.
//   - Archive sessions. We surface `autoArchive: true` on the item; an
//     out-of-module runtime hook is responsible for emitting the
//     `session.status` archive event (outside this task's allowed paths).

import {
  ATTENTION_KINDS,
  assertValidAttentionItem,
} from "./types.js";
import { computeAttentionDedupeKey } from "./dedupe.js";
import { AttentionProjection } from "./projection.js";

/**
 * @typedef {import("./types.js").AttentionItem} AttentionItem
 * @typedef {import("./types.js").AttentionKind} AttentionKind
 * @typedef {import("./types.js").AttentionSeverity} AttentionSeverity
 */

/**
 * Default workspace config slice for untasked-session escalation. Mirrors
 * TDD §25 verbatim. Frozen so callers can't mutate the shared default.
 *
 * @type {Readonly<{
 *   unboundAttentionAfterMinutes: 5,
 *   unboundAutoArchiveAfterHours: 72,
 * }>}
 */
export const DEFAULT_UNTASKED_SESSIONS_CONFIG = Object.freeze({
  unboundAttentionAfterMinutes: 5,
  unboundAutoArchiveAfterHours: 72,
});

/**
 * Session statuses that disqualify a session from `unbound_session`. Mirrors
 * `hub/sessions/activity.js` TERMINAL_STATES so a stopped or archived session
 * never gets dinged for being unbound.
 *
 * @type {readonly string[]}
 */
const UNBOUND_SKIP_STATUSES = Object.freeze(["archived", "done", "stopped"]);

/**
 * §8A.3 priority order. Lower rank = higher priority (closer to "Critical").
 * Kinds not in this table sort to the end deterministically.
 *
 * Order follows TDD §8A.3 (canonical kinds in `hub/attention/types.js`):
 *   Critical: 1 approval_needed, 2 conflict / outside_allowed_paths (write risk)
 *   High:     3 blocked, 4 not_responding, 5 context_high
 *   Medium:   6 done_claimed_verify_missing, 7 done_needs_closeout, 8 verify_missing
 *   Low:      9 quiet (TDD §8A.3 calls it "quiet_terminal" prose-wise; the
 *               canonical kind in types.js is `quiet`),
 *            10 unbound_session
 *
 * @type {Readonly<Record<AttentionKind, number>>}
 */
export const PRIORITY_RANK = Object.freeze({
  approval_needed: 1,
  sandbox_escape_requested: 1,
  conflict: 2,
  outside_allowed_paths: 2,
  blocked: 3,
  not_responding: 4,
  context_high: 5,
  done_claimed_verify_missing: 6,
  done_needs_closeout: 7,
  verify_missing: 8,
  provider_error: 8,
  quiet: 9,
  unbound_session: 10,
});

/**
 * The set of canonical kinds for which a rule slot is pre-registered. The
 * `unbound_session` rule ships now; every other entry is reserved as `null`
 * so SH-4-03 can `registerRule(kind, fn)` without modifying this file.
 */
const RESERVED_RULE_KINDS = Object.freeze([...ATTENTION_KINDS]);

/**
 * Stable §8A.3 comparator. Ties break by `createdAt` ASC chronologically
 * (numeric offsets are accepted by the validator), then by `dedupeKey` ASC.
 *
 * @param {AttentionItem} a
 * @param {AttentionItem} b
 * @returns {number}
 */
export function compareByPriority(a, b) {
  const ra = PRIORITY_RANK[/** @type {AttentionKind} */ (a.kind)] ?? Number.MAX_SAFE_INTEGER;
  const rb = PRIORITY_RANK[/** @type {AttentionKind} */ (b.kind)] ?? Number.MAX_SAFE_INTEGER;
  if (ra !== rb) return ra - rb;
  const tc = compareTimestamps(a.createdAt, b.createdAt);
  if (tc !== 0) return tc;
  if (a.dedupeKey !== b.dedupeKey) return a.dedupeKey < b.dedupeKey ? -1 : 1;
  return 0;
}

function compareTimestamps(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
    return ta - tb;
  }
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/**
 * Resolve a session's age-zero anchor. Prefers `startedAt` (the canonical
 * SessionRecord field set by `hub/runtime/projection.js`), falls back to
 * `createdAt` for synthetic records used in tests.
 *
 * @param {object} session
 * @returns {string | undefined}
 */
function sessionAgeAnchor(session) {
  if (typeof session.startedAt === "string" && session.startedAt.length > 0) {
    return session.startedAt;
  }
  if (typeof session.createdAt === "string" && session.createdAt.length > 0) {
    return session.createdAt;
  }
  return undefined;
}

/**
 * Minutes between an ISO timestamp and a Date. Returns `Infinity` when
 * `anchor` is missing or unparseable so threshold comparisons fall through
 * cleanly (a session with no anchor is treated as infinitely old). Negative
 * deltas (future timestamps / clock skew) are allowed to return negative.
 *
 * @param {string | undefined} anchor
 * @param {Date} now
 * @returns {number}
 */
function minutesBetween(anchor, now) {
  if (!anchor) return Infinity;
  const t = new Date(anchor).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 60000;
}

/**
 * Compute the `unbound_session` AttentionItem for `session`, or `null` if
 * the trigger condition is not met. Pure function — used both by the engine's
 * default rule registration and exposed on the class for direct testing.
 *
 * Trigger: `session.taskId === undefined` AND `session.status` is not in
 * UNBOUND_SKIP_STATUSES AND `now - sessionAgeAnchor(session) >=
 * unboundAttentionAfterMinutes`.
 *
 * Severity ladder (from age in minutes):
 *   - >= unboundAttentionAfterMinutes and < 60     → "low"
 *   - >= 60   and < 360                            → "medium"
 *   - >= 360                                       → "high"
 *
 * Auto-archive: `item.autoArchive = true` once age >=
 * `unboundAutoArchiveAfterHours * 60`. This is a hint — the engine does NOT
 * actually archive the session (out of this task's allowed paths).
 *
 * @param {object} session         SessionRecord from `RuntimeProjection.toSnapshots().sessions`
 * @param {Date}   now             current time
 * @param {{ unboundAttentionAfterMinutes: number, unboundAutoArchiveAfterHours: number }} config
 * @param {(prefix: string) => string} makeId
 * @returns {AttentionItem | null}
 */
export function unboundSessionRule(session, now, config, makeId) {
  if (!session || typeof session !== "object") return null;
  if (session.taskId !== undefined) return null;
  if (UNBOUND_SKIP_STATUSES.includes(/** @type {string} */ (session.status))) return null;
  if (typeof session.id !== "string" || session.id.length === 0) return null;

  const anchor = sessionAgeAnchor(session);
  const ageMinutes = minutesBetween(anchor, now);
  const triggerMinutes = config.unboundAttentionAfterMinutes;
  if (!(ageMinutes >= triggerMinutes)) return null;

  /** @type {AttentionSeverity} */
  let severity;
  if (ageMinutes < 60) severity = "low";
  else if (ageMinutes < 360) severity = "medium";
  else severity = "high";

  const autoArchive = ageMinutes >= config.unboundAutoArchiveAfterHours * 60;
  const nowIso = now.toISOString();
  const ageDesc = describeAge(ageMinutes);
  const sessionLabel =
    typeof session.name === "string" && session.name.length > 0
      ? session.name
      : session.id;
  const detail =
    `Session ${session.id} (${sessionLabel}) has no task binding and has been ` +
    `running for ${ageDesc}. Bind a task or acknowledge to clear.` +
    (autoArchive ? " Auto-archive recommended." : "");

  /** @type {AttentionItem} */
  const item = {
    id: makeId("att"),
    kind: "unbound_session",
    severity,
    title: "Unbound session",
    detail,
    source: "derived",
    sessionId: session.id,
    clearCondition: "session.taskId is set or session reaches a terminal status",
    createdAt: nowIso,
    updatedAt: nowIso,
    dedupeKey: computeAttentionDedupeKey({
      kind: "unbound_session",
      sessionId: session.id,
    }),
    recommendedActions: [
      { id: "bind_task", label: "Bind task", kind: "bind_task", enabled: true },
      {
        id: "attach_task",
        label: "Attach existing task",
        kind: "attach_task",
        enabled: true,
      },
      { id: "acknowledge", label: "Acknowledge", kind: "acknowledge", enabled: true },
      { id: "snooze", label: "Snooze", kind: "snooze", enabled: true },
    ],
  };
  if (typeof session.projectSlug === "string" && session.projectSlug.length > 0) {
    item.projectSlug = session.projectSlug;
  }
  if (autoArchive) {
    /** @type {any} */ (item).autoArchive = true;
  }
  return item;
}

/**
 * Short human-friendly age string for the `detail` field.
 *
 * @param {number} mins
 * @returns {string}
 */
function describeAge(mins) {
  if (!Number.isFinite(mins)) return "an unknown duration";
  if (mins < 60) return `${Math.floor(mins)}m`;
  if (mins < 60 * 24) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / (60 * 24)).toFixed(1)}d`;
}

/**
 * @typedef {(input: {
 *   sessions: object[],
 *   jobs?: object[],
 *   warnings?: object[],
 *   conflicts?: object[],
 *   trackerSnapshot?: object,
 *   now: Date,
 *   config: object,
 *   makeId: (prefix: string) => string,
 * }) => (AttentionItem | AttentionItem[] | null | undefined)} AttentionRuleFn
 */

/**
 * @typedef {object} AttentionChangePayload
 * @property {AttentionItem[]} items   the freshly-computed, sorted active set
 * @property {"global"|"project"} scope SH-4-09 default is "global"; per-project plumbing is a follow-up
 * @property {{
 *   added: AttentionItem[],
 *   removed: AttentionItem[],
 *   ackChanged: AttentionItem[],
 *   snoozeChanged: AttentionItem[],
 *   severityChanged: AttentionItem[],
 * }} changes diff vs the previous compute()'s active set, keyed by dedupeKey
 */

/**
 * @typedef {object} AttentionEngineDeps
 * @property {AttentionProjection} [projection]    Drop-in projection; defaults to a fresh `new AttentionProjection()`.
 * @property {object}              [config]        Workspace config. Reads `config.untaskedSessions.{unboundAttentionAfterMinutes, unboundAutoArchiveAfterHours}`.
 * @property {() => Date}          [now]           Time source (injectable for tests). Defaults to `() => new Date()`.
 * @property {(prefix: string) => string} [makeId] ID factory used for new `AttentionItem.id`. Defaults to a per-engine counter — pass `hub/runtime/ids.js#makeRuntimeId` in production.
 * @property {{ warn?: Function, error?: Function }} [logger]
 * @property {(payload: AttentionChangePayload) => void} [onChange]
 *   SH-4-09: invoked at the end of `compute()` IFF the new set differs from
 *   the previous set in a user-visible way (item created / cleared / ack-ed
 *   / snoozed / severity-flipped). Defaults to a no-op. A future runtime
 *   startup-glue task will wire this to `RuntimeBroadcaster.broadcastAttention`.
 */

/**
 * AttentionEngine.
 *
 * Usage:
 *   const engine = new AttentionEngine({ projection, now: () => new Date(), makeId });
 *   const items = engine.compute({ sessions, jobs, warnings, conflicts, trackerSnapshot });
 *   // -> items is already sorted by §8A.3; the engine has also called
 *   //    `projection.apply(items)` so `projection.getAll()` matches.
 */
export class AttentionEngine {
  /**
   * @param {AttentionEngineDeps} [deps]
   */
  constructor(deps = {}) {
    this.projection = deps.projection || new AttentionProjection();
    this.config = deps.config || {};
    this.now = typeof deps.now === "function" ? deps.now : () => new Date();
    this.makeId = typeof deps.makeId === "function" ? deps.makeId : defaultMakeId();
    this.logger = deps.logger || null;
    this.onChange = typeof deps.onChange === "function" ? deps.onChange : null;

    /**
     * SH-4-09 prior-tick snapshot keyed by dedupeKey. Tracks just the fields
     * the diff needs (`severity`, `acknowledgedAt`, `snoozedUntil`,
     * `clearedAt`) plus a back-pointer to the prior item so we can include
     * it in `changes.removed`.
     *
     * @type {Map<string, { severity: string, acknowledgedAt?: string, snoozedUntil?: string, clearedAt?: string, item: AttentionItem }>}
     */
    this._prior = new Map();

    /** @type {Map<AttentionKind, AttentionRuleFn | null>} */
    this._rules = new Map();
    // Reserve a slot for every canonical kind so sh-4-03 can plug rules
    // without the engine throwing on `registerRule`.
    for (const kind of RESERVED_RULE_KINDS) {
      this._rules.set(kind, null);
    }
    // Ship the unbound_session rule end-to-end.
    this._rules.set("unbound_session", (input) =>
      runUnboundSessionRule(input, this.config, this.makeId),
    );
  }

  /**
   * Register (or replace) a rule for `kind`. Rule slots for every canonical
   * AttentionKind are pre-reserved; `kind` must be one of them. Pass `null`
   * to disable a slot.
   *
   * @param {AttentionKind} kind
   * @param {AttentionRuleFn | null} ruleFn
   * @returns {void}
   */
  registerRule(kind, ruleFn) {
    if (typeof kind !== "string" || !this._rules.has(/** @type {AttentionKind} */ (kind))) {
      throw new Error(
        `AttentionEngine.registerRule: kind '${kind}' not in ATTENTION_KINDS`,
      );
    }
    if (ruleFn !== null && typeof ruleFn !== "function") {
      throw new TypeError(
        "AttentionEngine.registerRule: ruleFn must be a function or null",
      );
    }
    this._rules.set(/** @type {AttentionKind} */ (kind), ruleFn);
  }

  /**
   * Inspect the registered rule for `kind` (mostly for tests). Returns
   * `undefined` if `kind` is unknown, `null` if the slot is reserved but
   * unimplemented, or the function otherwise.
   *
   * @param {AttentionKind} kind
   * @returns {AttentionRuleFn | null | undefined}
   */
  getRule(kind) {
    return this._rules.get(/** @type {AttentionKind} */ (kind));
  }

  /**
   * Run all rules over the supplied snapshots and return the sorted active
   * set. Also applies the result to the engine's projection so
   * `engine.projection.getAll()` mirrors the return value.
   *
   * @param {{
   *   sessions: object[],
   *   jobs?: object[],
   *   warnings?: object[],
   *   conflicts?: object[],
   *   trackerSnapshot?: object,
   *   now?: Date,
   * }} input
   * @returns {AttentionItem[]}
   */
  compute(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("AttentionEngine.compute: input must be an object");
    }
    const sessions = Array.isArray(input.sessions) ? input.sessions : [];
    const jobs = Array.isArray(input.jobs) ? input.jobs : [];
    const warnings = Array.isArray(input.warnings) ? input.warnings : [];
    const conflicts = Array.isArray(input.conflicts) ? input.conflicts : [];
    const trackerSnapshot = input.trackerSnapshot || {};
    const now = input.now instanceof Date ? input.now : this.now();

    const ruleInput = {
      sessions,
      jobs,
      warnings,
      conflicts,
      trackerSnapshot,
      now,
      config: this.config,
      makeId: this.makeId,
    };

    /** @type {AttentionItem[]} */
    const collected = [];
    /** @type {Set<string>} */
    const seen = new Set();

    for (const [kind, ruleFn] of this._rules) {
      if (typeof ruleFn !== "function") continue;
      let result;
      try {
        result = ruleFn(ruleInput);
      } catch (err) {
        if (this.logger && typeof this.logger.error === "function") {
          this.logger.error(
            `AttentionEngine rule '${kind}' threw; skipping: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
      if (result === null || result === undefined) continue;
      const items = Array.isArray(result) ? result : [result];
      for (const item of items) {
        if (!item) continue;
        try {
          assertValidAttentionItem(item);
        } catch (err) {
          if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(
              `AttentionEngine rule '${kind}' produced invalid item; dropping: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }
        if (seen.has(item.dedupeKey)) continue;
        seen.add(item.dedupeKey);
        collected.push(item);
      }
    }

    collected.sort(compareByPriority);
    this.projection.apply(collected);
    const finalItems = this.projection.getAll();
    this.#emitChangesIfAny(finalItems);
    return finalItems;
  }

  /**
   * SH-4-09: diff `nextItems` against `this._prior`; if any of the DoD-listed
   * user-visible changes is present (created / cleared / ack-ed / snoozed /
   * severity flipped), invoke `this.onChange(payload)`. Always updates
   * `_prior` so the next call diffs against the right baseline. Silent ticks
   * (no qualifying change) MUST NOT fire `onChange` per the DoD.
   *
   * @param {AttentionItem[]} nextItems
   */
  #emitChangesIfAny(nextItems) {
    /** @type {AttentionItem[]} */
    const added = [];
    /** @type {AttentionItem[]} */
    const removed = [];
    /** @type {AttentionItem[]} */
    const ackChanged = [];
    /** @type {AttentionItem[]} */
    const snoozeChanged = [];
    /** @type {AttentionItem[]} */
    const severityChanged = [];

    /** @type {Map<string, { severity: string, acknowledgedAt?: string, snoozedUntil?: string, clearedAt?: string, item: AttentionItem }>} */
    const nextPrior = new Map();
    /** @type {Set<string>} */
    const seenInNext = new Set();

    for (const item of nextItems) {
      const key = item.dedupeKey;
      seenInNext.add(key);
      const snap = {
        severity: item.severity,
        acknowledgedAt: item.acknowledgedAt,
        snoozedUntil: item.snoozedUntil,
        clearedAt: item.clearedAt,
        item,
      };
      nextPrior.set(key, snap);

      const prev = this._prior.get(key);
      if (!prev) {
        added.push(item);
        // A newly-arrived item that's already ack'd / snoozed / cleared still
        // counts as a "created" event only (avoid double-firing).
        continue;
      }
      if (prev.severity !== item.severity) {
        severityChanged.push(item);
      }
      if (prev.acknowledgedAt === undefined && item.acknowledgedAt !== undefined) {
        ackChanged.push(item);
      }
      if (prev.snoozedUntil !== item.snoozedUntil) {
        snoozeChanged.push(item);
      }
      // `clearedAt` transition (undefined -> set) on a still-present item
      // counts as "cleared" per the DoD ("explicit clearedAt set; either
      // condition").
      if (prev.clearedAt === undefined && item.clearedAt !== undefined) {
        removed.push(item);
      }
    }

    for (const [key, prev] of this._prior) {
      if (!seenInNext.has(key)) {
        removed.push(prev.item);
      }
    }

    this._prior = nextPrior;

    const fired =
      added.length > 0 ||
      removed.length > 0 ||
      ackChanged.length > 0 ||
      snoozeChanged.length > 0 ||
      severityChanged.length > 0;
    if (!fired) return;
    if (typeof this.onChange !== "function") return;

    try {
      this.onChange({
        items: nextItems,
        scope: "global",
        changes: { added, removed, ackChanged, snoozeChanged, severityChanged },
      });
    } catch (err) {
      if (this.logger && typeof this.logger.error === "function") {
        this.logger.error(
          `AttentionEngine.onChange threw; suppressing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Direct accessor for the unbound rule (mostly for tests). Forwards to the
   * pure `unboundSessionRule` with the engine's resolved config + makeId.
   *
   * @param {object} session
   * @param {Date}   [now]
   * @returns {AttentionItem | null}
   */
  unboundSessionRule(session, now) {
    return unboundSessionRule(
      session,
      now instanceof Date ? now : this.now(),
      resolveUntaskedConfig(this.config),
      this.makeId,
    );
  }
}

/**
 * Adapter that drives `unboundSessionRule` over the engine's snapshot
 * input — one item per qualifying session.
 *
 * @param {{ sessions: object[], now: Date }} input
 * @param {object} engineConfig
 * @param {(prefix: string) => string} makeId
 * @returns {AttentionItem[]}
 */
function runUnboundSessionRule(input, engineConfig, makeId) {
  const cfg = resolveUntaskedConfig(engineConfig);
  /** @type {AttentionItem[]} */
  const out = [];
  for (const session of input.sessions) {
    const item = unboundSessionRule(session, input.now, cfg, makeId);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Pull the `untaskedSessions` slice off the engine config (TDD §25), with
 * default fallbacks. Validates both numbers are positive finite numbers so a
 * malformed config can't disable the rule silently.
 *
 * @param {object} engineConfig
 * @returns {{ unboundAttentionAfterMinutes: number, unboundAutoArchiveAfterHours: number }}
 */
function resolveUntaskedConfig(engineConfig) {
  const raw =
    engineConfig &&
    typeof engineConfig === "object" &&
    engineConfig.untaskedSessions &&
    typeof engineConfig.untaskedSessions === "object"
      ? engineConfig.untaskedSessions
      : {};
  const mins = positiveNumber(
    raw.unboundAttentionAfterMinutes,
    DEFAULT_UNTASKED_SESSIONS_CONFIG.unboundAttentionAfterMinutes,
  );
  const hours = positiveNumber(
    raw.unboundAutoArchiveAfterHours,
    DEFAULT_UNTASKED_SESSIONS_CONFIG.unboundAutoArchiveAfterHours,
  );
  return { unboundAttentionAfterMinutes: mins, unboundAutoArchiveAfterHours: hours };
}

function positiveNumber(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Test-friendly id factory: monotonic counter with the requested prefix.
 * Production callers should pass `makeRuntimeId` from `hub/runtime/ids.js`
 * so generated AttentionItem ids match the canonical ULID shape.
 *
 * @returns {(prefix: string) => string}
 */
function defaultMakeId() {
  let n = 0;
  return (prefix) => {
    n += 1;
    // Pad to 26 chars to mimic ULID body length; uses only Crockford-safe
    // characters so `att_…` ids would survive `ATTENTION_ITEM_ID_RE` matches
    // if the test reuses them.
    const body = n.toString(36).padStart(26, "0");
    return `${prefix}_${body}`;
  };
}
