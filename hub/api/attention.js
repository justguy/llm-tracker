// hub/api/attention.js — SH-4-05 (TDD v0.5 §12.0, §8A.3, §23.2 #16)
//
// POST /api/attention/:id/ack | snooze | clear endpoints. Each handler emits
// a runtime event (`attention.ack`, `attention.snoozed`, `attention.cleared`)
// via `runtimeStore.append`. The endpoints DO NOT read or mutate the
// `AttentionEngine` projection — the projection layer consumes the events on
// the next tick. They also DO NOT mutate durable tracker truth.
//
// Per §23.2 #16:
//   - `ack`  : hides the item from the Attention strip; keeps it in Triage.
//   - `snooze`: hides until `until` unless severity escalates; requires `reason`.
//   - `clear`: explicit human override; the projection layer is responsible
//              for honoring it (this endpoint does not forcibly mutate engine
//              output — it just records the override).
//
// Error envelope mirrors hub/api/sessions.js: `{ error: { code, message, details? } }`.

import {
  createAttentionAckEvent,
  createAttentionSnoozedEvent,
  createAttentionClearedEvent,
} from "../runtime/events.js";

const ATTENTION_ITEM_ID_SHAPE = /^att_[0-9a-hjkmnp-tv-z]{26}$/;
const ACK_ALLOWED_FIELDS = new Set(["dedupeKey", "actor", "idempotencyKey"]);
const SNOOZE_ALLOWED_FIELDS = new Set(["dedupeKey", "until", "reason", "actor", "idempotencyKey"]);
const CLEAR_ALLOWED_FIELDS = new Set(["dedupeKey", "reason", "actor", "idempotencyKey"]);

/**
 * @typedef {object} RegisterAttentionDeps
 * @property {import("../runtime/store.js").RuntimeStore} runtimeStore
 * @property {{ getAll: () => object[] }} attentionEngine
 * @property {string} workspace
 */

/**
 * Mount POST /api/attention/:id/{ack,snooze,clear} routes onto an Express app.
 *
 * @param {import("express").Express} app
 * @param {RegisterAttentionDeps} deps
 */
export function registerAttentionRoutes(app, deps) {
  if (!app || typeof app.post !== "function") {
    throw new Error("registerAttentionRoutes: express app required");
  }
  const { runtimeStore, attentionEngine, workspace } = deps || {};
  if (!runtimeStore || typeof runtimeStore.append !== "function") {
    throw new Error("registerAttentionRoutes: runtimeStore (with append) required");
  }
  if (!attentionEngine || typeof attentionEngine.getAll !== "function") {
    throw new Error("registerAttentionRoutes: attentionEngine (with getAll) required");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("registerAttentionRoutes: workspace string required");
  }

  // --- GET /api/attention --------------------------------------------------
  app.get("/api/attention", (req, res) => {
    const scope = firstQueryValue(req.query.scope) || "global";
    if (scope !== "global" && scope !== "project") {
      return sendError(res, 400, "INVALID_QUERY", "`scope` must be 'global' or 'project'");
    }
    const limitRaw = firstQueryValue(req.query.limit);
    const limit = limitRaw === undefined ? null : Number.parseInt(limitRaw, 10);
    if (limitRaw !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return sendError(res, 400, "INVALID_QUERY", "`limit` must be an integer between 1 and 100");
    }
    const projectSlug = firstQueryValue(req.query.projectSlug);
    if (scope === "project" && (typeof projectSlug !== "string" || projectSlug.length === 0)) {
      return sendError(res, 400, "INVALID_QUERY", "`projectSlug` is required when scope='project'");
    }
    let items = attentionEngine.getAll();
    if (scope === "project" && typeof projectSlug === "string" && projectSlug.length > 0) {
      items = items.filter((item) => item && item.projectSlug === projectSlug);
    }
    if (limit !== null) items = items.slice(0, limit);
    res.json({ ok: true, scope, items });
  });

  // --- GET /api/attention/:id ---------------------------------------------
  app.get("/api/attention/:id", (req, res) => {
    const { id } = req.params;
    if (!isAttentionItemIdShape(id)) {
      return sendError(res, 400, "INVALID_ATTENTION_ID", `not a valid att_ id: ${id}`);
    }
    const item = attentionEngine.getAll().find((candidate) => candidate && candidate.id === id);
    if (!item) {
      return sendError(res, 404, "NOT_FOUND", `attention item not found: ${id}`);
    }
    res.json({ ok: true, item });
  });

  // --- POST /api/attention/:id/ack ----------------------------------------
  app.post("/api/attention/:id/ack", async (req, res) => {
    const { id } = req.params;
    if (!isAttentionItemIdShape(id)) {
      return sendError(res, 400, "INVALID_ATTENTION_ID", `not a valid att_ id: ${id}`);
    }
    const body = parseBodyObject(req.body);
    if (body === null) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const unknown = rejectUnknownFields(body, ACK_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }
    const { dedupeKey, actor, idempotencyKey } = body;
    if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`dedupeKey` is required (non-empty string)");
    }
    if (actor !== undefined && (typeof actor !== "string" || actor.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`actor` must be a non-empty string when present");
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`idempotencyKey` must be a non-empty string when present");
    }

    let event;
    try {
      event = createAttentionAckEvent({
        attentionItemId: id,
        dedupeKey,
        workspace,
        ...(actor !== undefined ? { actor } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
        errors: err.errors,
      });
    }

    let appendResult;
    try {
      appendResult = await runtimeStore.append(event);
    } catch (err) {
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    res.status(201).json({
      ok: true,
      event: { ...event, id: appendResult.eventId },
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  });

  // --- POST /api/attention/:id/snooze -------------------------------------
  app.post("/api/attention/:id/snooze", async (req, res) => {
    const { id } = req.params;
    if (!isAttentionItemIdShape(id)) {
      return sendError(res, 400, "INVALID_ATTENTION_ID", `not a valid att_ id: ${id}`);
    }
    const body = parseBodyObject(req.body);
    if (body === null) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const unknown = rejectUnknownFields(body, SNOOZE_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }
    const { dedupeKey, until, reason, actor, idempotencyKey } = body;
    if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`dedupeKey` is required (non-empty string)");
    }
    if (typeof until !== "string" || until.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`until` is required (ISO-8601 string)");
    }
    const untilMs = Date.parse(until);
    if (Number.isNaN(untilMs)) {
      return sendError(res, 400, "INVALID_BODY", "`until` must be a parseable ISO-8601 timestamp");
    }
    if (untilMs <= Date.now()) {
      return sendError(res, 400, "INVALID_BODY", "`until` must be a future timestamp");
    }
    if (typeof reason !== "string" || reason.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`reason` is required (non-empty string)");
    }
    if (actor !== undefined && (typeof actor !== "string" || actor.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`actor` must be a non-empty string when present");
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`idempotencyKey` must be a non-empty string when present");
    }

    let event;
    try {
      event = createAttentionSnoozedEvent({
        attentionItemId: id,
        dedupeKey,
        snoozedUntil: until,
        reason,
        workspace,
        ...(actor !== undefined ? { actor } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
        errors: err.errors,
      });
    }

    let appendResult;
    try {
      appendResult = await runtimeStore.append(event);
    } catch (err) {
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    res.status(201).json({
      ok: true,
      event: { ...event, id: appendResult.eventId },
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  });

  // --- POST /api/attention/:id/clear --------------------------------------
  app.post("/api/attention/:id/clear", async (req, res) => {
    const { id } = req.params;
    if (!isAttentionItemIdShape(id)) {
      return sendError(res, 400, "INVALID_ATTENTION_ID", `not a valid att_ id: ${id}`);
    }
    const body = parseBodyObject(req.body);
    if (body === null) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const unknown = rejectUnknownFields(body, CLEAR_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }
    const { dedupeKey, reason, actor, idempotencyKey } = body;
    if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`dedupeKey` is required (non-empty string)");
    }
    if (typeof reason !== "string" || reason.length === 0) {
      return sendError(res, 400, "INVALID_BODY", "`reason` is required (non-empty string)");
    }
    if (actor !== undefined && (typeof actor !== "string" || actor.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`actor` must be a non-empty string when present");
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`idempotencyKey` must be a non-empty string when present");
    }

    let event;
    try {
      event = createAttentionClearedEvent({
        attentionItemId: id,
        dedupeKey,
        reason,
        workspace,
        ...(actor !== undefined ? { actor } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
    } catch (err) {
      return sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
        errors: err.errors,
      });
    }

    let appendResult;
    try {
      appendResult = await runtimeStore.append(event);
    } catch (err) {
      return sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    }

    res.status(201).json({
      ok: true,
      event: { ...event, id: appendResult.eventId },
      rev: appendResult.rev,
      eventId: appendResult.eventId,
    });
  });
}

function isAttentionItemIdShape(value) {
  return typeof value === "string" && ATTENTION_ITEM_ID_SHAPE.test(value);
}

function parseBodyObject(raw) {
  if (raw === undefined) return {};
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

function rejectUnknownFields(body, allowed) {
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) unknown.push(key);
  }
  return unknown;
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
