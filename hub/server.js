import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import { join, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import express from "express";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";
import { buildTrackerErrorBody } from "./error-payload.js";
import { registerIntelligenceRoutes } from "./routes/intelligence.js";
import { clearSearchCachesForSlug, primeSemanticIndex } from "./search.js";
import { Store, slugFromFile } from "./store.js";

// Watcher tuning: ignore obviously-irrelevant paths anywhere in the tree. The
// main trackers/ watcher uses native events and is already depth:0, but these
// patterns defend against accidental deep recursion via linked repo paths.
const WATCHER_IGNORED = /(^|[\\/])(node_modules|\.git|\.llm-tracker|\.runtime|\.snapshots|\.history)([\\/]|$)/;

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UI_SESSION_COOKIE = "llm_tracker_ui_session";
const UI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const MAX_SCRATCHPAD_LEN = 5000;
const MAX_COMMENT_LEN = 500;
const MAX_BLOCKER_REASON_LEN = 2000;

function isLocalOrigin(origin) {
  if (!origin) return false;
  return LOCAL_ORIGIN_RE.test(origin);
}

function requestOrigin(req) {
  const host = req.headers.host;
  if (!host) return null;
  return `http://${host}`;
}

function isAllowedMutatingOrigin(req, origin) {
  if (!origin) return false;
  if (isLocalOrigin(origin)) return true;
  return origin === requestOrigin(req);
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function patchTaskEntries(patch) {
  if (!patch || typeof patch !== "object" || !patch.tasks) return [];
  if (Array.isArray(patch.tasks)) {
    return patch.tasks
      .filter((t) => t && typeof t === "object")
      .map((t) => [t.id || "<unknown>", t]);
  }
  return Object.entries(patch.tasks).filter(([, t]) => t && typeof t === "object");
}

// Route-level rejection for oversized mutable fields. Runs before merge/schema
// validation so hallucinated payloads are dropped cheaply.
function checkPatchSize(body) {
  if (!body || typeof body !== "object") return null;
  const scratchpad = body?.meta?.scratchpad ?? body?.scratchpad;
  if (typeof scratchpad === "string" && scratchpad.length > MAX_SCRATCHPAD_LEN) {
    return {
      field: "meta.scratchpad",
      max: MAX_SCRATCHPAD_LEN,
      actual: scratchpad.length
    };
  }
  for (const [id, task] of patchTaskEntries(body)) {
    if (typeof task.comment === "string" && task.comment.length > MAX_COMMENT_LEN) {
      return {
        field: `tasks[${id}].comment`,
        max: MAX_COMMENT_LEN,
        actual: task.comment.length
      };
    }
    if (
      typeof task.blocker_reason === "string" &&
      task.blocker_reason.length > MAX_BLOCKER_REASON_LEN
    ) {
      return {
        field: `tasks[${id}].blocker_reason`,
        max: MAX_BLOCKER_REASON_LEN,
        actual: task.blocker_reason.length
      };
    }
  }
  return null;
}

function rejectOversizedMutableFields(req, res, next) {
  const violation = checkPatchSize(req.body);
  if (!violation) return next();
  return res.status(413).json({
    error: `${violation.field} is ${violation.actual} chars; limit is ${violation.max}`,
    type: "field.too.large",
    field: violation.field,
    max: violation.max,
    actual: violation.actual,
    hint: "Trim the field before resubmitting. Limits exist to keep tracker files human-reviewable."
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml"
};

function isLinkedTrackerPath(filePath) {
  if (!filePath) return false;
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function targetPayload(slug, entry, { workspace = null, port = null } = {}) {
  const registrationFile = entry?.path || (workspace ? join(workspace, "trackers", `${slug}.json`) : null);
  let file = registrationFile;
  if (file) {
    try {
      file = realpathSync(file);
    } catch {}
  }
  const topology = registrationFile && isLinkedTrackerPath(registrationFile)
    ? "repo-linked"
    : "shared-workspace";

  return {
    workspace,
    port,
    file: file || null,
    registrationFile: registrationFile || null,
    topology
  };
}

function projectPayload(slug, entry, runtime = {}) {
  const target = targetPayload(slug, entry, runtime);
  if (!entry) {
    return {
      slug,
      data: null,
      derived: null,
      rev: null,
      error: null,
      file: target.file,
      registrationFile: target.registrationFile,
      workspace: target.workspace,
      port: target.port,
      topology: target.topology,
      target
    };
  }
  return {
    slug,
    data: entry.data,
    derived: entry.derived,
    rev: entry.rev,
    error: entry.error || null,
    file: target.file,
    registrationFile: target.registrationFile,
    workspace: target.workspace,
    port: target.port,
    topology: target.topology,
    target
  };
}

function snapshot(store, runtime = {}) {
  const projects = {};
  for (const { slug } of store.list()) {
    projects[slug] = projectPayload(slug, store.get(slug), runtime);
  }
  return projects;
}

export async function startHub({ workspace, port, uiDir, host, token } = {}) {
  const store = new Store(workspace);
  const app = express();
  const uiSessions = new Map();
  const runtime = { workspace, port };
  const projectFor = (slug, entry) => projectPayload(slug, entry, runtime);
  const targetFor = (slug, entry = store.get(slug)) => targetPayload(slug, entry, runtime);

  const bindHost = host || process.env.LLM_TRACKER_HOST || "127.0.0.1";
  const bearerToken =
    typeof token === "string" && token.length > 0
      ? token
      : process.env.LLM_TRACKER_TOKEN || "";

  const pruneUiSessions = () => {
    const now = Date.now();
    for (const [id, expiresAt] of uiSessions) {
      if (expiresAt <= now) uiSessions.delete(id);
    }
  };

  const issueUiSession = () => {
    pruneUiSessions();
    const id = randomBytes(24).toString("hex");
    uiSessions.set(id, Date.now() + UI_SESSION_TTL_MS);
    return id;
  };

  const hasValidUiSession = (req) => {
    pruneUiSessions();
    const cookies = parseCookies(req.headers.cookie);
    const id = cookies[UI_SESSION_COOKIE];
    if (!id) return false;
    const expiresAt = uiSessions.get(id);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      uiSessions.delete(id);
      return false;
    }
    return true;
  };

  // Periodic sweep to evict expired UI-session entries so the Map does not
  // grow unbounded on a long-running hub. Each page load issues a new entry,
  // so without this a multi-day hub accumulates O(page-loads) stale entries.
  // The interval is unref()d so it does not keep the Node event loop alive
  // when the hub shuts down cleanly (tests that spawn a daemon won't hang).
  const UI_SESSION_SWEEP_INTERVAL_MS = Math.max(60_000, UI_SESSION_TTL_MS / 10);
  const uiSessionSweepTimer = setInterval(pruneUiSessions, UI_SESSION_SWEEP_INTERVAL_MS);
  uiSessionSweepTimer.unref();

  // CSRF / cross-origin guard. The hub binds to loopback by default, but a
  // malicious web page in a local browser can still fire cross-origin POSTs
  // at the hub. Reject any mutating request whose Origin/Referer is neither
  // loopback nor the exact origin serving this request. Browser fetch always
  // attaches Origin on cross-origin POST, so this is a strict check. CLI/MCP/
  // curl requests usually have no Origin at all and are treated as trusted.
  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      if (!isAllowedMutatingOrigin(req, origin)) {
        return res.status(403).json({
          error: "cross-origin request blocked",
          hint: "Mutating requests must come from this hub origin or a loopback origin."
        });
      }
      return next();
    }
    const referer = req.headers.referer;
    if (referer) {
      try {
        const u = new URL(referer);
        if (!isAllowedMutatingOrigin(req, u.origin)) {
          return res.status(403).json({
            error: "cross-origin request blocked",
            hint: "Mutating requests must come from this hub origin or a loopback origin."
          });
        }
      } catch {
        return res.status(403).json({
          error: "invalid Referer header",
          hint: "Mutating requests must come from this hub origin or a loopback origin."
        });
      }
    }
    next();
  });

  // Optional bearer-token guard. When LLM_TRACKER_TOKEN is set, every mutating
  // request must carry a matching Authorization: Bearer <token> header (or
  // X-LLM-Tracker-Token). Same-origin browser UI requests are also allowed via
  // a short-lived HttpOnly session cookie minted from the UI shell route, so
  // the raw bearer token never has to be exposed to page scripts.
  if (bearerToken) {
    app.use((req, res, next) => {
      if (SAFE_METHODS.has(req.method)) return next();
      const auth = req.headers.authorization || "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      const x = req.headers["x-llm-tracker-token"];
      if ((m && m[1] === bearerToken) || x === bearerToken || hasValidUiSession(req)) {
        return next();
      }
      return res.status(401).json({
        error: "missing or invalid auth",
        hint:
          "Set Authorization: Bearer $LLM_TRACKER_TOKEN (or X-LLM-Tracker-Token header) on mutating requests, or load the browser UI from this hub origin first."
      });
    });
  }

  // Default JSON body limit. Real patches are tiny (< 10 KB is typical);
  // 1 MB is already generous for full project files. Can be overridden via
  // LLM_TRACKER_BODY_LIMIT for the rare case of a very large full-project PUT.
  const bodyLimit = process.env.LLM_TRACKER_BODY_LIMIT || "1mb";
  app.use(express.json({ limit: bodyLimit }));
  const readmePath = join(workspace, "README.md");

  const sendWorkspaceHelp = (res) => {
    if (!existsSync(readmePath)) return res.status(404).send("No README");
    res.type("text/markdown").send(readFileSync(readmePath, "utf-8"));
  };

  // Health-check endpoint — no auth required (bearer middleware only guards
  // mutating methods; GET passes through unconditionally). Safe for Docker /
  // Kubernetes readiness probes even when LLM_TRACKER_TOKEN is set.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      projects: store.list().length,
      uptimeSeconds: Math.floor(process.uptime())
    });
  });

  app.get("/api/workspace", (_req, res) => {
    res.json({ workspace, port, readme: readmePath, help: "/help" });
  });

  app.get("/help", (_req, res) => {
    sendWorkspaceHelp(res);
  });

  const settingsFile = join(workspace, "settings.json");

  const readWsSettings = () => {
    if (!existsSync(settingsFile)) return {};
    try {
      return JSON.parse(readFileSync(settingsFile, "utf-8"));
    } catch {
      return {};
    }
  };

  app.get("/api/settings", (_req, res) => {
    res.json({
      saved: readWsSettings(),
      running: { port, workspace }
    });
  });

  let reloadProject = async () => ({ ok: false, status: 503, message: "hub not ready" });
  let reloadAllProjects = async () => ({ reloaded: [], errors: [] });

  app.put("/api/settings", (req, res) => {
    const body = req.body || {};
    const current = readWsSettings();
    const merged = { ...current };

    if (body.port !== undefined) {
      const p = parseInt(body.port, 10);
      if (isNaN(p) || p < 1 || p > 65535) {
        return res.status(400).json({ error: "port must be an integer between 1 and 65535" });
      }
      merged.port = p;
    }

    try {
      const tmp = `${settingsFile}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2));
      renameSync(tmp, settingsFile);
    } catch (e) {
      return res.status(500).json({ error: `failed to write settings: ${e.message}` });
    }

    res.json({
      saved: merged,
      running: { port, workspace },
      restartRequired: merged.port !== undefined && merged.port !== port
    });
  });

  app.get("/api/projects", async (_req, res) => {
    await reloadAllProjects({ broadcastUpdate: false });
    res.json({
      workspace,
      port,
      projects: store.list().map((project) => ({
        ...project,
        ...targetFor(project.slug)
      }))
    });
  });

  app.param("slug", async (req, _res, next, slug) => {
    if (!slug || store.get(slug)) return next();
    const result = await reloadProject(slug, { broadcastUpdate: true });
    if (result?.ok) req.projectReloadedFromDisk = true;
    next();
  });

  app.get("/api/projects/:slug", async (req, res) => {
    let entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });
    if (isLinkedTrackerPath(entry.path)) {
      await reloadProject(req.params.slug, { broadcastUpdate: true });
      entry = store.get(req.params.slug);
      if (!entry) return res.status(404).json({ error: "not found" });
    }
    res.json(projectFor(req.params.slug, entry));
  });
  registerIntelligenceRoutes(app, { workspace, store, targetFor });

  app.put("/api/projects/:slug", rejectOversizedMutableFields, async (req, res) => {
    const r = await store.createOrReplace(req.params.slug, req.body || {});
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    const entry = store.get(req.params.slug);
    res.json({ ok: true, slug: req.params.slug, ...targetFor(req.params.slug, entry) });
  });

  app.delete("/api/projects/:slug", async (req, res) => {
    const target = targetFor(req.params.slug);
    const r = await store.deleteProject(req.params.slug);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    broadcast({ type: "REMOVE", slug: req.params.slug });
    res.json({ ok: true, slug: req.params.slug, rev: r.deletedRev ?? null, ...target });
  });

  app.post("/api/projects/:slug/restore", async (req, res) => {
    const { rev } = req.body || {};
    const parsedRev = rev === undefined ? undefined : parseInt(rev, 10);
    if (rev !== undefined && (!Number.isInteger(parsedRev) || parsedRev < 1)) {
      return res.status(400).json({ error: "body.rev must be a positive integer (or omit to restore latest)" });
    }
    const result = await store.restoreProject(req.params.slug, { rev: parsedRev });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    const entry = store.get(req.params.slug);
    primeSemanticIndex({
      workspace,
      slug: req.params.slug,
      entry
    });
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectFor(req.params.slug, entry)
    });
    res.json({
      ok: true,
      slug: req.params.slug,
      restoredFromRev: result.restoredFromRev,
      rev: entry?.rev ?? result.newRev ?? null,
      file: targetFor(req.params.slug, entry).file || result.file,
      loaded: !!entry,
      ...targetFor(req.params.slug, entry)
    });
  });

  app.post("/api/projects/:slug/symlink", async (req, res) => {
    const { target } = req.body || {};
    const r = await store.symlinkProject(req.params.slug, target);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    const loaded = await reloadProject(req.params.slug);
    if (!loaded?.ok) {
      return res.status(500).json({
        error: `symlink created but eager load failed: ${loaded?.message || "unknown error"}`,
        linkPath: r.linkPath,
        target: r.target
      });
    }
    res.json({
      ok: true,
      slug: req.params.slug,
      linkPath: r.linkPath,
      target: r.target,
      loaded: true,
      rev: store.get(req.params.slug)?.rev ?? null,
      ...targetFor(req.params.slug)
    });
  });

  app.post("/api/projects/:slug/reload", async (req, res) => {
    const result = await reloadProject(req.params.slug);
    if (!result?.ok) {
      return res.status(result?.status || 400).json(
        buildTrackerErrorBody({
          message: result?.message || result?.error || "reload failed",
          kind: result?.kind || result?.type || null,
          type: result?.type || result?.kind || null,
          hint: result?.hint || null,
          path: result?.path || null
        })
      );
    }
    res.json({
      ok: true,
      slug: req.params.slug,
      rev: store.get(req.params.slug)?.rev ?? null,
      event: result.event,
      noop: result.noop === true,
      ...targetFor(req.params.slug)
    });
  });

  app.post("/api/reload", async (_req, res) => {
    const result = await reloadAllProjects();
    res.json({
      ok: result.errors.length === 0,
      workspace,
      port,
      reloaded: result.reloaded,
      errors: result.errors
    });
  });

  app.delete("/api/projects/:slug/tasks/:taskId", async (req, res) => {
    const r = await store.deleteTask(req.params.slug, req.params.taskId);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    res.json({ ok: true, ...targetFor(req.params.slug) });
  });

  app.get("/api/projects/:slug/since/:rev", (req, res) => {
    const fromRev = parseInt(req.params.rev, 10);
    if (isNaN(fromRev) || fromRev < 0) {
      return res.status(400).json({ error: "rev must be a non-negative integer" });
    }
    const result = store.getSince(req.params.slug, fromRev);
    if (!result) return res.status(404).json({ error: "project not found" });
    res.json({ ...result, ...targetFor(req.params.slug) });
  });

  app.get("/api/projects/:slug/revisions", (req, res) => {
    const revisions = store.revisions(req.params.slug);
    res.json({ slug: req.params.slug, revisions, ...targetFor(req.params.slug) });
  });

  app.get("/api/projects/:slug/history", (req, res) => {
    const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const fromRevRaw = Array.isArray(req.query.fromRev) ? req.query.fromRev[0] : req.query.fromRev;
    const limit = limitRaw === undefined ? 50 : parseInt(limitRaw, 10);
    const fromRev = fromRevRaw === undefined ? 0 : parseInt(fromRevRaw, 10);

    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: "limit must be an integer between 1 and 200" });
    }
    if (isNaN(fromRev) || fromRev < 0) {
      return res.status(400).json({ error: "fromRev must be a non-negative integer" });
    }

    const history = store.history(req.params.slug, { fromRev, limit });
    if (!history) return res.status(404).json({ error: "project not found" });
    res.json({ ...history, ...targetFor(req.params.slug) });
  });

  app.post("/api/projects/:slug/rollback", async (req, res) => {
    const { to } = req.body || {};
    const toRev = parseInt(to, 10);
    if (isNaN(toRev) || toRev < 1) {
      return res.status(400).json({ error: "body.to must be a positive integer rev" });
    }
    const r = await store.rollback(req.params.slug, toRev);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    const entry = store.get(req.params.slug);
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectFor(req.params.slug, entry)
    });
    res.json({ ok: true, from: r.from, to: r.to, newRev: r.newRev, ...targetFor(req.params.slug, entry) });
  });

  app.post("/api/projects/:slug/undo", async (req, res) => {
    const result = await store.undo(req.params.slug);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    const entry = store.get(req.params.slug);
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectFor(req.params.slug, entry)
    });
    res.json({ ok: true, from: result.from, to: result.to, newRev: result.newRev, action: "undo", ...targetFor(req.params.slug, entry) });
  });

  app.post("/api/projects/:slug/redo", async (req, res) => {
    const result = await store.redo(req.params.slug);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    const entry = store.get(req.params.slug);
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectFor(req.params.slug, entry)
    });
    res.json({ ok: true, from: result.from, to: result.to, newRev: result.newRev, action: "redo", ...targetFor(req.params.slug, entry) });
  });

  app.post("/api/projects/:slug/patch", rejectOversizedMutableFields, async (req, res) => {
    const patch = req.body || {};
    const r = await store.applyPatch(req.params.slug, patch);
    if (!r.ok) {
      return res.status(r.status || 400).json({
        error: r.message,
        type: r.type || null,
        hint: r.hint || null,
        repair: r.repair || null,
        expectedRev: Number.isInteger(r.expectedRev) ? r.expectedRev : null,
        currentRev: Number.isInteger(r.currentRev) ? r.currentRev : null,
        notes: r.notes || null,
        ...targetFor(req.params.slug)
      });
    }
    const entry = store.get(req.params.slug);
    if (r.noop !== true && entry) {
      broadcast({
        type: "UPDATE",
        slug: req.params.slug,
        project: projectFor(req.params.slug, entry)
      });
    }
    const target = targetFor(req.params.slug, entry);
    res.json({
      ok: true,
      rev: r.rev ?? entry?.rev ?? null,
      updatedAt: entry?.data?.meta?.updatedAt ?? null,
      file: target.file,
      notes: r.notes,
      noopReason: r.noopReason || null,
      noop: r.noop === true,
      ...target
    });
  });

  const startHandler = async (req, res) => {
    const body = req.body || {};
    const result = await store.startTask(req.params.slug, {
      taskId: req.params.taskId || body.taskId,
      assignee: typeof body.assignee === "string" && body.assignee.trim() ? body.assignee : null,
      force: body.force === true,
      comment: body.comment,
      scratchpad: body.scratchpad
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({
        error: result.message,
        ...targetFor(req.params.slug)
      });
    }
    const entry = store.get(req.params.slug);
    if (result.noop !== true && entry) {
      broadcast({
        type: "UPDATE",
        slug: req.params.slug,
        project: projectFor(req.params.slug, entry)
      });
    }
    res.json({
      ...result.payload,
      noop: result.noop === true,
      ...targetFor(req.params.slug, entry)
    });
  };
  app.post("/api/projects/:slug/start", rejectOversizedMutableFields, startHandler);
  app.post("/api/projects/:slug/tasks/:taskId/start", rejectOversizedMutableFields, startHandler);

  app.post("/api/projects/:slug/swimlane-collapse", async (req, res) => {
    const { swimlaneId, collapsed } = req.body || {};
    if (!swimlaneId || typeof collapsed !== "boolean") {
      return res.status(400).json({ error: "swimlaneId and collapsed (boolean) required" });
    }
    const r = await store.applyCollapse(req.params.slug, { swimlaneId, collapsed });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    const entry = store.get(req.params.slug);
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectFor(req.params.slug, entry)
    });
    res.json({ ok: true, noop: r.noop === true, ...targetFor(req.params.slug, entry) });
  });

  app.post("/api/projects/:slug/swimlane-move", async (req, res) => {
    const { swimlaneId, direction } = req.body || {};
    if (!swimlaneId || (direction !== "up" && direction !== "down")) {
      return res.status(400).json({ error: "swimlaneId and direction (up|down) required" });
    }
    const r = await store.applySwimlaneMove(req.params.slug, { swimlaneId, direction });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    const entry = store.get(req.params.slug);
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectFor(req.params.slug, entry)
    });
    res.json({ ok: true, noop: r.noop === true, ...targetFor(req.params.slug, entry) });
  });

  app.post("/api/projects/:slug/move", async (req, res) => {
    const { taskId, swimlaneId, priorityId, targetIndex } = req.body || {};
    if (!taskId || !swimlaneId || !priorityId) {
      return res.status(400).json({ error: "taskId, swimlaneId, priorityId required" });
    }
    const result = await store.applyMove(req.params.slug, {
      taskId,
      swimlaneId,
      priorityId,
      targetIndex
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    res.json({ ok: true, ...targetFor(req.params.slug) });
  });

  app.get("/README.md", (_req, res) => {
    sendWorkspaceHelp(res);
  });

  app.get("/api/history/:slug", (req, res) => {
    const history = store.history(req.params.slug, { fromRev: 0, limit: 50 });
    res.json({ lines: history?.events || [], ...targetFor(req.params.slug) });
  });

  // Vendor UI deps resolved from the hub's node_modules (works for local dev
  // and for `npm install -g llm-tracker` since deps ship with the package).
  const req = createRequire(import.meta.url);
  const VENDOR = {};
  try {
    VENDOR["/vendor/preact.mjs"] = req.resolve("preact").replace(/\.(js|module\.js)$/, ".mjs");
    VENDOR["/vendor/preact-hooks.mjs"] = join(dirname(req.resolve("preact")), "..", "hooks", "dist", "hooks.mjs");
    VENDOR["/vendor/htm.mjs"] = req.resolve("htm").replace(/\.js$/, ".mjs");
    VENDOR["/vendor/htm-preact.mjs"] = join(dirname(req.resolve("htm")), "..", "preact", "index.mjs");
    VENDOR["/vendor/dagre.mjs"] = req.resolve("@dagrejs/dagre").replace(/dagre\.cjs\.js$/, "dagre.esm.js");
  } catch (e) {
    console.warn(`[hub] could not resolve UI vendor deps: ${e.message}`);
  }

  app.use((request, res, next) => {
    if (request.method !== "GET") return next();

    if (VENDOR[request.path]) {
      const f = VENDOR[request.path];
      if (existsSync(f)) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.send(readFileSync(f));
      }
    }

    let p = request.path === "/" ? "/index.html" : request.path;
    const file = join(uiDir, p);
    if (!existsSync(file) || !file.startsWith(uiDir)) return next();
    const type = MIME[extname(file)] || "application/octet-stream";
    res.setHeader("Content-Type", type);
    // All UI assets get nosniff; the HTML shell gets the full set of
    // framing / referrer headers as well.
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (file.endsWith("index.html")) {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "interest-cohort=()");
    }
    if (bearerToken && file.endsWith("index.html")) {
      const existing = parseCookies(request.headers.cookie)[UI_SESSION_COOKIE];
      const reuse = existing && uiSessions.get(existing) > Date.now();
      const sessionId = reuse ? existing : issueUiSession();
      res.setHeader(
        "Set-Cookie",
        `${UI_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
          UI_SESSION_TTL_MS / 1000
        )}`
      );
      res.setHeader("Cache-Control", "no-store");
    }
    res.send(readFileSync(file));
  });

  app.use((_req, res) => res.status(404).send("Not found"));

  // JSON error handler — so clients (and LLMs) always get a machine-readable
  // response, including for body-parse / size-limit failures that Express
  // normally would render as HTML.
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || String(err);
    res.status(status).json({
      error: message,
      type: err.type || null,
      hint:
        err.type === "entity.too.large"
          ? `Request body exceeds ${bodyLimit}. Split the patch into smaller chunks, or set LLM_TRACKER_BODY_LIMIT if your project is legitimately this large.`
          : err.type === "entity.parse.failed"
          ? "Body is not valid JSON. Check quoting / escaping / trailing commas."
          : undefined
    });
  });

  const httpServer = createServer(app);
  // WebSocket upgrade guard. Matches the HTTP cross-origin policy: cross-origin
  // browsers cannot open /ws, so a malicious page cannot subscribe to project
  // broadcasts. When a bearer token is active, also require a valid
  // Authorization: Bearer header OR a live UI session cookie.
  const verifyWsClient = (info, done) => {
    const origin = info.req.headers.origin;
    if (origin && !isAllowedMutatingOrigin(info.req, origin)) {
      return done(false, 403, "cross-origin websocket rejected");
    }
    if (bearerToken) {
      const auth = info.req.headers.authorization || "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      const x = info.req.headers["x-llm-tracker-token"];
      if ((m && m[1] === bearerToken) || x === bearerToken || hasValidUiSession(info.req)) {
        return done(true);
      }
      return done(false, 401, "auth required");
    }
    done(true);
  };
  const wss = new WebSocketServer({ server: httpServer, path: "/ws", verifyClient: verifyWsClient });
  const sockets = new Set();
  let shuttingDown = false;

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "SNAPSHOT", projects: snapshot(store, runtime) }));
  });

  const trackersDir = join(workspace, "trackers");
  const patchesDir = join(workspace, "patches");
  // Main trackers watcher uses native filesystem events. depth:0 + the ignored
  // pattern prevent recursion into node_modules / .git / hub-owned sibling
  // directories even if the workspace lives next to them.
  const watcher = chokidar.watch(trackersDir, {
    ignoreInitial: true,
    depth: 0,
    followSymlinks: false,
    ignored: WATCHER_IGNORED,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 }
  });

  // Polling watcher for symlinked tracker targets outside the workspace
  // (Option C registration). Native fsevents does not forward changes from
  // outside the watched tree, so we poll only the individual target file —
  // not its parent directory — to keep CPU cost bounded.
  // slug → { target, mtimeMs, size } for linked tracker files outside the
  // workspace. Polling exact files is more reliable here than asking chokidar
  // to bootstrap a second dynamic polling tree.
  const linkedTargetsBySlug = new Map();

  const trackLinkedTarget = (slug) => {
    const trackerFile = join(trackersDir, `${slug}.json`);
    let real;
    try {
      const l = lstatSync(trackerFile);
      if (!l.isSymbolicLink()) return;
      real = realpathSync(trackerFile);
    } catch {
      return;
    }
    if (!real || real === trackerFile) return;
    let stat;
    try {
      stat = statSync(real);
    } catch {
      return;
    }
    const existing = linkedTargetsBySlug.get(slug);
    if (existing?.target === real && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
      return;
    }
    linkedTargetsBySlug.set(slug, {
      target: real,
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  };

  const untrackLinkedTarget = (slug) => {
    linkedTargetsBySlug.delete(slug);
  };

  // Patch-file watcher (bash-less write path): any file dropped into patches/
  // is applied via store.applyPatch using the slug from the filename prefix,
  // then removed. Errors surface as <name>.errors.json next to the patch.
  const patchesWatcher = chokidar.watch(patchesDir, {
    ignoreInitial: true,
    depth: 0,
    ignored: WATCHER_IGNORED,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 }
  });

  const handlePatchFile = async (patchPath) => {
    if (!patchPath.endsWith(".json")) return;
    if (patchPath.endsWith(".errors.json")) return;
    const base = patchPath.split("/").pop();
    const m = base.match(/^([a-z0-9][a-z0-9-]*)\./);
    if (!m) return;
    const slug = m[1];
    let body;
    try {
      body = JSON.parse(readFileSync(patchPath, "utf-8"));
    } catch (e) {
      try {
        const errPath = patchPath.replace(/\.json$/, ".errors.json");
        writeFileSync(
          errPath,
          JSON.stringify(buildTrackerErrorBody({ message: e.message, kind: "parse", path: patchPath }), null, 2)
        );
      } catch {}
      return;
    }
    const r = await store.applyPatch(slug, body);
    if (!r.ok) {
      const errPath = patchPath.replace(/\.json$/, ".errors.json");
      try {
        writeFileSync(
          errPath,
          JSON.stringify(
            buildTrackerErrorBody({
              message: r.message,
              kind: r.type || "schema",
              type: r.type || "schema",
              hint: r.hint || null,
              path: patchPath,
              notes: r.notes || null,
              repair: r.repair || null,
              expectedRev: Number.isInteger(r.expectedRev) ? r.expectedRev : null,
              currentRev: Number.isInteger(r.currentRev) ? r.currentRev : null
            }),
            null,
            2
          )
        );
      } catch {}
      return;
    }
    if (r.noop !== true) {
      broadcast({
        type: "UPDATE",
        slug,
        project: projectFor(slug, store.get(slug))
      });
    }
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(patchPath);
      const errPath = patchPath.replace(/\.json$/, ".errors.json");
      if (existsSync(errPath)) unlinkSync(errPath);
    } catch {}
  };

  patchesWatcher.on("add", handlePatchFile);

  const isTrackerFile = (filePath) => {
    if (!filePath.endsWith(".json")) return false;
    if (filePath.endsWith(".errors.json")) return false;
    return true;
  };

  const ingestTrackerFile = async (filePath, { broadcastUpdate = true } = {}) => {
    if (!isTrackerFile(filePath)) return;
    const slug = slugFromFile(filePath);
    if (!slug) return;
    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return;
    }
    // Ingestion must hold the per-slug lock so it serializes with HTTP patch,
    // UI move/drag, undo/redo, rollback, and deleteTask paths. Otherwise a
    // chokidar event firing mid-write could interleave with an in-flight
    // mutation and clobber state.
    const result = await store.ingestLocked(filePath, raw);
    if (result?.ok && result?.slug) {
      const entry = store.get(result.slug);
      primeSemanticIndex({
        workspace,
        slug: result.slug,
        entry
      });
      trackLinkedTarget(result.slug);
    }
    if (result?.silentRewrite) {
      const { fields, reingestNote } = result.silentRewrite;
      if (fields?.length) {
        const previews = fields.slice(0, 5).map((f) => {
          const bits = [];
          if (f.reAddedByMerge?.length) bits.push(`re-added ${f.reAddedByMerge.join(",")}`);
          if (f.droppedByMerge?.length) bits.push(`dropped ${f.droppedByMerge.join(",")}`);
          return `${f.path} (${bits.join("; ")})`;
        });
        const suffix = fields.length > previews.length ? `; +${fields.length - previews.length} more` : "";
        console.warn(
          `[hub] ${result.slug}: silent rewrite — merge re-applied keys not in ${filePath}. ${previews.join(" | ")}${suffix}`
        );
        console.warn(
          `[hub] ${result.slug}: direct file edits go through merge; use PUT /api/projects/${result.slug} or a patch with explicit null values to remove keys.`
        );
      } else if (reingestNote) {
        console.warn(`[hub] ${result.slug}: silent rewrite — ${reingestNote}`);
      }
    }
    if (broadcastUpdate && result?.slug && result?.event && result?.noop !== true) {
      broadcast({
        type: result.event,
        slug: result.slug,
        project: projectFor(result.slug, store.get(result.slug))
      });
    }
    return result;
  };

  reloadProject = async (slug, { broadcastUpdate = true } = {}) => {
    const filePath = join(trackersDir, `${slug}.json`);
    if (!existsSync(filePath)) {
      return { ok: false, status: 404, message: "project not found on disk" };
    }
    return (
      (await ingestTrackerFile(filePath, { broadcastUpdate })) || {
        ok: false,
        status: 404,
        message: "project not found on disk"
      }
    );
  };

  reloadAllProjects = async ({ broadcastUpdate = true } = {}) => {
    const files = existsSync(trackersDir)
      ? readdirSync(trackersDir)
          .filter((name) => isTrackerFile(name))
          .map((name) => join(trackersDir, name))
      : [];

    const reloaded = [];
    const errors = [];
    for (const filePath of files) {
      const result = await ingestTrackerFile(filePath, { broadcastUpdate });
      if (!result) continue;
      if (result.ok) {
        const entry = store.get(result.slug);
        reloaded.push({
          slug: result.slug,
          rev: entry?.rev ?? null,
          event: result.event,
          noop: result.noop === true,
          ...targetFor(result.slug, entry)
        });
      } else {
        const errorBody = buildTrackerErrorBody({
          message: result.reason || result.message || result.error || "reload failed",
          kind: result.kind || result.type || null,
          type: result.type || result.kind || null,
          hint: result.hint || null,
          path: result.path || null
        });
        errors.push({
          slug: result.slug || slugFromFile(filePath),
          message: errorBody.error,
          type: errorBody.type,
          hint: errorBody.hint || null,
          path: errorBody.path || null
        });
      }
    }
    return { reloaded, errors };
  };

  await reloadAllProjects({ broadcastUpdate: false });

  watcher
    .on("add", (filePath) => ingestTrackerFile(filePath))
    .on("change", (filePath) => ingestTrackerFile(filePath))
    .on("unlink", (filePath) => {
      if (!isTrackerFile(filePath)) return;
      const slug = slugFromFile(filePath);
      if (slug) {
        clearSearchCachesForSlug(workspace, slug);
        untrackLinkedTarget(slug);
      }
      const r = store.remove(filePath);
      if (r) broadcast({ type: "REMOVE", slug: r.slug });
    });

  const linkedTargetsPollTimer = setInterval(() => {
    for (const [slug, tracked] of linkedTargetsBySlug) {
      let stat;
      try {
        stat = statSync(tracked.target);
      } catch {
        // Target deleted out from under us — clear tracking; the symlink in
        // trackers/ is now dangling and the next read will surface that.
        untrackLinkedTarget(slug);
        continue;
      }
      if (stat.mtimeMs === tracked.mtimeMs && stat.size === tracked.size) continue;
      tracked.mtimeMs = stat.mtimeMs;
      tracked.size = stat.size;
      const trackerFile = join(trackersDir, `${slug}.json`);
      if (existsSync(trackerFile)) ingestTrackerFile(trackerFile);
    }
  }, 300);
  linkedTargetsPollTimer.unref?.();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    clearInterval(uiSessionSweepTimer);
    clearInterval(linkedTargetsPollTimer);

    try {
      await watcher.close();
    } catch {}
    try {
      await patchesWatcher.close();
    } catch {}
    try {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      await new Promise((resolve) => wss.close(() => resolve()));
    } catch {}
    try {
      if (typeof httpServer.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
      }
    } catch {}

    const forceTimer = setTimeout(() => {
      try {
        if (typeof httpServer.closeAllConnections === "function") {
          httpServer.closeAllConnections();
        }
      } catch {}
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {}
      }
    }, 1500);
    forceTimer.unref?.();

    await new Promise((resolve) => httpServer.close(() => resolve()));
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise((resolve, reject) => {
    const onError = async (err) => {
      httpServer.off("listening", onListening);
      clearInterval(linkedTargetsPollTimer);
      try {
        await watcher.close();
      } catch {}
      try {
        await patchesWatcher.close();
      } catch {}
      try {
        wss.close();
      } catch {}
      reject(err);
    };

    const onListening = () => {
      httpServer.off("error", onError);
      const url = `http://localhost:${port}`;
      console.log("─────────────────────────────────────────────────────────");
      console.log(` LLM Project Tracker — hub running`);
      console.log(`   UI:         ${url}`);
      console.log(`   Bind host:  ${bindHost}`);
      console.log(`   Workspace:  ${workspace}`);
      console.log(`   Help:       ${url}/help`);
      console.log(`   README:     ${readmePath}`);
      if (bearerToken) {
        console.log(`   Auth:       bearer header or local UI session required for mutating requests`);
      }
      console.log("─────────────────────────────────────────────────────────");
      console.log(" Paste into your LLM to register a project:");
      console.log("");
      console.log(`   Read ${join(workspace, "README.md")} and register this project as <slug>.`);
      console.log("");
      console.log("─────────────────────────────────────────────────────────");
      resolve();
    };

    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, bindHost);
  });

  return { httpServer, wss, store, watcher };
}
