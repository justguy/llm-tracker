// hub/api/timeline.js - SH-4A-03
//
// HTTP + runtime-WS surface for the session timeline projection.

import {
  buildSessionTimeline,
  timelineItemFromRuntimeEvent,
} from "../timeline/session-timeline-service.js";
import { TIMELINE_KINDS } from "../timeline/timeline-model.js";

const SESSION_ID_SHAPE = /^ses_[0-9a-hjkmnp-tv-z]{26}$/;
const DEFAULT_TIMELINE_BATCH_MS = 50;

/**
 * @typedef {object} RegisterTimelineDeps
 * @property {{ sessions?: Map<string, object>, toSnapshots?: () => object, rev?: number }} projection
 * @property {() => Promise<object[]> | object[]} getRuntimeEvents
 * @property {() => Promise<object[]> | object[]} [getProviderTimelineItems]
 * @property {() => Promise<object[]> | object[]} [getProviderEvents]
 */

/**
 * Register GET /api/sessions/:sessionId/timeline.
 *
 * @param {import("express").Express} app
 * @param {RegisterTimelineDeps} deps
 */
export function registerTimelineRoutes(app, deps) {
  if (!app || typeof app.get !== "function") {
    throw new Error("registerTimelineRoutes: express app required");
  }
  const {
    projection,
    getRuntimeEvents,
    getProviderTimelineItems,
    getProviderEvents,
  } = deps || {};
  if (!projection || typeof projection.toSnapshots !== "function") {
    throw new Error("registerTimelineRoutes: projection (with toSnapshots) required");
  }
  if (typeof getRuntimeEvents !== "function") {
    throw new Error("registerTimelineRoutes: getRuntimeEvents function required");
  }

  app.get("/api/sessions/:sessionId/timeline", async (req, res) => {
    const { sessionId } = req.params;
    if (!isSessionIdShape(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", `not a valid ses_ id: ${sessionId}`);
    }
    if (!sessionExists(projection, sessionId)) {
      return sendError(res, 404, "UNKNOWN_SESSION", `session not found: ${sessionId}`);
    }

    const query = parseTimelineQuery(req.query || {});
    if (query.error) {
      return sendError(res, 400, "INVALID_QUERY", query.error);
    }

    let runtimeEvents;
    let providerTimelineItems;
    let providerEvents;
    try {
      runtimeEvents = await getRuntimeEvents();
      providerTimelineItems = getProviderTimelineItems
        ? await getProviderTimelineItems()
        : [];
      providerEvents = getProviderEvents ? await getProviderEvents() : [];
    } catch (err) {
      return sendError(
        res,
        500,
        "TIMELINE_SOURCE_FAILED",
        err?.message || "timeline source failed",
      );
    }

    let items;
    try {
      items = buildSessionTimeline({
        sessionId,
        runtimeEvents: Array.isArray(runtimeEvents) ? runtimeEvents : [],
        providerTimelineItems: Array.isArray(providerTimelineItems)
          ? providerTimelineItems
          : [],
        providerEvents: Array.isArray(providerEvents) ? providerEvents : [],
        ...query.value,
      });
    } catch (err) {
      return sendError(
        res,
        400,
        "TIMELINE_PROJECTION_FAILED",
        err?.message || "timeline projection failed",
      );
    }

    res.status(200).json({
      sessionId,
      items,
      itemCount: items.length,
      rev: Number.isInteger(projection.rev) ? projection.rev : null,
      filters: {
        since: query.value.since || null,
        kinds: query.value.kinds || null,
        limit: query.value.limit ?? null,
      },
    });
  });
}

/**
 * Build a small server-side batcher for timeline.appended WS messages.
 *
 * @param {object} options
 * @param {(payload: {sessionId: string, items: object[]}) => void} options.broadcastTimeline
 * @param {number} [options.batchMs=50]
 * @returns {{ handleAppend(event: object): void, flush(): void, close(): void, pendingCount(): number }}
 */
export function createTimelineAppendBatcher({
  broadcastTimeline,
  batchMs = DEFAULT_TIMELINE_BATCH_MS,
} = {}) {
  if (typeof broadcastTimeline !== "function") {
    throw new TypeError("createTimelineAppendBatcher: broadcastTimeline function required");
  }
  if (!Number.isFinite(batchMs) || batchMs < 0) {
    throw new TypeError("createTimelineAppendBatcher: batchMs must be a non-negative number");
  }

  const pending = new Map();
  let timer = null;

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, batchMs);
    timer.unref?.();
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batches = [...pending.entries()];
    pending.clear();
    for (const [sessionId, items] of batches) {
      if (items.length > 0) broadcastTimeline({ sessionId, items });
    }
  };

  return {
    handleAppend(event) {
      const sessionIds = sessionIdsForRuntimeEvent(event);
      if (sessionIds.length === 0) return;
      let queued = false;
      for (const sessionId of sessionIds) {
        let item;
        try {
          item = timelineItemFromRuntimeEvent(event, { sessionId });
        } catch {
          continue;
        }
        if (!item) continue;
        const items = pending.get(sessionId) || [];
        items.push(item);
        pending.set(sessionId, items);
        queued = true;
      }
      if (queued) schedule();
    },
    flush,
    close() {
      flush();
    },
    pendingCount() {
      let count = 0;
      for (const items of pending.values()) count += items.length;
      return count;
    },
  };
}

function parseTimelineQuery(query) {
  const out = {};
  const since = firstQueryValue(query.since);
  if (since !== undefined) {
    if (typeof since !== "string" || since.length === 0 || Number.isNaN(Date.parse(since))) {
      return { error: "`since` must be an ISO-8601 timestamp" };
    }
    out.since = since;
  }

  const rawKinds = queryValues(query.kinds)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawKinds.length > 0) {
    const unknown = rawKinds.filter((kind) => !TIMELINE_KINDS.includes(kind));
    if (unknown.length > 0) {
      return { error: `unknown timeline kind(s): ${unknown.join(", ")}` };
    }
    out.kinds = [...new Set(rawKinds)];
  }

  const limitRaw = firstQueryValue(query.limit);
  if (limitRaw !== undefined) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) {
      return { error: "`limit` must be a non-negative integer" };
    }
    out.limit = limit;
  }

  return { value: out };
}

function firstQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function queryValues(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function sessionExists(projection, sessionId) {
  if (projection.sessions && typeof projection.sessions.get === "function") {
    return !!projection.sessions.get(sessionId);
  }
  const snap = projection.toSnapshots();
  return Array.isArray(snap.sessions) && snap.sessions.some((s) => s?.id === sessionId);
}

function sessionIdsForRuntimeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  const ids = new Set();
  if (event.type === "repo.change" || event.type === "repo.burst") {
    addStrings(ids, event.activeSessionIds);
    addStrings(ids, event.possibleSessionIds);
    return [...ids];
  }
  addString(ids, event.sessionId);
  addString(ids, event.targetSessionId);
  addString(ids, event.to);
  if (event.session && typeof event.session === "object") addString(ids, event.session.id);
  if (event.context && typeof event.context === "object") addString(ids, event.context.sessionId);
  return [...ids];
}

function addString(ids, value) {
  if (typeof value === "string" && value.length > 0) ids.add(value);
}

function addStrings(ids, value) {
  if (!Array.isArray(value)) return;
  for (const item of value) addString(ids, item);
}

function isSessionIdShape(value) {
  return typeof value === "string" && SESSION_ID_SHAPE.test(value);
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
