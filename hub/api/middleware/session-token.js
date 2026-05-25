// hub/api/middleware/session-token.js — SH-2-06 (TDD v0.5 §19.2)
//
// Express middleware that enforces the session-scoped token on every
// state-mutating endpoint (TDD §19.2.2 / §19.2.3). Read-only endpoints
// (list sessions, fetch context pack, view stdio) are explicitly out of
// scope per §19.2.4 and should not mount this middleware.
//
// Behavior:
//   - Reads header `X-LT-Session-Token` (Express normalizes to lowercase).
//   - Validates against the supplied `SessionTokenStore`.
//   - When the route includes a `:sessionId` param, the token's sessionId
//     must match. The middleware also accepts an explicit `getSessionId`
//     option for routes that derive the session from elsewhere (body, query).
//   - On rejection: appends a `session.token_audit` runtime event (when a
//     RuntimeStore is wired) and responds 401 with the standard error
//     envelope `{ error: { code, message, details? } }`.
//   - On acceptance: attaches `req.sessionToken = { sessionId, capabilities,
//     issuedAt, expiresAt }` and calls `next()`.

/**
 * @typedef {object} RequireSessionTokenDeps
 * @property {import("../../sessions/auth/tokens.js").SessionTokenStore} tokenStore
 * @property {object} [runtimeStore]                            optional; needed for audit events
 * @property {(prefix: string) => string} [makeRuntimeId]       required when runtimeStore is wired
 * @property {(event: object) => true} [validateRuntimeEvent]   required when runtimeStore is wired
 * @property {string} [workspace]                                required when runtimeStore is wired
 * @property {(req: any) => string | undefined} [getSessionId]   override for non-:sessionId routes
 * @property {string} [headerName="x-lt-session-token"]          for tests
 * @property {() => string} [now]                                ISO-8601 source for audit events
 */

const DEFAULT_HEADER_NAME = "x-lt-session-token";

/**
 * Build the middleware. Returns a single Express handler.
 *
 * @param {RequireSessionTokenDeps} deps
 */
export function requireSessionToken(deps) {
  const {
    tokenStore,
    runtimeStore,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace,
    getSessionId,
    headerName = DEFAULT_HEADER_NAME,
    now,
  } = deps || {};

  if (!tokenStore || typeof tokenStore.validate !== "function") {
    throw new Error("requireSessionToken: tokenStore (with validate) required");
  }

  // When runtimeStore is wired we also need the helpers to build a valid
  // audit event. Failing fast here keeps misconfigurations from leaking into
  // request handling, where the only visible symptom would be silent audit
  // omission.
  if (runtimeStore) {
    if (typeof runtimeStore.append !== "function") {
      throw new Error("requireSessionToken: runtimeStore.append must be a function");
    }
    if (typeof makeRuntimeId !== "function") {
      throw new Error("requireSessionToken: makeRuntimeId required when runtimeStore is wired");
    }
    if (typeof validateRuntimeEvent !== "function") {
      throw new Error("requireSessionToken: validateRuntimeEvent required when runtimeStore is wired");
    }
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("requireSessionToken: workspace required when runtimeStore is wired");
    }
  }

  const lowerHeaderName = String(headerName).toLowerCase();
  const tsNow = typeof now === "function" ? now : () => new Date().toISOString();

  return async function sessionTokenMiddleware(req, res, next) {
    const token =
      (typeof req.get === "function" && req.get(headerName)) ||
      (req.headers && req.headers[lowerHeaderName]);

    const expectedSessionId = pickSessionId(req, getSessionId);

    if (!token) {
      await emitAudit({ runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace, tsNow }, {
        sessionId: expectedSessionId,
        outcome: "rejected",
        reason: "missing",
        path: req.originalUrl || req.url,
        method: req.method,
      });
      return sendUnauthorized(res, "missing", "session token required (X-LT-Session-Token header)");
    }

    const result = tokenStore.validate(token, expectedSessionId ? { expectedSessionId } : undefined);
    if (!result.ok) {
      await emitAudit({ runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace, tsNow }, {
        sessionId: expectedSessionId,
        outcome: "rejected",
        reason: result.reason,
        path: req.originalUrl || req.url,
        method: req.method,
      });
      return sendUnauthorized(res, result.reason, reasonMessage(result.reason));
    }

    req.sessionToken = {
      sessionId: result.record.sessionId,
      capabilities: result.record.capabilities,
      issuedAt: result.record.issuedAt,
      expiresAt: result.record.expiresAt,
    };
    return next();
  };
}

function pickSessionId(req, getSessionId) {
  if (typeof getSessionId === "function") {
    const v = getSessionId(req);
    if (typeof v === "string" && v.length > 0) return v;
  }
  if (req.params && typeof req.params.sessionId === "string" && req.params.sessionId.length > 0) {
    return req.params.sessionId;
  }
  return undefined;
}

function reasonMessage(reason) {
  switch (reason) {
    case "missing": return "session token required";
    case "unknown": return "session token not recognized";
    case "expired": return "session token expired";
    case "session_mismatch": return "session token does not match session";
    case "revoked": return "session token has been revoked";
    default: return "session token rejected";
  }
}

function sendUnauthorized(res, reason, message) {
  res.status(401).json({ error: { code: "SESSION_TOKEN_REJECTED", message, details: { reason } } });
}

async function emitAudit(deps, payload) {
  const { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace, tsNow } = deps;
  if (!runtimeStore) return; // audit best-effort; tests run without runtimeStore
  const event = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: tsNow(),
    type: "session.token_audit",
    source: "http",
    workspace,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    outcome: payload.outcome,
    reason: payload.reason,
    ...(payload.method ? { method: payload.method } : {}),
    ...(payload.path ? { path: payload.path } : {}),
  };
  try {
    validateRuntimeEvent(event);
  } catch (_err) {
    // Audit payload doesn't shape-match — fall back to the minimum-required
    // GenericRuntimeEvent body to keep the rejection observable.
    const minimal = {
      schemaVersion: 1,
      id: makeRuntimeId("evt"),
      ts: tsNow(),
      type: "session.token_audit",
      source: "http",
      workspace,
    };
    const { id: _ignored, ...append } = minimal;
    try { await runtimeStore.append(append); } catch (_ignored2) { /* swallow */ }
    return;
  }
  const { id: _ignored, ...append } = event;
  try { await runtimeStore.append(append); } catch (_ignored2) { /* swallow */ }
}
