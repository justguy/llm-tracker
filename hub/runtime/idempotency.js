// hub/runtime/idempotency.js — Session Hub Phase 1 (TDD v0.5 §6.6)
//
// SH-1-03: Idempotency dedupe index for RuntimeStore.
//
// Tracks recently-appended events keyed by (sessionId?, jobId?, source, idempotencyKey).
// When the same key appears within `windowMs` (default 5 minutes), append() can
// short-circuit and return the prior result without re-emitting the event.
//
// The index lives in memory only — it doesn't persist to disk. On hub restart
// the dedupe history is lost; that's acceptable because retries typically
// happen within seconds of the original call.
//
// Pruning: oldest entries are dropped lazily on every get when the candidate's
// recordedAt is older than `windowMs`. There's no background timer, so an idle
// store doesn't keep a setTimeout alive. Callers may invoke `prune()`
// explicitly to sweep the full map.

export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} IdempotencyEntry
 * @property {string} eventId
 * @property {number} rev
 * @property {number} recordedAt   ms-since-epoch from the injected clock
 */

/**
 * @typedef {Object} IdempotencyIndexOptions
 * @property {number}        [windowMs]  dedupe window in ms (default 5 min)
 * @property {() => number}  [clock]     ms-since-epoch source (default Date.now)
 */

export class IdempotencyIndex {
  /** @param {IdempotencyIndexOptions} [opts] */
  constructor({ windowMs = DEFAULT_DEDUPE_WINDOW_MS, clock = Date.now } = {}) {
    if (!Number.isFinite(windowMs) || windowMs < 0) {
      throw new TypeError(
        `IdempotencyIndex: windowMs must be a non-negative number (got ${windowMs})`,
      );
    }
    if (typeof clock !== "function") {
      throw new TypeError("IdempotencyIndex: clock must be a function returning ms-since-epoch");
    }
    this.windowMs = windowMs;
    this.clock = clock;
    /** @type {Map<string, IdempotencyEntry>} */
    this.entries = new Map();
  }

  /**
   * Build the canonical dedupe key tuple. Returns null if either
   * `idempotencyKey` or `source` is missing/non-string — both are required by
   * §6.6 for an event to participate in dedupe.
   *
   * The `sessionId` and `jobId` components are optional. The empty string is
   * used as a sentinel when absent so that, e.g., a key with sessionId="s1" but
   * no jobId is distinct from a key with the same idempotencyKey under a
   * different sessionId.
   *
   * @param {{sessionId?: string, jobId?: string, source?: string, idempotencyKey?: string}} parts
   * @returns {string|null}
   */
  static key({ sessionId, jobId, source, idempotencyKey } = {}) {
    if (!idempotencyKey || typeof idempotencyKey !== "string") return null;
    if (typeof source !== "string" || !source) return null;
    return `${sessionId ?? ""}::${jobId ?? ""}::${source}::${idempotencyKey}`;
  }

  /**
   * Return the cached `{eventId, rev}` for a key if it's still within window,
   * else null. Expired entries are deleted lazily on lookup.
   *
   * @param {string|null|undefined} key
   * @returns {{eventId: string, rev: number}|null}
   */
  get(key) {
    if (!key) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.clock() - entry.recordedAt > this.windowMs) {
      this.entries.delete(key);
      return null;
    }
    return { eventId: entry.eventId, rev: entry.rev };
  }

  /**
   * Record a fresh dedupe hit. No-op if key is falsy (so callers can blindly
   * pass the result of `IdempotencyIndex.key(...)`).
   *
   * @param {string|null|undefined} key
   * @param {{eventId: string, rev: number}} record
   */
  set(key, { eventId, rev }) {
    if (!key) return;
    this.entries.set(key, { eventId, rev, recordedAt: this.clock() });
  }

  /**
   * Sweep all entries older than `windowMs`. Tests call this to verify pruning
   * behavior; production code relies on lazy pruning in `get()`.
   */
  prune() {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (now - entry.recordedAt > this.windowMs) this.entries.delete(key);
    }
  }

  /** Current number of live entries (post any lazy deletions). */
  get size() {
    return this.entries.size;
  }
}
