// hub/runtime/ws.js — Session Hub Phase 1 (sh-1-08, TDD v0.5 §5.2 + §15)
//
// Runtime WebSocket broadcaster.
//
// This module owns runtime-stream fan-out. hub/server.js mounts it separately
// from the legacy tracker UI WebSocket so the existing /ws project-broadcast
// contract stays unchanged.
//
// Pattern:
//   - Caller constructs RuntimeBroadcaster({slowClientPolicy?, slowClientThresholdBytes?}).
//   - Caller registers ws clients via broadcaster.subscribe(ws, getSnapshot).
//     On subscribe, broadcaster sends one {type:'runtime.snapshot', snapshot}
//     message synthesized from `await getSnapshot()`. The client is
//     auto-removed on 'close' or 'error'.
//   - Caller pipes RuntimeStore events into broadcaster.broadcast(event)
//     (typically by passing `broadcaster.handleAppend.bind(broadcaster)` as
//     the RuntimeStore `onAppend` hook).
//   - broadcast() is NON-BLOCKING. It iterates clients and calls ws.send()
//     without awaiting completion. Slow clients (bufferedAmount above the
//     threshold) are handled per `slowClientPolicy`:
//       'drop'  → increment a missed-events counter and periodically emit a
//                 {type:'runtime.lag', missedEvents:N} message to the slow
//                 client itself (default policy — same connection survives).
//       'close' → forcibly close the client with code 1011 + reason
//                 'slow_consumer'.
//     Either way, RuntimeStore.append's write queue completes in O(1) per
//     client, so a single slow client cannot stall hub writes.

/** ws.readyState === OPEN (1) — avoid pulling in the `ws` package for a constant. */
const WS_OPEN = 1;

/**
 * @typedef {Object} RuntimeBroadcasterOptions
 * @property {('drop'|'close')} [slowClientPolicy='drop']
 *   What to do when a client's bufferedAmount exceeds the threshold.
 * @property {number} [slowClientThresholdBytes=1048576]
 *   bufferedAmount cutoff in bytes (default 1 MiB).
 * @property {number} [lagReportEveryMessages=100]
 *   Under the 'drop' policy, after this many consecutive drops we send the
 *   slow client a 'runtime.lag' notice with the running missed-events count.
 */

/**
 * @typedef {Object} BroadcasterClient
 * @property {object} ws                  the WebSocket-like client
 * @property {number} missed              cumulative dropped messages
 * @property {number} sinceLastReport     drops since the last 'runtime.lag'
 */

export class RuntimeBroadcaster {
  /** @param {RuntimeBroadcasterOptions} [opts] */
  constructor({
    slowClientPolicy = "drop",
    slowClientThresholdBytes = 1024 * 1024, // 1 MiB
    lagReportEveryMessages = 100,
  } = {}) {
    if (slowClientPolicy !== "drop" && slowClientPolicy !== "close") {
      throw new TypeError(
        `RuntimeBroadcaster: slowClientPolicy must be 'drop' or 'close' (got ${JSON.stringify(slowClientPolicy)})`,
      );
    }
    if (!Number.isFinite(slowClientThresholdBytes) || slowClientThresholdBytes < 0) {
      throw new TypeError(
        `RuntimeBroadcaster: slowClientThresholdBytes must be a non-negative number (got ${slowClientThresholdBytes})`,
      );
    }
    if (!Number.isFinite(lagReportEveryMessages) || lagReportEveryMessages < 1) {
      throw new TypeError(
        `RuntimeBroadcaster: lagReportEveryMessages must be a positive number (got ${lagReportEveryMessages})`,
      );
    }
    this.slowClientPolicy = slowClientPolicy;
    this.slowClientThresholdBytes = slowClientThresholdBytes;
    this.lagReportEveryMessages = lagReportEveryMessages;
    /** @type {Set<BroadcasterClient>} */
    this.clients = new Set();
  }

  /**
   * Register a WebSocket client. Sends `{type:'runtime.snapshot', snapshot}`
   * as the client's first message, where `snapshot = await getSnapshot()`.
   * The client is auto-removed on 'close' or 'error'.
   *
   * @param {object} ws         WebSocket-like object (must support send, on, readyState, bufferedAmount).
   * @param {() => (Promise<any> | any)} getSnapshot
   * @returns {Promise<BroadcasterClient>} the entry stored in this.clients
   */
  async subscribe(ws, getSnapshot) {
    if (!ws || typeof ws.send !== "function" || typeof ws.on !== "function") {
      throw new TypeError("RuntimeBroadcaster.subscribe: ws must be a WebSocket-like object");
    }
    if (typeof getSnapshot !== "function") {
      throw new TypeError("RuntimeBroadcaster.subscribe: getSnapshot must be a function");
    }
    const snapshot = await getSnapshot();
    const entry = { ws, missed: 0, sinceLastReport: 0 };
    this.clients.add(entry);
    const cleanup = () => {
      this.clients.delete(entry);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    try {
      ws.send(JSON.stringify({ type: "runtime.snapshot", snapshot }));
    } catch (err) {
      cleanup();
      throw err;
    }
    return entry;
  }

  /**
   * Broadcast an event to every subscribed client. SYNCHRONOUS — does not
   * await per-client sends. Slow clients are handled per slowClientPolicy.
   *
   * @param {object} event normalized runtime event
   * @returns {void}
   */
  broadcast(event) {
    const payload = JSON.stringify({ type: "runtime.event", event });
    this.#fanout(payload);
  }

  /**
   * Broadcast a `{type:"attention.updated", items, scope}` message to every
   * subscribed client (SH-4-09, TDD §15, §8A.4). SYNCHRONOUS, reuses the
   * same slow-client policy as `broadcast()`.
   *
   * @param {{ items: object[], scope: ("global"|"project") }} payload
   * @returns {void}
   */
  broadcastAttention({ items, scope } = {}) {
    if (!Array.isArray(items)) {
      throw new TypeError(
        "RuntimeBroadcaster.broadcastAttention: items must be an array",
      );
    }
    if (scope !== "global" && scope !== "project") {
      throw new TypeError(
        `RuntimeBroadcaster.broadcastAttention: scope must be 'global' or 'project' (got ${JSON.stringify(scope)})`,
      );
    }
    const wire = JSON.stringify({ type: "attention.updated", items, scope });
    this.#fanout(wire);
  }

  /**
   * Plug-in for `RuntimeStore.onAppend`. The store awaits this hook before
   * resolving its append, so we keep this synchronous (broadcast() returns
   * void) to honour the O(1)-per-client guarantee.
   *
   * @param {object} event
   * @returns {void}
   */
  handleAppend(event) {
    this.broadcast(event);
  }

  /** Current number of subscribed clients. */
  get clientCount() {
    return this.clients.size;
  }

  /**
   * Fan a pre-serialized payload string out to every open subscriber.
   * Shared by `broadcast()` and `broadcastAttention()` so both honour the
   * same slow-client policy.
   *
   * @param {string} payload
   */
  #fanout(payload) {
    for (const entry of this.clients) {
      const { ws } = entry;
      if (ws.readyState !== WS_OPEN) continue;
      if (ws.bufferedAmount > this.slowClientThresholdBytes) {
        this.#handleSlowClient(entry);
        continue;
      }
      try {
        // Healthy clients: reset the slow-client counters so a brief slowness
        // episode doesn't trigger a perpetual lag report.
        if (entry.sinceLastReport !== 0) entry.sinceLastReport = 0;
        ws.send(payload);
      } catch {
        // Drop silently — the 'error' handler we registered in subscribe()
        // will clean up the entry.
      }
    }
  }

  /**
   * Handle a slow client per the configured policy.
   * @param {BroadcasterClient} entry
   */
  #handleSlowClient(entry) {
    entry.missed += 1;
    entry.sinceLastReport += 1;
    if (this.slowClientPolicy === "close") {
      try {
        entry.ws.close(1011, "slow_consumer");
      } catch {
        // ignore — close errors don't affect other clients
      }
      this.clients.delete(entry);
      return;
    }
    // 'drop' policy: periodically inform the slow client how many it missed.
    if (
      entry.sinceLastReport >= this.lagReportEveryMessages &&
      entry.ws.readyState === WS_OPEN
    ) {
      try {
        entry.ws.send(
          JSON.stringify({ type: "runtime.lag", missedEvents: entry.missed }),
        );
      } catch {
        // ignore — 'error' handler will reap the client
      }
      entry.sinceLastReport = 0;
    }
  }
}
