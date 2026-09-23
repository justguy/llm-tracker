import { isAbsolute, resolve } from "node:path";

const CREATE_FROM_ATTENTION_ALLOWED_FIELDS = new Set([
  "attentionItemId",
  "dedupeKey",
  "projectSlug",
  "taskId",
  "jobId",
  "sessionId",
  "sessionIds",
  "repoRoot",
  "sourceWorktreePath",
  "worktreePath",
  "targetPath",
  "path",
  "baseRef",
  "branch",
  "reason",
  "title",
  "idempotencyKey",
]);

const RAW_GIT_ARG_FIELDS = new Set(["args", "argv", "gitArgs"]);
const DEFAULT_WORKTREE_NAMING_PATTERN = "{projectSlug}/{taskId}-{shortTitle}";

export function registerWorktreeRoutes(app, deps = {}) {
  if (!app || typeof app.post !== "function") {
    throw new Error("registerWorktreeRoutes: express app required");
  }
  const { worktreeService, config = {} } = deps;
  if (!worktreeService || typeof worktreeService.create !== "function") {
    throw new Error("registerWorktreeRoutes: worktreeService (with create) required");
  }

  app.post("/api/worktrees/create-from-attention", async (req, res) => {
    if (!worktreeCreationAllowed(config)) {
      return sendError(
        res,
        403,
        "WORKTREE_CREATION_DISABLED",
        "trustedLocalMode.allowWorktreeCreationFromUI must be enabled",
      );
    }
    const body = parseBodyObject(req.body);
    if (body === null) {
      return sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    }
    const rawField = Object.keys(body).find((field) => RAW_GIT_ARG_FIELDS.has(field));
    if (rawField) {
      return sendError(res, 400, "RAW_GIT_ARGS_REFUSED", `${rawField} is not accepted`);
    }
    const unknown = rejectUnknownFields(body, CREATE_FROM_ATTENTION_ALLOWED_FIELDS);
    if (unknown.length > 0) {
      return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });
    }

    const projectSlug = nonEmptyString(body.projectSlug);
    if (!projectSlug) {
      return sendError(res, 400, "INVALID_BODY", "`projectSlug` is required");
    }

    const repoRoot = nonEmptyString(body.repoRoot) ||
      nonEmptyString(body.sourceWorktreePath) ||
      nonEmptyString(body.worktreePath);
    if (!repoRoot) {
      return sendError(res, 400, "INVALID_BODY", "`repoRoot` or `sourceWorktreePath` is required");
    }

    const targetPathResult = resolveTargetPath(body, repoRoot, config.worktrees || {});
    if (!targetPathResult.ok) {
      return sendError(res, 400, "INVALID_BODY", targetPathResult.message);
    }

    const sessionId = firstString(body.sessionId, ...(Array.isArray(body.sessionIds) ? body.sessionIds : []));
    const createResult = await worktreeService.create({
      projectSlug,
      repoRoot,
      path: targetPathResult.path,
      taskId: nonEmptyString(body.taskId) || undefined,
      jobId: nonEmptyString(body.jobId) || undefined,
      sessionId: sessionId || undefined,
      baseRef: nonEmptyString(body.baseRef) || nonEmptyString(body.branch) || undefined,
      reason: nonEmptyString(body.reason) || "operator requested worktree from attention action",
    });

    if (!createResult?.ok) {
      const error = createResult?.error || {};
      return sendError(
        res,
        createResult?.status || 500,
        error.code || "WORKTREE_CREATE_FAILED",
        error.message || "failed to create worktree",
        error,
      );
    }

    res.status(createResult.status || 201).json({
      ok: true,
      mode: "worktree_created_from_attention",
      defaultedPath: targetPathResult.defaulted,
      targetPath: targetPathResult.path,
      worktree: createResult.worktree,
    });
  });
}

function worktreeCreationAllowed(config) {
  return config?.trustedLocalMode?.allowWorktreeCreationFromUI === true;
}

function resolveTargetPath(body, repoRoot, worktreeConfig) {
  const explicit = nonEmptyString(body.targetPath) || nonEmptyString(body.path);
  if (explicit) {
    try {
      return { ok: true, defaulted: false, path: normalizeExplicitPath(explicit, repoRoot) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }
  const pattern = nonEmptyString(worktreeConfig.defaultNamingPattern) || DEFAULT_WORKTREE_NAMING_PATTERN;
  const safeRelative = safePatternPath(pattern, {
    projectSlug: body.projectSlug,
    taskId: nonEmptyString(body.taskId) || nonEmptyString(body.jobId) || firstString(body.sessionId, ...(Array.isArray(body.sessionIds) ? body.sessionIds : [])),
    title: body.title,
  });
  return {
    ok: true,
    defaulted: true,
    path: resolve(repoRoot, "..", ".worktrees", safeRelative),
  };
}

function normalizeExplicitPath(value, repoRoot) {
  if (value.includes("\0")) throw new Error("target path must not contain NUL bytes");
  if (value.startsWith("-")) throw new Error("target path must not start with '-'");
  if (isAbsolute(value)) return resolve(value);
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("relative target path must not contain '.' or '..' segments");
  }
  return resolve(repoRoot, "..", value);
}

function safePatternPath(pattern, values) {
  const replacements = {
    projectSlug: safeSlug(values.projectSlug, "project"),
    taskId: safeSlug(values.taskId, "task"),
    shortTitle: safeSlug(values.title, "worktree"),
  };
  const replaced = String(pattern || DEFAULT_WORKTREE_NAMING_PATTERN).replace(
    /\{(projectSlug|taskId|shortTitle)\}/g,
    (_match, key) => replacements[key],
  );
  const segments = replaced
    .split(/[\\/]+/)
    .map((segment) => safeSlug(segment, "worktree"))
    .filter(Boolean);
  return segments.length > 0 ? segments.join("/") : "project/worktree";
}

function safeSlug(value, fallback) {
  const base = nonEmptyString(value) || fallback;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function parseBodyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function rejectUnknownFields(body, allowed) {
  return Object.keys(body).filter((field) => !allowed.has(field));
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) || null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sendError(res, status, code, message, details) {
  return res.status(status).json({
    ok: false,
    error: {
      code,
      message,
      ...(details && typeof details === "object" ? { details } : {}),
    },
  });
}
