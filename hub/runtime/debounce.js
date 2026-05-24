// hub/runtime/debounce.js — Session Hub Phase 1 (TDD v0.5 §5.3, §23.2 #8, §25)
//
// SH-1-06 SnapshotDebouncer.
//
// Three triggers cause the supplied `flushFn` to run:
//   1. quiet period — no `schedule()` call for `debounceMs` (default 250ms)
//   2. max age — once a "pending burst" begins, a flush is forced within
//      `maxAgeMs` (default 5000ms) even if events keep arriving and the
//      quiet-period timer keeps getting re-armed.
//   3. max pending — when `maxEventsPending` (default 250) schedules accumulate
//      without a flush, fire immediately on the Nth call.
//
// `shutdown()` cancels timers and, when `flushOnShutdown` is true (default),
// runs any pending flush so a graceful exit doesn't drop state. It also awaits
// any in-flight async flush before resolving.
//
// Tests inject a fake clock via `{setTimer, clearTimer, now}` so we never
// depend on wall time. The flush thunk itself is stored on every `schedule()`
// call so the most recent thunk wins — the debouncer doesn't try to merge
// callers; callers pass a closure that reads the latest projection.

export class SnapshotDebouncer {
  constructor({
    debounceMs = 250,
    maxAgeMs = 5000,
    maxEventsPending = 250,
    flushOnShutdown = true,
    // Injected for tests; defaults to host setTimeout/clearTimeout/Date.now.
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    now = () => Date.now(),
  } = {}) {
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new TypeError("SnapshotDebouncer: debounceMs must be a finite number >= 0");
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < debounceMs) {
      throw new TypeError("SnapshotDebouncer: maxAgeMs must be a finite number >= debounceMs");
    }
    if (!Number.isFinite(maxEventsPending) || maxEventsPending < 1) {
      throw new TypeError("SnapshotDebouncer: maxEventsPending must be a finite number >= 1");
    }
    if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("SnapshotDebouncer: setTimer/clearTimer must be functions");
    }
    if (typeof now !== "function") {
      throw new TypeError("SnapshotDebouncer: now must be a function");
    }

    this.debounceMs = debounceMs;
    this.maxAgeMs = maxAgeMs;
    this.maxEventsPending = maxEventsPending;
    this.flushOnShutdown = !!flushOnShutdown;

    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._now = now;

    this._flushFn = null;
    this._debounceHandle = null;
    this._maxAgeHandle = null;
    this._pendingCount = 0;
    this._firstPendingAt = null;
    this._inFlight = null; // Promise representing the current flush chain
    this._closed = false;

    /** Last error thrown by `flushFn`; populated by `_fireFlush` for tests. */
    this.lastFlushError = null;
  }

  /** Count of events queued since the last flush. Exposed for tests. */
  get pendingCount() {
    return this._pendingCount;
  }

  /** True iff a debounce or max-age timer is currently armed. */
  get isArmed() {
    return this._debounceHandle != null || this._maxAgeHandle != null;
  }

  /**
   * Note a new event and arm/refresh timers as needed. `flushFn` is captured
   * on every call so the most recent closure wins. The debouncer never
   * inspects the event itself.
   *
   * @param {() => (void | Promise<void>)} flushFn
   */
  schedule(flushFn) {
    if (this._closed) return;
    if (typeof flushFn !== "function") {
      throw new TypeError("SnapshotDebouncer.schedule: flushFn must be a function");
    }
    this._flushFn = flushFn;
    this._pendingCount += 1;
    if (this._firstPendingAt === null) this._firstPendingAt = this._now();

    // Max-pending trigger: short-circuit timers and flush right away. This
    // covers the burst case where 250 events arrive faster than `debounceMs`.
    if (this._pendingCount >= this.maxEventsPending) {
      this._fireFlush();
      return;
    }

    // (Re)arm the quiet-period timer.
    if (this._debounceHandle != null) this._clearTimer(this._debounceHandle);
    this._debounceHandle = this._setTimer(() => this._fireFlush(), this.debounceMs);

    // Arm the max-age timer once per pending burst — re-arming it on every
    // schedule would defeat its purpose (it would slide forward indefinitely).
    if (this._maxAgeHandle == null) {
      this._maxAgeHandle = this._setTimer(() => this._fireFlush(), this.maxAgeMs);
    }
  }

  /**
   * Force a flush now (used internally by timers and by `flush()`/`shutdown()`).
   * Safe to call repeatedly — a no-op if no events are pending.
   */
  _fireFlush() {
    if (this._debounceHandle != null) {
      this._clearTimer(this._debounceHandle);
      this._debounceHandle = null;
    }
    if (this._maxAgeHandle != null) {
      this._clearTimer(this._maxAgeHandle);
      this._maxAgeHandle = null;
    }
    const fn = this._flushFn;
    if (!fn || this._pendingCount === 0) return;

    // Reset pending state BEFORE invoking `fn`. If new events arrive while
    // `fn` runs they begin a fresh pending burst and re-arm timers normally.
    this._pendingCount = 0;
    this._firstPendingAt = null;

    // Chain onto any in-flight flush so back-to-back forced flushes
    // (e.g. max-pending followed by a stragglers-only quiet flush) run
    // serially rather than overlap.
    const run = async () => {
      try {
        await fn();
      } catch (err) {
        // Never throw out of a timer callback — surface via lastFlushError so
        // tests / production code can choose how to react.
        this.lastFlushError = err;
      }
    };
    this._inFlight = (this._inFlight || Promise.resolve()).then(run);
  }

  /**
   * Force a flush and await its completion. Resolves once any pending events
   * have been written by `flushFn` and any prior in-flight flush has settled.
   */
  async flush() {
    this._fireFlush();
    if (this._inFlight) await this._inFlight;
  }

  /**
   * Mark the debouncer closed. Pending events are flushed iff `flushOnShutdown`
   * is true. In-flight flushes are always awaited before resolution so callers
   * can `await debouncer.shutdown()` during graceful exit.
   *
   * After `shutdown()` further `schedule()` calls are no-ops.
   */
  async shutdown() {
    this._closed = true;
    if (this._debounceHandle != null) {
      this._clearTimer(this._debounceHandle);
      this._debounceHandle = null;
    }
    if (this._maxAgeHandle != null) {
      this._clearTimer(this._maxAgeHandle);
      this._maxAgeHandle = null;
    }
    if (this.flushOnShutdown && this._pendingCount > 0) {
      this._fireFlush();
    } else {
      // Discarding pending events: clear state so getters reflect reality.
      this._pendingCount = 0;
      this._firstPendingAt = null;
    }
    if (this._inFlight) await this._inFlight;
  }
}
