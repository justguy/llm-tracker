// SH-0-03 HTTP route. Read-only GET; no auth required (matches the existing
// convention for non-mutating endpoints — see /api/workspace, /healthz).
//
// Response shape:
//   200 OK
//   { resolved: <full sessionHub block>,
//     sources: [{ kind, path?, appliedKeys? }, ...] }
//
// The route handler calls `loadConfig` on every request so the latest on-disk
// changes are reflected without a hub restart. If the on-disk file is
// malformed, the loader throws a line-anchored error and the route returns
// 500 with that error in JSON.

import { loadWorkspaceConfig } from "../config/loader.js";

export function registerWorkspaceConfigRoutes(
  app,
  { workspace, loadConfig = loadWorkspaceConfig } = {}
) {
  if (!app || typeof app.get !== "function") {
    throw new Error("registerWorkspaceConfigRoutes: express app required");
  }
  if (!workspace) {
    throw new Error("registerWorkspaceConfigRoutes: workspace path required");
  }

  app.get("/api/workspace/config/session-hub", async (_req, res) => {
    try {
      const result = await loadConfig({ workspaceRoot: workspace });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).json({
        resolved: result.resolved?.sessionHub ?? null,
        sources: result.sources
      });
    } catch (err) {
      const body = {
        error: err.message || String(err),
        type: err.code || "workspace.config.error"
      };
      if (err.file) body.file = err.file;
      if (typeof err.line === "number") body.line = err.line;
      if (typeof err.column === "number") body.column = err.column;
      if (err.errors) body.errors = err.errors;
      res.status(500).json(body);
    }
  });
}
