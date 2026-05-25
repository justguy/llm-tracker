// hub/attention/index.js — public exports for attention model/projection/engine.

export {
  ATTENTION_ACTION_KINDS,
  ATTENTION_KINDS,
  ATTENTION_SEVERITIES,
  ATTENTION_SOURCES,
  assertValidAttentionAction,
  assertValidAttentionItem,
} from "./types.js";
export { computeAttentionDedupeKey } from "./dedupe.js";
export { AttentionProjection } from "./projection.js";
export {
  AttentionEngine,
  DEFAULT_UNTASKED_SESSIONS_CONFIG,
  PRIORITY_RANK,
  compareByPriority,
  unboundSessionRule,
} from "./engine.js";
