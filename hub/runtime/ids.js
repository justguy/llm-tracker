// hub/runtime/ids.js — Session Hub Phase 1 (TDD v0.5 §6.10, §23.2 #9)
//
// Canonical runtime IDs are lower-case ULIDs with a 3-letter type prefix:
//   `${prefix}_${ulid().toLowerCase()}`
//
// ULID layout: 26 characters of Crockford Base32 — first 10 chars encode a
// 48-bit millisecond timestamp; remaining 16 chars encode 80 random bits.
// We deliberately roll our own implementation (using node:crypto.randomBytes)
// rather than adding a dependency: the encoder is small, deterministic, and
// well-covered by tests.
//
// Crockford Base32 lower-case alphabet excludes the visually-ambiguous
// characters `i`, `l`, `o`, and `u`:
//   `0123456789abcdefghjkmnpqrstvwxyz`
//
// IDs are URL/JSON/filename/MCP-arg safe: only `[a-z0-9_]` appears in the
// output (3-char prefix + underscore + 26-char Crockford body).

import { randomBytes } from "node:crypto";

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford Base32, lower-case
const ID_BODY_LEN = 26;
const TIME_LEN = 10;
const RAND_LEN = 16;
const ID_REGEX_BODY = "[0-9a-hjkmnp-tv-z]{26}";
const ALL_PREFIXES = ["ses", "job", "evt", "skr", "ctx", "att"];

export const SESSION_ID_RE = new RegExp(`^ses_${ID_REGEX_BODY}$`);
export const JOB_ID_RE = new RegExp(`^job_${ID_REGEX_BODY}$`);
export const RUNTIME_EVENT_ID_RE = new RegExp(`^evt_${ID_REGEX_BODY}$`);
export const SKILL_RUN_ID_RE = new RegExp(`^skr_${ID_REGEX_BODY}$`);
export const CONTEXT_PACK_ID_RE = new RegExp(`^ctx_${ID_REGEX_BODY}$`);
export const ATTENTION_ITEM_ID_RE = new RegExp(`^att_${ID_REGEX_BODY}$`);

export const RUNTIME_ID_PREFIXES = Object.freeze([...ALL_PREFIXES]);
export const RUNTIME_ID_ALPHABET = ID_ALPHABET;

/**
 * Branded string types for the six runtime ID flavors. JSDoc typedefs only —
 * this repo is pure JS, so they exist for editor tooling and documentation.
 *
 * @typedef {string} SessionId
 * @typedef {string} JobId
 * @typedef {string} RuntimeEventId
 * @typedef {string} SkillRunId
 * @typedef {string} ContextPackId
 * @typedef {string} AttentionItemId
 */

const REGEX_BY_PREFIX = {
  ses: SESSION_ID_RE,
  job: JOB_ID_RE,
  evt: RUNTIME_EVENT_ID_RE,
  skr: SKILL_RUN_ID_RE,
  ctx: CONTEXT_PACK_ID_RE,
  att: ATTENTION_ITEM_ID_RE,
};

/**
 * Generate a canonical runtime ID of the form `${prefix}_${ulid()}`.
 * @param {"ses"|"job"|"evt"|"skr"|"ctx"|"att"} prefix
 * @returns {string}
 */
export function makeRuntimeId(prefix) {
  if (!ALL_PREFIXES.includes(prefix)) {
    throw new TypeError(
      `makeRuntimeId: invalid prefix ${JSON.stringify(prefix)} — must be one of ${ALL_PREFIXES.join(", ")}`,
    );
  }
  return `${prefix}_${makeUlid()}`;
}

/** @param {unknown} value @returns {value is SessionId} */
export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is JobId} */
export function isJobId(value) {
  return typeof value === "string" && JOB_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is RuntimeEventId} */
export function isRuntimeEventId(value) {
  return typeof value === "string" && RUNTIME_EVENT_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is SkillRunId} */
export function isSkillRunId(value) {
  return typeof value === "string" && SKILL_RUN_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is ContextPackId} */
export function isContextPackId(value) {
  return typeof value === "string" && CONTEXT_PACK_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is AttentionItemId} */
export function isAttentionItemId(value) {
  return typeof value === "string" && ATTENTION_ITEM_ID_RE.test(value);
}

/**
 * Validate any runtime ID regardless of prefix. Useful at trust boundaries
 * (API/MCP) where the caller may have any runtime ID.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRuntimeId(value) {
  if (typeof value !== "string") return false;
  const underscore = value.indexOf("_");
  if (underscore !== 3) return false;
  const prefix = value.slice(0, 3);
  const re = REGEX_BY_PREFIX[prefix];
  return !!re && re.test(value);
}

/**
 * Generate a 26-char lower-case Crockford Base32 ULID.
 * Exported for tests; production code should call `makeRuntimeId(prefix)`.
 * @param {number} [now]
 * @returns {string}
 */
export function makeUlid(now = Date.now()) {
  return encodeTime(now, TIME_LEN) + encodeRandom(RAND_LEN);
}

/**
 * Encode a millisecond timestamp as `len` Crockford Base32 chars (10 chars
 * gives the full 48-bit ULID timestamp range).
 * @param {number} now
 * @param {number} len
 * @returns {string}
 */
function encodeTime(now, len) {
  if (!Number.isFinite(now) || now < 0 || !Number.isInteger(now)) {
    throw new TypeError(`encodeTime: expected non-negative integer ms, got ${now}`);
  }
  // 48-bit max is 2^48 - 1; the standard ULID spec rejects times beyond that.
  if (now > 0xffffffffffff) {
    throw new RangeError(`encodeTime: timestamp ${now} exceeds 48-bit ULID limit`);
  }
  let value = now;
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    // eslint-disable-next-line no-bitwise -- ULID encoding works in base-32 chunks
    const mod = value % 32;
    out = ID_ALPHABET[mod] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/**
 * Encode `len` Crockford Base32 chars sourced from secure random bytes.
 * 16 chars = 80 bits of entropy, exactly the ULID random component.
 * @param {number} len
 * @returns {string}
 */
function encodeRandom(len) {
  // 16 base-32 chars need 80 bits = 10 bytes. We mask 5 bits per char.
  const bitsNeeded = len * 5;
  const bytesNeeded = Math.ceil(bitsNeeded / 8);
  const bytes = randomBytes(bytesNeeded);
  let out = "";
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let byteIndex = 0;
  for (let i = 0; i < len; i++) {
    while (bitsInBuffer < 5 && byteIndex < bytes.length) {
      bitBuffer = (bitBuffer << 8) | bytes[byteIndex++];
      bitsInBuffer += 8;
    }
    const shift = bitsInBuffer - 5;
    const idx = (bitBuffer >>> shift) & 0x1f;
    out += ID_ALPHABET[idx];
    bitBuffer &= (1 << shift) - 1;
    bitsInBuffer -= 5;
  }
  return out;
}
