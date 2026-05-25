// hub/api/providers.js — SH-2-20 (addendum §16.1)
//
// HTTP routes that expose the ProviderBroker to browser/CLI/MCP clients:
//
//   GET  /api/providers                          → {providers: [{id, label}, ...]}
//   GET  /api/providers/:providerId/capabilities → {providerId, capabilities}
//   GET  /api/providers/:providerId/models       → {providerId, models}
//   GET  /api/providers/:providerId/skills?cwd=  → {providerId, skills}
//   POST /api/providers/:providerId/probe        → {providerId, ok, reason?, details?}
//
// This module only registers routes on an Express app — wiring into
// `hub/server.js` (passing the live ProviderBroker as a dep at startup)
// is left to a follow-up task that adds the broker to the startup deps.
//
// Error envelope (mirrors hub/api/sessions.js / hub/api/layouts.js):
//   { error: { code, message, details? } }
//
// Broker error code → HTTP mapping:
//   PROVIDER_NOT_FOUND               → 404
//   PROVIDER_OPERATION_NOT_SUPPORTED → 501
//   PROVIDER_INVALID_ARGUMENT        → 400
//   anything else                    → 500 INTERNAL_ERROR
//
// Probe failures (the provider returns {ok: false}) are NOT HTTP errors —
// they're a successful 200 response carrying ok:false + reason so the UI
// can render "this provider is unavailable" without needing to inspect a
// 5xx envelope.

import { BROKER_ERROR_CODES } from "../providers/broker.js";

// Provider ids are constrained at the route level so malformed input never
// reaches the broker (the broker would also reject it as INVALID_ARGUMENT,
// but enforcing here keeps the error specific to the route's contract).
const PROVIDER_ID_SHAPE = /^[a-z][a-z0-9_-]*$/;

/**
 * @typedef {object} RegisterDeps
 * @property {import("../providers/broker.js").ProviderBroker} broker
 */

/**
 * Register the five /api/providers routes onto an Express app.
 *
 * @param {import("express").Express} app
 * @param {RegisterDeps} deps
 */
export function registerProvidersRoutes(app, deps) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new Error("registerProvidersRoutes: express app required");
  }
  const { broker } = deps || {};
  if (
    !broker ||
    typeof broker.capabilities !== "function" ||
    typeof broker.probe !== "function" ||
    typeof broker.listModels !== "function" ||
    typeof broker.listSkills !== "function" ||
    !broker.registry ||
    typeof broker.registry.list !== "function"
  ) {
    throw new Error("registerProvidersRoutes: broker (ProviderBroker) required");
  }

  // --- GET /api/providers --------------------------------------------------
  app.get("/api/providers", (_req, res) => {
    const providers = broker.registry.list().map((p) => ({ id: p.id, label: p.label }));
    res.status(200).json({ providers });
  });

  // --- GET /api/providers/:providerId/capabilities -------------------------
  app.get("/api/providers/:providerId/capabilities", (req, res) => {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return sendInvalidProviderId(res, providerId);
    }
    try {
      const capabilities = broker.capabilities(providerId);
      res.status(200).json({ providerId, capabilities });
    } catch (err) {
      sendBrokerError(res, err);
    }
  });

  // --- GET /api/providers/:providerId/models -------------------------------
  app.get("/api/providers/:providerId/models", async (req, res) => {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return sendInvalidProviderId(res, providerId);
    }
    try {
      const models = await broker.listModels(providerId);
      res.status(200).json({ providerId, models });
    } catch (err) {
      sendBrokerError(res, err);
    }
  });

  // --- GET /api/providers/:providerId/skills?cwd= --------------------------
  app.get("/api/providers/:providerId/skills", async (req, res) => {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return sendInvalidProviderId(res, providerId);
    }
    const request = {};
    if ("cwd" in req.query) {
      const { cwd } = req.query;
      if (typeof cwd !== "string" || cwd.length === 0) {
        return sendError(res, 400, "INVALID_QUERY", "`cwd` must be a non-empty string when present");
      }
      request.cwd = cwd;
    }
    try {
      const skills = await broker.listSkills(providerId, request);
      res.status(200).json({ providerId, skills });
    } catch (err) {
      sendBrokerError(res, err);
    }
  });

  // --- POST /api/providers/:providerId/probe -------------------------------
  app.post("/api/providers/:providerId/probe", async (req, res) => {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return sendInvalidProviderId(res, providerId);
    }
    try {
      const result = await broker.probe(providerId);
      const body = { providerId, ok: !!(result && result.ok === true) };
      if (result && result.reason !== undefined) body.reason = result.reason;
      if (result && result.details !== undefined) body.details = result.details;
      res.status(200).json(body);
    } catch (err) {
      sendBrokerError(res, err);
    }
  });
}

function isValidProviderId(value) {
  return typeof value === "string" && value.length > 0 && PROVIDER_ID_SHAPE.test(value);
}

function sendInvalidProviderId(res, providerId) {
  return sendError(
    res,
    400,
    "INVALID_PROVIDER_ID",
    `providerId must match /^[a-z][a-z0-9_-]*$/, got: ${JSON.stringify(providerId)}`,
  );
}

function sendBrokerError(res, err) {
  const code = err && err.code;
  const message = (err && err.message) || "broker error";
  const details = err && err.details;
  if (code === BROKER_ERROR_CODES.NOT_FOUND) {
    return sendError(res, 404, code, message, details);
  }
  if (code === BROKER_ERROR_CODES.NOT_SUPPORTED) {
    return sendError(res, 501, code, message, details);
  }
  if (code === BROKER_ERROR_CODES.INVALID_ARGUMENT) {
    return sendError(res, 400, code, message, details);
  }
  return sendError(res, 500, "INTERNAL_ERROR", message);
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
