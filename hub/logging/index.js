// hub/logging/index.js — Session Hub Phase 0: Central logging + audit event interfaces
// (SH-0-02, TDD v0.5 §19, §23.2 closure 14).
//
// Two channels exposed via the shared `log` object:
//
//   - log.audit({ source, action, subject, ...meta })
//       Security/trust-relevant events that MUST be recorded for human review:
//       token rejects, gate overrides, force-claims, capture toggles, role
//       escalations, etc. Always emitted; never sampled. Default sink writes one
//       structured JSON object per line to process.stderr so log aggregators,
//       journalctl, and `jq -c` pick it up cleanly.
//
//   - log.debug({ source, action, ...meta })
//       Developer/operational tracing. Silent by default. Enabled when
//       `process.env.LLM_TRACKER_LOG_DEBUG === '1'` or `process.env.DEBUG`
//       contains the substring "llm-tracker". Also one JSON object per line on
//       stderr by default.
//
// Required fields:
//   - audit: source, action, subject  (all three; non-empty strings)
//   - debug: source, action           (subject optional)
//
// `source` is a free-form short string identifying the emitter
// ("http", "mcp", "adapter", "watcher", "system", ...). It matches
// RuntimeEventBase.source from TDD §6.6 but this layer intentionally does not
// enforce an enum — runtime event validation owns that responsibility.
//
// Test hooks:
//   - setAuditSink(fn) / setDebugSink(fn) replace the default stderr sink with
//     an in-memory capture function. Pass `null` (or call resetSinks()) to
//     restore defaults. Each sink receives the fully-formed event object
//     (already timestamped and frozen).
//
// Examples:
//
//   import { log } from './hub/logging/index.js';
//
//   // Token rejected by /api ingress:
//   log.audit({
//     source: 'http',
//     action: 'token.reject',
//     subject: 'session:s-abc123',
//     reason: 'expired',
//     remoteAddr: '127.0.0.1',
//   });
//
//   // Operator overrode an attention gate via the UI:
//   log.audit({
//     source: 'http',
//     action: 'gate.override',
//     subject: 'task:t-042',
//     actor: 'user:adi',
//     gate: 'requires_approval',
//   });
//
//   // Adapter force-claimed a session away from another holder:
//   log.audit({
//     source: 'adapter',
//     action: 'session.force_claim',
//     subject: 'session:s-xyz789',
//     previousHolder: 'pid:12345',
//     newHolder: 'pid:67890',
//   });
//
//   // Operational debug trace (only printed when LLM_TRACKER_LOG_DEBUG=1):
//   log.debug({ source: 'watcher', action: 'fs.event.coalesced', count: 7 });
//
// No third-party dependencies. Pure Node + ESM.

const AUDIT_REQUIRED_FIELDS = ['source', 'action', 'subject'];
const DEBUG_REQUIRED_FIELDS = ['source', 'action'];

const RESERVED_FIELDS = new Set(['timestamp', 'channel']);

/**
 * Default audit sink: one JSON object per line on stderr.
 * @param {object} event
 */
function defaultAuditSink(event) {
  process.stderr.write(JSON.stringify(event) + '\n');
}

/**
 * Default debug sink: one JSON object per line on stderr, but only when the
 * runtime opts in via env. Re-checked on every call so tests / operators can
 * flip the flag at runtime.
 * @param {object} event
 */
function defaultDebugSink(event) {
  if (!isDebugEnabled()) return;
  process.stderr.write(JSON.stringify(event) + '\n');
}

/**
 * @returns {boolean} true when debug logging should be emitted.
 */
function isDebugEnabled() {
  if (process.env.LLM_TRACKER_LOG_DEBUG === '1') return true;
  const dbg = process.env.DEBUG;
  if (typeof dbg === 'string' && dbg.includes('llm-tracker')) return true;
  return false;
}

let auditSink = defaultAuditSink;
let debugSink = defaultDebugSink;

/**
 * Replace the audit sink. Pass a function to capture events; pass null to
 * restore the default stderr JSON-line sink. Intended for tests.
 * @param {((event: object) => void) | null} fn
 */
export function setAuditSink(fn) {
  if (fn === null || fn === undefined) {
    auditSink = defaultAuditSink;
    return;
  }
  if (typeof fn !== 'function') {
    throw new TypeError('setAuditSink: expected a function or null');
  }
  auditSink = fn;
}

/**
 * Replace the debug sink. Pass a function to capture events; pass null to
 * restore the default stderr (env-gated) JSON-line sink. Intended for tests.
 * @param {((event: object) => void) | null} fn
 */
export function setDebugSink(fn) {
  if (fn === null || fn === undefined) {
    debugSink = defaultDebugSink;
    return;
  }
  if (typeof fn !== 'function') {
    throw new TypeError('setDebugSink: expected a function or null');
  }
  debugSink = fn;
}

/**
 * Restore both sinks to their built-in defaults. Convenience for test teardown.
 */
export function resetSinks() {
  auditSink = defaultAuditSink;
  debugSink = defaultDebugSink;
}

/**
 * Validate that `fields` are present (non-empty strings) on `payload`.
 * Throws TypeError listing every missing/invalid field.
 * @param {string} channel — "audit" | "debug"
 * @param {object} payload
 * @param {string[]} fields
 */
function validateRequired(channel, payload, fields) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError(
      `log.${channel}: expected a plain object payload with required fields [${fields.join(', ')}]`,
    );
  }
  const missing = [];
  for (const field of fields) {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new TypeError(
      `log.${channel}: missing required field(s): ${missing.join(', ')}`,
    );
  }
}

/**
 * Build the canonical event record: { timestamp, channel, ...payload }.
 * The timestamp is always re-stamped server-side (callers cannot override).
 * `channel` is also reserved.
 * @param {string} channel
 * @param {object} payload
 * @returns {object} frozen event
 */
function buildEvent(channel, payload) {
  const event = { timestamp: new Date().toISOString(), channel };
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_FIELDS.has(key)) continue; // never let callers override
    event[key] = value;
  }
  return Object.freeze(event);
}

/**
 * Emit a security/audit event. Required: source, action, subject.
 * @param {{ source: string, action: string, subject: string, [key: string]: unknown }} payload
 * @returns {object} the emitted event (frozen) — useful for tests/inspection.
 */
function audit(payload) {
  validateRequired('audit', payload, AUDIT_REQUIRED_FIELDS);
  const event = buildEvent('audit', payload);
  auditSink(event);
  return event;
}

/**
 * Emit a debug/operational trace. Required: source, action.
 * Silent unless LLM_TRACKER_LOG_DEBUG=1 or DEBUG contains "llm-tracker"
 * (gating is enforced by the default sink — custom sinks via setDebugSink
 * always receive the event).
 * @param {{ source: string, action: string, [key: string]: unknown }} payload
 * @returns {object} the emitted event (frozen).
 */
function debug(payload) {
  validateRequired('debug', payload, DEBUG_REQUIRED_FIELDS);
  const event = buildEvent('debug', payload);
  debugSink(event);
  return event;
}

/**
 * The shared logger. Import as `import { log } from 'hub/logging/index.js'`.
 */
export const log = Object.freeze({ audit, debug });

// Named exports for callers that prefer destructured imports / testing.
export { audit, debug, isDebugEnabled };
