// hub/api/provider-actions.js — SH-9-15
//
// Provider action endpoints for Codex App Server backed sessions. This module
// only registers routes; server wiring is intentionally left to the startup
// task that owns hub/server.js.

import { requireSessionToken } from "./middleware/session-token.js";

export const PROVIDER_ACTION_KINDS = Object.freeze([
  "approve",
  "deny",
  "interrupt",
  "steer",
  "fork",
  "review",
]);

const SESSION_ID_SHAPE = /^ses_[a-zA-Z0-9_=-]+$/;
const ACTION_CAPABILITY = Object.freeze({
  approve: "structuredApprovals",
  deny: "structuredApprovals",
  interrupt: "turnInterrupt",
  steer: "turnSteer",
  fork: "threadFork",
  review: "providerReview",
});

const DECISION_BY_ACTION = Object.freeze({
  approve: "approved",
  deny: "denied",
});

const ACTION_ALLOWED_FIELDS = Object.freeze({
  approve: new Set(["approvalId", "threadId", "scope", "sandboxScope", "reason", "idempotencyKey"]),
  deny: new Set(["approvalId", "threadId", "reason", "idempotencyKey"]),
  interrupt: new Set(["threadId", "reason", "idempotencyKey"]),
  steer: new Set(["threadId", "message", "prompt", "idempotencyKey"]),
  fork: new Set(["threadId", "reason", "idempotencyKey"]),
  review: new Set(["threadId", "prompt", "scope", "idempotencyKey"]),
});

export function registerProviderActionRoutes(app, deps = {}) {
  if (!app || typeof app.post !== "function") {
    throw new Error("registerProviderActionRoutes: express app required");
  }
  const handler = createProviderActionHandler(deps);
  const middleware = createTokenMiddleware(deps);
  for (const action of PROVIDER_ACTION_KINDS) {
    app.post(`/api/sessions/:sessionId/provider/${action}`, middleware, handler(action));
  }
}

export function createProviderActionHandler(deps = {}) {
  const {
    projection,
    broker,
    providerActions,
  } = deps;
  if (!projection || typeof projection.toSnapshots !== "function") {
    throw new Error("createProviderActionHandler: projection required");
  }
  if (!providerActions || typeof providerActions !== "object") {
    throw new Error("createProviderActionHandler: providerActions required");
  }

  return (action) => async (req, res) => {
    if (!PROVIDER_ACTION_KINDS.includes(action)) {
      return sendError(res, 404, "UNKNOWN_PROVIDER_ACTION", `Unknown provider action '${action}'`);
    }
    const { sessionId } = req.params || {};
    if (!isSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "sessionId must be a ses_ id");
    }
    if (req.sessionToken && req.sessionToken.sessionId !== sessionId) {
      return sendError(res, 403, "SESSION_TOKEN_MISMATCH", "session token does not match sessionId");
    }
    const body = isRecord(req.body) ? req.body : {};
    const unknown = unknownFields(body, ACTION_ALLOWED_FIELDS[action]);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", "request body contains unknown fields", { unknown });
    }
    const session = findSession(projection, sessionId);
    if (!session) {
      return sendError(res, 404, "SESSION_NOT_FOUND", `session '${sessionId}' not found`);
    }
    const capabilities = providerCapabilities(session, broker);
    const capability = ACTION_CAPABILITY[action];
    if (capabilities[capability] !== true) {
      return sendError(res, 409, "PROVIDER_CAPABILITY_MISSING", `provider capability '${capability}' is required`, {
        action,
        capability,
        disabledReason: `Provider does not support ${capability}`,
      });
    }
    try {
      const result = await dispatchProviderAction(providerActions, action, {
        session,
        sessionId,
        body,
        capabilities,
      });
      return res.status(200).json({
        ok: true,
        sessionId,
        action,
        result: result === undefined ? null : result,
      });
    } catch (err) {
      return sendProviderActionError(res, err);
    }
  };
}

function createTokenMiddleware(deps) {
  const {
    tokenStore,
    runtimeStore,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace,
  } = deps;
  if (!tokenStore) {
    return (_req, _res, next) => next();
  }
  return requireSessionToken({
    tokenStore,
    runtimeStore,
    makeRuntimeId,
    validateRuntimeEvent,
    workspace,
  });
}

function dispatchProviderAction(providerActions, action, input) {
  if (action === "approve" || action === "deny") {
    return callProviderAction(providerActions, action, {
      ...input,
      approvalId: requiredString(input.body.approvalId, "approvalId"),
      decision: DECISION_BY_ACTION[action],
    });
  }
  return callProviderAction(providerActions, action, input);
}

function callProviderAction(providerActions, action, input) {
  const fn = providerActions[action];
  if (typeof fn !== "function") {
    const err = new Error(`provider action '${action}' is not implemented`);
    err.code = "PROVIDER_ACTION_NOT_IMPLEMENTED";
    err.details = { action };
    throw err;
  }
  return fn(input);
}

function providerCapabilities(session, broker) {
  if (isRecord(session.providerCapabilities)) return session.providerCapabilities;
  const providerId = session.providerId || session.provider || session.tier;
  if (providerId && broker && typeof broker.capabilities === "function") {
    try {
      const capabilities = broker.capabilities(providerId);
      return isRecord(capabilities) ? capabilities : {};
    } catch {
      return {};
    }
  }
  return {};
}

function findSession(projection, sessionId) {
  const snapshots = projection.toSnapshots();
  const sessions = Array.isArray(snapshots?.sessions) ? snapshots.sessions : [];
  return sessions.find((session) => session && session.id === sessionId) || null;
}

function unknownFields(body, allowed) {
  return Object.keys(body).filter((key) => !allowed.has(key));
}

function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_SHAPE.test(value);
}

function requiredString(value, field) {
  if (typeof value === "string" && value.length > 0) return value;
  const err = new Error(`${field} required`);
  err.code = "INVALID_PROVIDER_ACTION";
  err.details = { field };
  throw err;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sendProviderActionError(res, err) {
  const code = err?.code || "PROVIDER_ACTION_FAILED";
  if (code === "INVALID_PROVIDER_ACTION") {
    return sendError(res, 400, code, err.message, err.details);
  }
  if (code === "PROVIDER_ACTION_NOT_IMPLEMENTED") {
    return sendError(res, 501, code, err.message, err.details);
  }
  return sendError(res, 500, code, err?.message || "provider action failed", err?.details);
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}
