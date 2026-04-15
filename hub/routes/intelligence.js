import { getBriefPayload } from "../briefs.js";
import { getBlockersPayload } from "../blockers.js";
import { getChangedPayload } from "../changed.js";
import { getDecisionsPayload } from "../decisions.js";
import { getExecutePayload } from "../execute.js";
import { getNextPayload } from "../next.js";
import { getVerifyPayload } from "../verify.js";
import { getWhyPayload } from "../why.js";

function clampLimit(value, fallback, max) {
  const parsed = parseInt(Array.isArray(value) ? value[0] : value, 10);
  if (isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function registerIntelligenceRoutes(app, { workspace, store }) {
  const pickHandler = async (req, res) => {
    const body = req.body || {};
    const result = await store.pickTask(req.params.slug, {
      taskId: body.taskId,
      assignee: typeof body.assignee === "string" && body.assignee.trim() ? body.assignee : null,
      force: body.force === true,
      comment: body.comment
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    res.json(result.payload);
  };

  app.get("/api/projects/:slug/next", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const payload = getNextPayload({
      workspace,
      slug: req.params.slug,
      entry,
      limit: clampLimit(req.query.limit, 5, 5)
    });
    res.json(payload);
  });

  app.get("/api/projects/:slug/tasks/:taskId/brief", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const result = getBriefPayload({
      workspace,
      slug: req.params.slug,
      entry,
      taskId: req.params.taskId
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    res.json(result.payload);
  });

  app.get("/api/projects/:slug/tasks/:taskId/why", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const result = getWhyPayload({
      workspace,
      slug: req.params.slug,
      entry,
      taskId: req.params.taskId
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    res.json(result.payload);
  });

  app.get("/api/projects/:slug/tasks/:taskId/execute", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const result = getExecutePayload({
      workspace,
      slug: req.params.slug,
      entry,
      taskId: req.params.taskId
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    res.json(result.payload);
  });

  app.get("/api/projects/:slug/tasks/:taskId/verify", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const result = getVerifyPayload({
      workspace,
      slug: req.params.slug,
      entry,
      taskId: req.params.taskId
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    res.json(result.payload);
  });

  app.get("/api/projects/:slug/blockers", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const payload = getBlockersPayload({
      workspace,
      slug: req.params.slug,
      entry
    });
    res.json(payload);
  });

  app.get("/api/projects/:slug/changed", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const fromRevRaw = Array.isArray(req.query.fromRev) ? req.query.fromRev[0] : req.query.fromRev;
    const fromRev = fromRevRaw === undefined ? 0 : parseInt(fromRevRaw, 10);
    if (isNaN(fromRev) || fromRev < 0) {
      return res.status(400).json({ error: "fromRev must be a non-negative integer" });
    }

    const payload = getChangedPayload({
      workspace,
      slug: req.params.slug,
      entry,
      fromRev,
      limit: clampLimit(req.query.limit, 20, 50)
    });
    res.json(payload);
  });

  app.get("/api/projects/:slug/decisions", (req, res) => {
    const entry = store.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: "not found" });

    const payload = getDecisionsPayload({
      workspace,
      slug: req.params.slug,
      entry,
      limit: clampLimit(req.query.limit, 20, 20)
    });
    res.json(payload);
  });

  app.post("/api/projects/:slug/pick", pickHandler);
  app.post("/api/projects/:slug/claim", pickHandler);
}
