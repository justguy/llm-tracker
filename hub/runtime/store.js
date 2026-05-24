// hub/runtime/store.js — Session Hub Phase 1 (TDD v0.5 §5, §6.6, §5.3)
//
// RuntimeStore skeleton (sh-1-01) + idempotency dedupe (sh-1-03)
// + snapshot debouncer wiring (sh-1-06).
//   - one AsyncWriteQueue per instance
//   - workspace-root-derived paths
//   - event normalization with canonical `evt_…` IDs
//   - client-ID rejection outside an explicit test-fixture mode
//   - a single hook (`onAppend`) so downstream tasks can plug in:
//       sh-1-02 (schema validator), sh-1-04 (JSONL writer),
//       sh-1-05 (projection + real rev), sh-1-08 (WS broadcaster).
//   - sh-1-03: in-memory idempotency dedupe by
//     (sessionId?, jobId?, source, idempotencyKey) within a configurable
//     window (default 5 min). When a retried call matches a prior one we
//     return the prior `{eventId, rev}` without re-enqueuing.
//   - sh-1-06: optional SnapshotDebouncer. When the caller supplies
//     `writeSnapshots`, every NON-deduped append schedules a snapshot write
//     via the debouncer (250ms quiet period; force-flush at 5s max-age or
//     250 events pending; flush-on-shutdown by default).
//
// `rev` is a local counter here — sh-1-05 will swap it for the projection
// revision. The shape of the return value is stable: `{ ok, eventId, rev }`,
// with an optional `deduped: true` flag set on idempotency hits.

import { AsyncWriteQueue } from "./queue.js";
import { makePaths } from "./paths.js";
import { makeRuntimeId, RUNTIME_EVENT_ID_RE } from "./ids.js";
import { IdempotencyIndex, DEFAULT_DEDUPE_WINDOW_MS } from "./idempotency.js";
import { SnapshotDebouncer } from "./debounce.js";

/**
 * @typedef {Object} RuntimeAppendResult
 * @property {true}   ok
 * @property {string} eventId   canonical `evt_…` ID assigned to the event
 * @property {number} rev       runtime revision after this append
 * @property {true}   [deduped] present only when the call was short-circuited
 *                              by the idempotency index (sh-1-03)
 */

/**
 * @typedef {Object} RuntimeStoreOptions
 * @property {string}                           workspaceRoot
 * @property {boolean}                          [allowClientIds=false] test-fixture mode
 * @property {(event: object) => Promise<void> | void} [onAppend]    plug point for later phases
 * @property {number}                           [idempotencyWindowMs] dedupe window in ms (default 5 min)
 * @property {() => number}                     [clock]               ms-since-epoch source for the idempotency index (tests inject)
 * @property {() => (void | Promise<void>)}     [writeSnapshots]      sh-1-06: when supplied, every appended event triggers a debounced snapshot write
 * @property {SnapshotDebouncer}                [snapshotDebouncer]   sh-1-06: caller-supplied debouncer (test-injection hook); overrides per-option ctor args
 * @property {number}                           [snapshotDebounceMs]  sh-1-06: quiet-period (default 250ms)
 * @property {number}                           [snapshotMaxAgeMs]    sh-1-06: max time between flushes (default 5000ms)
 * @property {number}                           [snapshotMaxEventsPending] sh-1-06: max pending events before forced flush (default 250)
 * @property {boolean}                          [flushOnShutdown=true] sh-1-06: flush pending snapshots on shutdown()
 */

export class RuntimeStore {
  /** @param {RuntimeStoreOptions} opts */
  constructor({
    workspaceRoot,
    allowClientIds = false,
    onAppend,
    idempotencyWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    clock = Date.now,
    writeSnapshots,
    snapshotDebouncer,
    snapshotDebounceMs,
    snapshotMaxAgeMs,
    snapshotMaxEventsPending,
    flushOnShutdown,
  } = {}) {
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      throw new TypeError("RuntimeStore: workspaceRoot is required (non-empty string)");
    }
    this.workspaceRoot = workspaceRoot;
    this.paths = makePaths({ workspaceRoot });
    this.allowClientIds = !!allowClientIds;
    this.onAppend = typeof onAppend === "function" ? onAppend : async () => {};
    this.queue = new AsyncWriteQueue();
    this.rev = 0;
    this.idempotency = new IdempotencyIndex({ windowMs: idempotencyWindowMs, clock });

    // sh-1-06 snapshot debouncer wiring.
    //   * If the caller passed an explicit `snapshotDebouncer`, honor it.
    //   * Else, if `writeSnapshots` is supplied, build a SnapshotDebouncer with
    //     §25 defaults (overridable via the per-option ctor args).
    //   * Otherwise, leave it null — append() simply skips the schedule step.
    this.writeSnapshots = typeof writeSnapshots === "function" ? writeSnapshots : null;
    if (snapshotDebouncer) {
      this.snapshotDebouncer = snapshotDebouncer;
    } else if (this.writeSnapshots) {
      this.snapshotDebouncer = new SnapshotDebouncer({
        ...(snapshotDebounceMs !== undefined ? { debounceMs: snapshotDebounceMs } : {}),
        ...(snapshotMaxAgeMs !== undefined ? { maxAgeMs: snapshotMaxAgeMs } : {}),
        ...(snapshotMaxEventsPending !== undefined
          ? { maxEventsPending: snapshotMaxEventsPending }
          : {}),
        ...(flushOnShutdown !== undefined ? { flushOnShutdown } : {}),
      });
    } else {
      this.snapshotDebouncer = null;
    }
  }

  /**
   * Graceful-shutdown hook for the store. sh-1-06 flushes any pending snapshot
   * write through the debouncer (when `flushOnShutdown` is true). Later phases
   * can extend this to close the WS broadcaster, drain the JSONL writer, etc.
   */
  async shutdown() {
    if (this.snapshotDebouncer) await this.snapshotDebouncer.shutdown();
  }

  /**
   * Enqueue an event onto the single async write queue. Generates an `evt_…`
   * ID if missing; rejects client-supplied IDs unless the store was
   * constructed with `{ allowClientIds: true }`.
   *
   * sh-1-03 dedupe contract:
   *   - The dedupe key tuple is `(sessionId?, jobId?, source, idempotencyKey)`.
   *   - `sessionId`/`jobId` are read from the top level first
   *     (`event.sessionId`, `event.jobId`), falling back to the nested
   *     `event.session.id` / `event.job.id` shapes that some §6.7+ variants
   *     use. Both are optional; missing components become empty strings in
   *     the key.
   *   - Lookup is a fast in-memory map read performed BEFORE queueing, so
   *     duplicate retries never queue or invoke the `onAppend` hook.
   *   - The dedupe entry is RECORDED inside the queue's run, after `onAppend`
   *     resolves, so retries always see a fully-committed prior result.
   *   - Events without `idempotencyKey` (or without `source`) bypass dedupe
   *     entirely and always append.
   *
   * The full pipeline (validate → JSONL append → projection apply → WS
   * broadcast) lands in later sh-1-xx tasks. For sh-1-01/03 we only invoke
   * the `onAppend` hook and bump a local rev counter.
   *
   * @param {object} event
   * @returns {Promise<RuntimeAppendResult>}
   */
  append(event) {
    // Dedupe lookup happens OUTSIDE the queue (cheap in-memory map read), so
    // a retry storm cannot back up behind a slow onAppend. The key is built
    // from the caller's raw event (pre-normalize) — normalize only assigns
    // `id`, it doesn't move sessionId/jobId/source/idempotencyKey.
    const dedupeKey = this.#dedupeKeyFor(event);
    if (dedupeKey) {
      const hit = this.idempotency.get(dedupeKey);
      if (hit) {
        return Promise.resolve({ ok: true, eventId: hit.eventId, rev: hit.rev, deduped: true });
      }
    }

    return this.queue.run(async () => {
      // Re-check inside the queue in case a prior concurrent retry won the
      // race and populated the index while this call was waiting. This keeps
      // the dedupe guarantee even when N retries arrive in the same tick.
      if (dedupeKey) {
        const hit = this.idempotency.get(dedupeKey);
        if (hit) {
          return { ok: true, eventId: hit.eventId, rev: hit.rev, deduped: true };
        }
      }
      const normalized = this.#normalize(event);
      await this.onAppend(normalized);
      this.rev += 1;
      const result = { ok: true, eventId: normalized.id, rev: this.rev };
      if (dedupeKey) {
        this.idempotency.set(dedupeKey, { eventId: result.eventId, rev: result.rev });
      }
      // sh-1-06: every NON-deduped append nudges the snapshot debouncer.
      // The thunk closes over `this.writeSnapshots` so per-call rebinding by
      // tests/integration is honored. Errors thrown by writeSnapshots surface
      // via `snapshotDebouncer.lastFlushError`, not as append() rejections.
      if (this.snapshotDebouncer && this.writeSnapshots) {
        this.snapshotDebouncer.schedule(() => this.writeSnapshots());
      }
      return result;
    });
  }

  /**
   * Extract the dedupe-key components from a raw event. Returns null if the
   * event isn't a plain object, lacks `idempotencyKey`, or lacks `source`.
   *
   * @param {unknown} event
   * @returns {string|null}
   */
  #dedupeKeyFor(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    const ev = /** @type {any} */ (event);
    if (!ev.idempotencyKey || typeof ev.idempotencyKey !== "string") return null;
    if (typeof ev.source !== "string" || !ev.source) return null;
    const sessionId =
      typeof ev.sessionId === "string" && ev.sessionId
        ? ev.sessionId
        : ev.session && typeof ev.session.id === "string"
          ? ev.session.id
          : undefined;
    const jobId =
      typeof ev.jobId === "string" && ev.jobId
        ? ev.jobId
        : ev.job && typeof ev.job.id === "string"
          ? ev.job.id
          : undefined;
    return IdempotencyIndex.key({
      sessionId,
      jobId,
      source: ev.source,
      idempotencyKey: ev.idempotencyKey,
    });
  }

  /**
   * Validate / fill in the event's `id` field.
   * - Missing `id`           → generate `evt_…`.
   * - Present but not evt_…  → reject always (even in test-fixture mode).
   * - Present and valid:
   *     - allowClientIds=true  → keep it
   *     - allowClientIds=false → reject
   *
   * @param {object} event
   */
  #normalize(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("RuntimeStore.append: event must be a plain object");
    }
    let { id } = event;
    if (id === undefined || id === null) {
      id = makeRuntimeId("evt");
    } else {
      if (typeof id !== "string" || !RUNTIME_EVENT_ID_RE.test(id)) {
        throw new Error(
          `RuntimeStore.append: invalid client-supplied event.id ${JSON.stringify(id)} (expected evt_<26 Crockford base32 chars>)`,
        );
      }
      if (!this.allowClientIds) {
        throw new Error(
          "RuntimeStore.append: client-supplied event.id rejected (allowClientIds=false); the hub assigns runtime IDs (TDD §6.10)",
        );
      }
    }
    return { ...event, id };
  }
}
