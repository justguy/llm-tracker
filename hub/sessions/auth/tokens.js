// hub/sessions/auth/tokens.js — SH-2-06 (TDD v0.5 §19.2, §23.2 #14)
//
// SessionTokenStore — in-memory issuance + validation of session-scoped
// ephemeral tokens. The hub only ever stores the **hash** of a token;
// cleartext is returned exactly once from `issue()` and never persisted.
//
// Token contract (TDD §19.2.1 / §23.2 closure 14):
//   - Bound to (sessionId, capabilities, expiresAt).
//   - Default lifetime: `maxLifetimeMinutes: 1440` (24h).
//   - Cleartext shown exactly once (at issuance). Hub stores only sha256(token).
//   - Validation rejects on: missing, unknown, expired, session-mismatch, revoked.
//   - `revoke(sessionId)` invalidates every outstanding token for the session
//     (used on archive and on token rotation per SH-2-07).
//
// Transport layer (TDD §19.2.2) — header `X-LT-Session-Token` for HTTP and
// MCP arg `sessionToken` — is enforced by the middleware in
// `hub/api/middleware/session-token.js`. This module is transport-agnostic.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Default token lifetime in minutes (TDD §23.2 closure 14). */
export const DEFAULT_MAX_LIFETIME_MINUTES = 1440;

/** Cleartext token byte length pre-encoding. 32 bytes → 43-char base64url. */
const TOKEN_BYTES = 32;

const REJECT_REASONS = Object.freeze({
  MISSING: "missing",
  UNKNOWN: "unknown",
  EXPIRED: "expired",
  SESSION_MISMATCH: "session_mismatch",
  REVOKED: "revoked",
});

export { REJECT_REASONS as TOKEN_REJECT_REASONS };

/**
 * @typedef {object} SessionTokenRecord
 * @property {string} sessionId
 * @property {readonly string[]} capabilities
 * @property {string} issuedAt   ISO-8601
 * @property {string} expiresAt  ISO-8601
 */

/**
 * @typedef {object} IssueResult
 * @property {string} token         cleartext token (caller must propagate
 *                                  out-of-band; the store never returns it again)
 * @property {string} tokenHash     hex sha-256 of the cleartext (for tests/debug)
 * @property {string} sessionId
 * @property {readonly string[]} capabilities
 * @property {string} issuedAt
 * @property {string} expiresAt
 */

/**
 * @typedef {{ ok: true; record: SessionTokenRecord }} ValidateOk
 * @typedef {{ ok: false; reason: typeof REJECT_REASONS[keyof typeof REJECT_REASONS] }} ValidateFail
 * @typedef {ValidateOk | ValidateFail} ValidateResult
 */

/**
 * Encode `Buffer` → base64url (RFC 4648 §5, no padding). Used for the
 * cleartext token. We avoid `Buffer.from(...).toString("base64url")` only
 * because it preserves padding on Node < 16; using `replace` keeps us safe
 * across the supported Node versions.
 *
 * @param {Buffer} buf
 */
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Hex sha-256 of a cleartext token. Only the hash is stored.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/**
 * Constant-time string equality. Avoids exposing per-char timing on the rare
 * path where a caller compares two cleartext tokens directly; the store
 * itself looks up by hash so timing is map-bounded.
 *
 * @param {string} a
 * @param {string} b
 */
export function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * In-memory store for session-scoped tokens.
 *
 * The store keeps two indices:
 *   - `byHash: Map<tokenHash, record>`     — primary lookup on validate().
 *   - `bySession: Map<sessionId, Set<tokenHash>>` — fan-out for revoke().
 *
 * It does not persist; hub restarts invalidate every outstanding token.
 * That is acceptable per §19.2.4 (read-only endpoints don't need a token;
 * mutating endpoints re-issue on next session creation/attach).
 */
export class SessionTokenStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.defaultLifetimeMinutes=DEFAULT_MAX_LIFETIME_MINUTES]
   * @param {() => Date} [opts.now]   tests inject a clock; production uses `new Date()`
   * @param {(bytes: number) => Buffer} [opts.randomBytes]  tests inject deterministic bytes
   */
  constructor(opts = {}) {
    const {
      defaultLifetimeMinutes = DEFAULT_MAX_LIFETIME_MINUTES,
      now,
      randomBytes: rb,
    } = opts;
    if (!Number.isInteger(defaultLifetimeMinutes) || defaultLifetimeMinutes <= 0) {
      throw new TypeError(
        "SessionTokenStore: defaultLifetimeMinutes must be a positive integer",
      );
    }
    this.defaultLifetimeMinutes = defaultLifetimeMinutes;
    this.now = typeof now === "function" ? now : () => new Date();
    this.randomBytes = typeof rb === "function" ? rb : randomBytes;
    /** @type {Map<string, SessionTokenRecord>} */
    this.byHash = new Map();
    /** @type {Map<string, Set<string>>} sessionId -> Set<tokenHash> */
    this.bySession = new Map();
  }

  /**
   * Issue a new token for `sessionId` with the given capability set.
   * Returns cleartext + metadata; cleartext is never stored.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {readonly string[]} [params.capabilities]
   * @param {number} [params.lifetimeMinutes]   overrides defaultLifetimeMinutes
   * @returns {IssueResult}
   */
  issue({ sessionId, capabilities = [], lifetimeMinutes } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("SessionTokenStore.issue: sessionId required");
    }
    if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== "string" || c.length === 0)) {
      throw new TypeError("SessionTokenStore.issue: capabilities must be string[]");
    }
    const ttl = lifetimeMinutes ?? this.defaultLifetimeMinutes;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new TypeError("SessionTokenStore.issue: lifetimeMinutes must be a positive integer");
    }

    const token = base64url(this.randomBytes(TOKEN_BYTES));
    const tokenHash = hashToken(token);
    const issued = this.now();
    const expires = new Date(issued.getTime() + ttl * 60_000);
    const record = Object.freeze({
      sessionId,
      capabilities: Object.freeze([...capabilities]),
      issuedAt: issued.toISOString(),
      expiresAt: expires.toISOString(),
    });

    this.byHash.set(tokenHash, record);
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(tokenHash);

    return {
      token,
      tokenHash,
      sessionId,
      capabilities: record.capabilities,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Validate a cleartext token. If `expectedSessionId` is provided, the
   * token's sessionId must match — used by the middleware to enforce that
   * a token issued for session A cannot mutate session B.
   *
   * @param {string} token                   cleartext as received over the wire
   * @param {object} [opts]
   * @param {string} [opts.expectedSessionId]
   * @returns {ValidateResult}
   */
  validate(token, opts = {}) {
    if (typeof token !== "string" || token.length === 0) {
      return { ok: false, reason: REJECT_REASONS.MISSING };
    }
    const tokenHash = hashToken(token);
    const record = this.byHash.get(tokenHash);
    if (!record) return { ok: false, reason: REJECT_REASONS.UNKNOWN };

    const expiresMs = Date.parse(record.expiresAt);
    if (this.now().getTime() >= expiresMs) {
      // Expired — best-effort purge so the map doesn't grow without bound.
      this._delete(tokenHash, record.sessionId);
      return { ok: false, reason: REJECT_REASONS.EXPIRED };
    }

    if (
      typeof opts.expectedSessionId === "string" &&
      opts.expectedSessionId !== record.sessionId
    ) {
      return { ok: false, reason: REJECT_REASONS.SESSION_MISMATCH };
    }

    return { ok: true, record };
  }

  /**
   * Revoke every token belonging to `sessionId`. Used by `archive` and by
   * the rotation endpoint (SH-2-07): rotate revokes prior tokens then issues
   * a fresh one in one transaction.
   *
   * @param {string} sessionId
   * @param {{ exceptTokenHash?: string }} [opts]
   * @returns {number}  count of tokens revoked
   */
  revoke(sessionId, opts = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return 0;
    const set = this.bySession.get(sessionId);
    if (!set) return 0;
    const exceptTokenHash =
      opts && typeof opts.exceptTokenHash === "string" && opts.exceptTokenHash.length > 0
        ? opts.exceptTokenHash
        : null;
    let n = 0;
    for (const h of [...set]) {
      if (exceptTokenHash && h === exceptTokenHash) continue;
      if (this.byHash.delete(h)) n += 1;
      set.delete(h);
    }
    if (set.size === 0) this.bySession.delete(sessionId);
    return n;
  }

  /**
   * Revoke one token by hash. Used as rollback when a caller issued a fresh
   * cleartext token but failed to durably append the matching runtime event.
   *
   * @param {string} tokenHash
   * @returns {boolean}
   */
  revokeTokenHash(tokenHash) {
    if (typeof tokenHash !== "string" || tokenHash.length === 0) return false;
    const record = this.byHash.get(tokenHash);
    if (!record) return false;
    this._delete(tokenHash, record.sessionId);
    return true;
  }

  /**
   * Drop expired entries. Optional housekeeping — `validate` already
   * deletes on read, so this is for callers that want a sweep (e.g., a
   * periodic task or test setup).
   *
   * @returns {number} count of tokens purged
   */
  purgeExpired() {
    const now = this.now().getTime();
    let n = 0;
    for (const [hash, record] of this.byHash) {
      if (Date.parse(record.expiresAt) <= now) {
        this._delete(hash, record.sessionId);
        n += 1;
      }
    }
    return n;
  }

  /**
   * Snapshot for debugging / tests. Returns array of metadata only — never
   * the cleartext token (which is unrecoverable by construction).
   *
   * @returns {Array<{ tokenHash: string } & SessionTokenRecord>}
   */
  list() {
    const out = [];
    for (const [tokenHash, record] of this.byHash) {
      out.push({ tokenHash, ...record });
    }
    return out;
  }

  /** @private */
  _delete(hash, sessionId) {
    this.byHash.delete(hash);
    const set = this.bySession.get(sessionId);
    if (set) {
      set.delete(hash);
      if (set.size === 0) this.bySession.delete(sessionId);
    }
  }
}
