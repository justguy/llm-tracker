import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import express from "express";
import cors from "cors";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";
import { registerIntelligenceRoutes } from "./routes/intelligence.js";
import { clearSearchCachesForSlug, primeSemanticIndex } from "./search.js";
import { Store, slugFromFile } from "./store.js";

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

function projectPayload(slug, entry) {
  if (!entry) return { slug, data: null, derived: null, error: null };
  return {
    slug,
    data: entry.data,
    derived: entry.derived,
    rev: entry.rev,
    error: entry.error || null
  };
}

function snapshot(store) {
  const projects = {};
  for (const { slug } of store.list()) {
    projects[slug] = projectPayload(slug, store.get(slug));
  }
  return projects;
}

export async function startHub({ workspace, port, uiDir }) {
  const store = new Store(workspace);
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "16mb" }));
  const readmePath = join(workspace, "README.md");

  const sendWorkspaceHelp = (res) => {
    if (!existsSync(readmePath)) return res.status(404).send("No README");
    res.type("text/markdown").send(readFileSync(readmePath, "utf-8"));
  };

  app.get("/api/workspace", (_req, res) => {
    res.json({ workspace, readme: readmePath, help: "/help" });
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

  let reloadProject = () => ({ ok: false, status: 503, message: "hub not ready" });
  let reloadAllProjects = () => ({ reloaded: [], errors: [] });

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

  app.get("/api/projects", (_req, res) => {
    reloadAllProjects({ broadcastUpdate: false });
    res.json({ projects: store.list() });
  });

  app.param("slug", (req, _res, next, slug) => {
    if (!slug || store.get(slug)) return next();
    const result = reloadProject(slug, { broadcastUpdate: true });
    if (result?.ok) req.projectReloadedFromDisk = true;
    next();
  });

  app.get("/api/projects/:slug", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });
    res.json(projectPayload(req.params.slug, entry));
  });
  registerIntelligenceRoutes(app, { workspace, store });

  app.put("/api/projects/:slug", async (req, res) => {
    const r = await store.createOrReplace(req.params.slug, req.body || {});
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    res.json({ ok: true, slug: req.params.slug });
  });

  app.delete("/api/projects/:slug", async (req, res) => {
    const r = await store.deleteProject(req.params.slug);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    res.json({ ok: true, slug: req.params.slug });
  });

  app.post("/api/projects/:slug/symlink", async (req, res) => {
    const { target } = req.body || {};
    const r = await store.symlinkProject(req.params.slug, target);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    const loaded = reloadProject(req.params.slug);
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
      rev: store.get(req.params.slug)?.rev ?? null
    });
  });

  app.post("/api/projects/:slug/reload", (req, res) => {
    const result = reloadProject(req.params.slug);
    if (!result?.ok) return res.status(result?.status || 400).json({ error: result?.message || "reload failed" });
    res.json({
      ok: true,
      slug: req.params.slug,
      rev: store.get(req.params.slug)?.rev ?? null,
      event: result.event,
      noop: result.noop === true
    });
  });

  app.post("/api/reload", (_req, res) => {
    const result = reloadAllProjects();
    res.json({
      ok: result.errors.length === 0,
      reloaded: result.reloaded,
      errors: result.errors
    });
  });

  app.delete("/api/projects/:slug/tasks/:taskId", async (req, res) => {
    const r = await store.deleteTask(req.params.slug, req.params.taskId);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    res.json({ ok: true });
  });

  app.get("/api/projects/:slug/since/:rev", (req, res) => {
    const fromRev = parseInt(req.params.rev, 10);
    if (isNaN(fromRev) || fromRev < 0) {
      return res.status(400).json({ error: "rev must be a non-negative integer" });
    }
    const result = store.getSince(req.params.slug, fromRev);
    if (!result) return res.status(404).json({ error: "project not found" });
    res.json(result);
  });

  app.get("/api/projects/:slug/revisions", (req, res) => {
    const revisions = store.revisions(req.params.slug);
    res.json({ slug: req.params.slug, revisions });
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
    res.json(history);
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
      project: projectPayload(req.params.slug, entry)
    });
    res.json({ ok: true, from: r.from, to: r.to, newRev: r.newRev });
  });

  app.post("/api/projects/:slug/undo", async (req, res) => {
    const result = await store.undo(req.params.slug);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    const entry = store.get(req.params.slug);
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectPayload(req.params.slug, entry)
    });
    res.json({ ok: true, from: result.from, to: result.to, newRev: result.newRev, action: "undo" });
  });

  app.post("/api/projects/:slug/redo", async (req, res) => {
    const result = await store.redo(req.params.slug);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    const entry = store.get(req.params.slug);
    broadcast({
      type: "UPDATE",
      slug: req.params.slug,
      project: projectPayload(req.params.slug, entry)
    });
    res.json({ ok: true, from: result.from, to: result.to, newRev: result.newRev, action: "redo" });
  });

  app.post("/api/projects/:slug/patch", async (req, res) => {
    const patch = req.body || {};
    const r = await store.applyPatch(req.params.slug, patch);
    if (!r.ok) {
      return res.status(r.status || 400).json({ error: r.message, notes: r.notes || null });
    }
    const entry = store.get(req.params.slug);
    res.json({
      ok: true,
      rev: entry?.rev ?? null,
      notes: r.notes
    });
  });

  app.post("/api/projects/:slug/swimlane-collapse", async (req, res) => {
    const { swimlaneId, collapsed } = req.body || {};
    if (!swimlaneId || typeof collapsed !== "boolean") {
      return res.status(400).json({ error: "swimlaneId and collapsed (boolean) required" });
    }
    const r = await store.applyCollapse(req.params.slug, { swimlaneId, collapsed });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message });
    res.json({ ok: true });
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
    res.json({ ok: true });
  });

  app.get("/README.md", (_req, res) => {
    sendWorkspaceHelp(res);
  });

  app.get("/api/history/:slug", (req, res) => {
    const history = store.history(req.params.slug, { fromRev: 0, limit: 50 });
    res.json({ lines: history?.events || [] });
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
  } catch (e) {
    console.warn(`[hub] could not resolve UI vendor deps: ${e.message}`);
  }

  app.use((request, res, next) => {
    if (request.method !== "GET") return next();

    if (VENDOR[request.path]) {
      const f = VENDOR[request.path];
      if (existsSync(f)) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        return res.send(readFileSync(f));
      }
    }

    let p = request.path === "/" ? "/index.html" : request.path;
    const file = join(uiDir, p);
    if (!existsSync(file) || !file.startsWith(uiDir)) return next();
    const type = MIME[extname(file)] || "application/octet-stream";
    res.setHeader("Content-Type", type);
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
          ? "Request body exceeds 16 MB. Split the patch into smaller chunks, or open a GitHub issue if your project is legitimately this large."
          : err.type === "entity.parse.failed"
          ? "Body is not valid JSON. Check quoting / escaping / trailing commas."
          : undefined
    });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
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
    ws.send(JSON.stringify({ type: "SNAPSHOT", projects: snapshot(store) }));
  });

  const trackersDir = join(workspace, "trackers");
  const patchesDir = join(workspace, "patches");
  // usePolling is required so symlinked trackers (Option C registration) pick
  // up changes the LLM makes to the target file, which lives in a different
  // directory than our native fsevents subscription.
  const watcher = chokidar.watch(trackersDir, {
    ignoreInitial: true,
    depth: 0,
    followSymlinks: true,
    usePolling: true,
    interval: 300,
    binaryInterval: 500,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 }
  });

  // Patch-file watcher (bash-less write path): any file dropped into patches/
  // is applied via store.applyPatch using the slug from the filename prefix,
  // then removed. Errors surface as <name>.errors.json next to the patch.
  const patchesWatcher = chokidar.watch(patchesDir, {
    ignoreInitial: true,
    depth: 0,
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
          JSON.stringify({ timestamp: new Date().toISOString(), kind: "parse", message: e.message, path: patchPath }, null, 2)
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
            { timestamp: new Date().toISOString(), kind: "schema", message: r.message, notes: r.notes || null, path: patchPath },
            null,
            2
          )
        );
      } catch {}
      return;
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

  const ingestTrackerFile = (filePath, { broadcastUpdate = true } = {}) => {
    if (!isTrackerFile(filePath)) return;
    const slug = slugFromFile(filePath);
    if (!slug) return;
    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return;
    }
    const result = store.ingest(filePath, raw);
    if (result?.ok && result?.slug) {
      const entry = store.get(result.slug);
      primeSemanticIndex({
        workspace,
        slug: result.slug,
        entry
      });
    }
    if (broadcastUpdate && result?.slug && result?.event) {
      broadcast({
        type: result.event,
        slug: result.slug,
        project: projectPayload(result.slug, store.get(result.slug))
      });
    }
    return result;
  };

  reloadProject = (slug, { broadcastUpdate = true } = {}) => {
    const filePath = join(trackersDir, `${slug}.json`);
    if (!existsSync(filePath)) {
      return { ok: false, status: 404, message: "project not found on disk" };
    }
    return (
      ingestTrackerFile(filePath, { broadcastUpdate }) || {
        ok: false,
        status: 404,
        message: "project not found on disk"
      }
    );
  };

  reloadAllProjects = ({ broadcastUpdate = true } = {}) => {
    const files = existsSync(trackersDir)
      ? readdirSync(trackersDir)
          .filter((name) => isTrackerFile(name))
          .map((name) => join(trackersDir, name))
      : [];

    const reloaded = [];
    const errors = [];
    for (const filePath of files) {
      const result = ingestTrackerFile(filePath, { broadcastUpdate });
      if (!result) continue;
      if (result.ok) {
        reloaded.push({
          slug: result.slug,
          rev: store.get(result.slug)?.rev ?? null,
          event: result.event,
          noop: result.noop === true
        });
      } else {
        errors.push({
          slug: result.slug || slugFromFile(filePath),
          message: result.reason || result.message || "reload failed"
        });
      }
    }
    return { reloaded, errors };
  };

  reloadAllProjects({ broadcastUpdate: false });

  watcher
    .on("add", (filePath) => ingestTrackerFile(filePath))
    .on("change", (filePath) => ingestTrackerFile(filePath))
    .on("unlink", (filePath) => {
      if (!isTrackerFile(filePath)) return;
      const slug = slugFromFile(filePath);
      if (slug) clearSearchCachesForSlug(workspace, slug);
      const r = store.remove(filePath);
      if (r) broadcast({ type: "REMOVE", slug: r.slug });
    });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

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
      console.log(`   Workspace:  ${workspace}`);
      console.log(`   Help:       ${url}/help`);
      console.log(`   README:     ${readmePath}`);
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
    httpServer.listen(port);
  });

  return { httpServer, wss, store, watcher };
}
