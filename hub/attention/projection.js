// hub/attention/projection.js — SH-4-02 (TDD v0.5 §8A.3, §8A.4)
//
// AttentionProjection — the in-memory active set of AttentionItem records.
//
// What this module is responsible for:
//   - Holding the current "active" attention items keyed by their `dedupeKey`
//     (§8A.4). The engine in `./engine.js` drives the set by handing the
//     projection a freshly-computed array of items each tick. Existing items
//     keep their stable `id` and first-raised `createdAt` when the same
//     dedupeKey appears again.
//   - Indexed lookup by `id`, by `sessionId`, and a bulk `getAll()` ordered
//     by the engine's emitted §8A.3 priority order (caller's sort wins).
//
// What this module does NOT do:
//   - Compute items. The engine owns rule evaluation; the projection only
//     stores what the engine produced.
//   - Persist anything durable. Per §8A.3 the engine is a projection; ack /
//     snooze events are sh-4-05 territory.
//   - Validate item shapes. The engine validates via `assertValidAttentionItem`
//     before handing items off; projection trusts its input.

/**
 * @typedef {import("./types.js").AttentionItem} AttentionItem
 */

/**
 * Pure projection state. The engine calls `apply(items)` with the freshly-
 * computed active set; the projection swaps its internal map atomically so
 * `getAll()` between ticks always returns a consistent snapshot.
 */
export class AttentionProjection {
  constructor() {
    /** @type {Map<string, AttentionItem>} dedupeKey -> item */
    this._byDedupeKey = new Map();
    /** @type {Map<string, AttentionItem>} id -> item */
    this._byId = new Map();
    /** @type {string[]} insertion order for getAll() */
    this._order = [];
  }

  /**
   * Replace the active set with `items`. Preserves the array order (callers
   * pass items already sorted per §8A.3). Items missing `id` or `dedupeKey`
   * are skipped — defensive only; the engine validates first.
   *
   * @param {AttentionItem[]} items
   * @returns {void}
   */
  apply(items) {
    if (!Array.isArray(items)) {
      throw new TypeError("AttentionProjection.apply: items must be an array");
    }
    const previousByDedupe = this._byDedupeKey;
    const nextByDedupe = new Map();
    const nextById = new Map();
    const nextOrder = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.dedupeKey !== "string" || item.dedupeKey.length === 0) continue;
      if (typeof item.id !== "string" || item.id.length === 0) continue;
      if (nextByDedupe.has(item.dedupeKey)) continue; // dedupe within tick
      const previous = previousByDedupe.get(item.dedupeKey);
      const stableItem = previous
        ? {
            ...item,
            id: previous.id,
            createdAt: previous.createdAt,
            ...(previous.acknowledgedAt !== undefined && item.acknowledgedAt === undefined
              ? { acknowledgedAt: previous.acknowledgedAt }
              : {}),
            ...(previous.snoozedUntil !== undefined && item.snoozedUntil === undefined
              ? { snoozedUntil: previous.snoozedUntil }
              : {}),
            ...(previous.clearedAt !== undefined && item.clearedAt === undefined
              ? { clearedAt: previous.clearedAt }
              : {}),
          }
        : item;
      nextByDedupe.set(stableItem.dedupeKey, stableItem);
      nextById.set(stableItem.id, stableItem);
      nextOrder.push(item.dedupeKey);
    }
    this._byDedupeKey = nextByDedupe;
    this._byId = nextById;
    this._order = nextOrder;
  }

  /**
   * Active items in the order they were applied (engine-sorted by §8A.3).
   * @returns {AttentionItem[]}
   */
  getAll() {
    const out = [];
    for (const key of this._order) {
      const item = this._byDedupeKey.get(key);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * Look up by attention item id. Returns null when absent.
   *
   * @param {string} id
   * @returns {AttentionItem | null}
   */
  getById(id) {
    if (typeof id !== "string") return null;
    return this._byId.get(id) || null;
  }

  /**
   * Look up by dedupe key. Returns null when absent.
   *
   * @param {string} dedupeKey
   * @returns {AttentionItem | null}
   */
  getByDedupeKey(dedupeKey) {
    if (typeof dedupeKey !== "string") return null;
    return this._byDedupeKey.get(dedupeKey) || null;
  }

  /**
   * All active items targeting `sessionId`. Preserves engine sort order.
   *
   * @param {string} sessionId
   * @returns {AttentionItem[]}
   */
  getBySession(sessionId) {
    if (typeof sessionId !== "string") return [];
    const out = [];
    for (const item of this.getAll()) {
      if (item.sessionId === sessionId) out.push(item);
    }
    return out;
  }

  /**
   * Number of active items.
   * @returns {number}
   */
  size() {
    return this._byDedupeKey.size;
  }

  /**
   * Drop every active item (for tests / hub shutdown).
   * @returns {void}
   */
  clear() {
    this._byDedupeKey = new Map();
    this._byId = new Map();
    this._order = [];
  }
}
