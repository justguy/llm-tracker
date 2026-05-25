// hub/api/layouts.js — SH-2-08 (TDD v0.5 §6.11)
//
// GET / PUT / PATCH /api/layouts/session-hub against the workspace-local
// `.runtime/layouts/session-hub.json`. The single layout file is the sole
// source of truth (per-project subsections live inside it).
//
// Error envelope mirrors hub/api/sessions.js: `{ error: { code, message, details? } }`.
// On schema or merge failure: 400 with code "LAYOUT_INVALID". On disk write
// failure: 500 with code "LAYOUT_WRITE_FAILED".

import { LayoutStore } from "../runtime/layouts.js";

export function registerLayoutsRoutes(app, { workspaceRoot, layoutStore } = {}) {
  if (!app || typeof app.get !== "function" || typeof app.put !== "function" || typeof app.patch !== "function") {
    throw new Error("registerLayoutsRoutes: express app with get/put/patch required");
  }
  const store = layoutStore ?? new LayoutStore({ workspaceRoot });

  app.get("/api/layouts/session-hub", async (_req, res) => {
    try {
      const layout = await store.load();
      res.status(200).json({ layout });
    } catch (err) {
      sendError(res, 500, "LAYOUT_READ_FAILED", err.message || "layout load failed");
    }
  });

  app.put("/api/layouts/session-hub", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "LAYOUT_INVALID", "request body must be a JSON object");
    }
    try {
      const saved = await store.save(body);
      res.status(200).json({ layout: saved });
    } catch (err) {
      if (isWriteError(err)) {
        return sendError(res, 500, "LAYOUT_WRITE_FAILED", err.message || "layout write failed");
      }
      sendError(res, 400, "LAYOUT_INVALID", err.message || "layout failed validation");
    }
  });

  app.patch("/api/layouts/session-hub", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "LAYOUT_INVALID", "request body must be a JSON object");
    }
    try {
      const saved = await store.update(body);
      res.status(200).json({ layout: saved });
    } catch (err) {
      if (isWriteError(err)) {
        return sendError(res, 500, "LAYOUT_WRITE_FAILED", err.message || "layout write failed");
      }
      sendError(res, 400, "LAYOUT_INVALID", err.message || "layout failed validation");
    }
  });
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
