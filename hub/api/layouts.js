// hub/api/layouts.js — SH-2-08 (TDD v0.5 §6.11)
//
// GET / PUT / PATCH /api/layouts/session-hub against the workspace-local
// `.runtime/layouts/session-hub.json`. The single layout file is the sole
// source of truth (per-project subsections live inside it).
//
// TDD §12.4 aliases are also mounted:
// GET  /api/session-layouts/default
// PUT  /api/session-layouts/default
// POST /api/session-layouts/default/reset
//
// Error envelope mirrors hub/api/sessions.js: `{ error: { code, message, details? } }`.
// On schema or merge failure: 400 with code "LAYOUT_INVALID". On disk write
// failure: 500 with code "LAYOUT_WRITE_FAILED".

import { DEFAULT_LAYOUT, LayoutStore } from "../runtime/layouts.js";

export function registerLayoutsRoutes(app, { workspaceRoot, layoutStore, onLayoutUpdated, debounceMs = 100 } = {}) {
  if (!app || typeof app.get !== "function" || typeof app.put !== "function" || typeof app.patch !== "function") {
    throw new Error("registerLayoutsRoutes: express app with get/put/patch required");
  }
  const store = layoutStore ?? new LayoutStore({ workspaceRoot });
  const scheduleLayoutUpdated = createLayoutUpdateDebouncer(onLayoutUpdated, debounceMs);

  const getLayout = async (_req, res) => {
    try {
      const layout = await store.load();
      res.status(200).json({ layout });
    } catch (err) {
      sendError(res, 500, "LAYOUT_READ_FAILED", err.message || "layout load failed");
    }
  };

  const putLayout = async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "LAYOUT_INVALID", "request body must be a JSON object");
    }
    try {
      const saved = await store.save(body);
      scheduleLayoutUpdated(saved);
      res.status(200).json({ layout: saved });
    } catch (err) {
      if (isWriteError(err)) {
        return sendError(res, 500, "LAYOUT_WRITE_FAILED", err.message || "layout write failed");
      }
      sendError(res, 400, "LAYOUT_INVALID", err.message || "layout failed validation");
    }
  };

  const patchLayout = async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "LAYOUT_INVALID", "request body must be a JSON object");
    }
    try {
      const saved = await store.update(body);
      scheduleLayoutUpdated(saved);
      res.status(200).json({ layout: saved });
    } catch (err) {
      if (isWriteError(err)) {
        return sendError(res, 500, "LAYOUT_WRITE_FAILED", err.message || "layout write failed");
      }
      sendError(res, 400, "LAYOUT_INVALID", err.message || "layout failed validation");
    }
  };

  const resetLayout = async (_req, res) => {
    try {
      const saved = await store.save(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)));
      scheduleLayoutUpdated(saved);
      res.status(200).json({ layout: saved });
    } catch (err) {
      if (isWriteError(err)) {
        return sendError(res, 500, "LAYOUT_WRITE_FAILED", err.message || "layout write failed");
      }
      sendError(res, 400, "LAYOUT_INVALID", err.message || "layout failed validation");
    }
  };

  app.get("/api/layouts/session-hub", getLayout);
  app.put("/api/layouts/session-hub", putLayout);
  app.patch("/api/layouts/session-hub", patchLayout);

  app.get("/api/session-layouts/default", getLayout);
  app.put("/api/session-layouts/default", putLayout);
  app.post("/api/session-layouts/default/reset", resetLayout);
}

function createLayoutUpdateDebouncer(onLayoutUpdated, debounceMs) {
  if (typeof onLayoutUpdated !== "function") return () => {};
  const delay = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 100;
  let timer = null;
  let latestLayout = null;
  return (layout) => {
    latestLayout = layout;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const payload = latestLayout;
      latestLayout = null;
      onLayoutUpdated(payload);
    }, delay);
    timer.unref?.();
  };
}

// Filesystem errors carry a string `code` like ENOSPC, EACCES, EROFS, etc.
// Validation errors thrown by assertValidLayout are plain Error instances
// without a `code`. This narrow split lets us return 500 only for true
// disk faults.
function isWriteError(err) {
  return err && typeof err.code === "string" && /^[A-Z]+$/.test(err.code);
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
