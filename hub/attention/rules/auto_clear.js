// hub/attention/rules/auto_clear.js — SH-4-04 (TDD v0.5 §8A.3 "Clear rules")
//
// Wraps a per-kind AttentionEngine rule so that previously-emitted items
// the inner rule no longer surfaces get exactly ONE final tick with
// `clearedAt: input.now.toISOString()` set. The AttentionEngine's diff
// (`#emitChangesIfAny`) then broadcasts the clear via `changes.removed`,
// matching TDD §8A.3 which defines each kind's clear condition as the
// inverse of its trigger:
//
//   - approval_needed clears on structured approval resolution / human clear
//   - blocked clears on structured status change, human clear, or job done
//   - not_responding clears on next structured heartbeat/event
//   - quiet clears on next raw output for dumb-terminal sessions
//   - context_high clears on rollover/archive/structured drop
//   - done_needs_closeout clears when closeout/handoff/archive is satisfied
//   - conflict / outside_allowed_paths clear when evidence/ack resolves
//
// In every case the inner per-kind rule already encodes the trigger; when
// it stops emitting an item, the wrapper synthesises the clear marker.
//
// What this module deliberately does NOT do:
//   - Wrap the `unbound_session` rule. That rule ships from
//     `hub/attention/engine.js` (SH-4-02), is not listed in §8A.3 clear
//     rules, and lives outside this task's allowed_paths.
//   - Persist prior-tick state across process restarts. The engine is a
//     pure projection; durable ack/snooze/clear lives in SH-4-05.
//   - Defer the clear by any debounce/grace window. If a rule's trigger
//     flips back true on the very next tick, the wrapped rule emits a
//     fresh raise (without clearedAt) and projection identity restores
//     the prior `id`/`createdAt` via dedupeKey.

/**
 * @typedef {import("../types.js").AttentionItem} AttentionItem
 */

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
 * Wrap a rule with auto-clear behaviour. The returned function has the
 * same `AttentionRuleFn` signature as the inner rule and is safe to pass
 * directly to `AttentionEngine.registerRule`.
 *
 * Lifecycle (per dedupeKey):
 *   1. Inner emits item X → wrapper retains X in its prior map.
 *   2. Inner stops emitting X → wrapper emits `{...X, clearedAt: nowIso,
 *      updatedAt: nowIso}` for this tick and drops X from the prior map.
 *      Engine diff broadcasts the clear (prev.clearedAt undefined →
 *      item.clearedAt set goes into `changes.removed`).
 *   3. Subsequent ticks with the trigger still absent emit nothing for X.
 *      The engine's `_prior` loop may fire one more `removed` event for X
 *      from its own tick-over-tick diff. This is benign and out of this
 *      task's allowed_paths to dedupe.
 *
 * Inner rule throws → re-throw and preserve the prior map so the next
 * non-throw tick can still emit clear markers if the trigger has gone.
 *
 * @param {AttentionRuleFn} ruleFn
 * @returns {AttentionRuleFn}
 */
export function wrapRuleWithAutoClear(ruleFn) {
  if (typeof ruleFn !== "function") {
    throw new TypeError("wrapRuleWithAutoClear: ruleFn must be a function");
  }

  /** @type {Map<string, AttentionItem>} */
  let prior = new Map();

  return function autoClearWrapped(input) {
    const inner = ruleFn(input);
    const now = input && input.now instanceof Date ? input.now : new Date();
    const nowIso = now.toISOString();

    const innerItems =
      inner === null || inner === undefined
        ? []
        : Array.isArray(inner)
          ? inner
          : [inner];

    /** @type {AttentionItem[]} */
    const out = [];
    /** @type {Map<string, AttentionItem>} */
    const next = new Map();

    for (const item of innerItems) {
      if (item && typeof item === "object" && typeof item.dedupeKey === "string" && item.dedupeKey.length > 0) {
        next.set(item.dedupeKey, item);
      }
      out.push(item);
    }

    for (const [key, prev] of prior) {
      if (next.has(key)) continue;
      // Skip if the prior item was already marked cleared — re-emitting it
      // would cause a duplicate `removed` broadcast and the engine's _prior
      // loop will record the eviction anyway.
      if (typeof prev.clearedAt === "string" && prev.clearedAt.length > 0) continue;
      out.push({ ...prev, clearedAt: nowIso, updatedAt: nowIso });
    }

    prior = next;
    return out;
  };
}

/**
 * Test helper: build a wrapped rule plus a peek function exposing the
 * internal prior map. Tests can assert that the prior map is updated /
 * drained correctly without depending on the AttentionEngine.
 *
 * @param {AttentionRuleFn} ruleFn
 * @returns {{ wrapped: AttentionRuleFn, peekPrior: () => Map<string, AttentionItem> }}
 */
export function wrapRuleWithAutoClearForTest(ruleFn) {
  if (typeof ruleFn !== "function") {
    throw new TypeError("wrapRuleWithAutoClearForTest: ruleFn must be a function");
  }
  /** @type {Map<string, AttentionItem>} */
  let prior = new Map();
  const wrapped = (input) => {
    const inner = ruleFn(input);
    const now = input && input.now instanceof Date ? input.now : new Date();
    const nowIso = now.toISOString();
    const innerItems =
      inner === null || inner === undefined
        ? []
        : Array.isArray(inner)
          ? inner
          : [inner];
    /** @type {AttentionItem[]} */
    const out = [];
    /** @type {Map<string, AttentionItem>} */
    const next = new Map();
    for (const item of innerItems) {
      if (item && typeof item === "object" && typeof item.dedupeKey === "string" && item.dedupeKey.length > 0) {
        next.set(item.dedupeKey, item);
      }
      out.push(item);
    }
    for (const [key, prev] of prior) {
      if (next.has(key)) continue;
      if (typeof prev.clearedAt === "string" && prev.clearedAt.length > 0) continue;
      out.push({ ...prev, clearedAt: nowIso, updatedAt: nowIso });
    }
    prior = next;
    return out;
  };
  return { wrapped, peekPrior: () => prior };
}
