import { spawn } from "node:child_process";
import path from "node:path";

import { isJobId } from "../runtime/ids.js";
import { TERMINAL_JOB_STATUS } from "../jobs/registry.js";

const COMMAND_RUN_ALLOWED_FIELDS = new Set(["source", "idempotencyKey"]);
const RESOLVE_ALLOWED_FIELDS = new Set([
  "status",
  "approved",
  "satisfied",
  "reason",
  "summary",
  "user",
  "source",
  "idempotencyKey",
]);
const VERIFY_EVENT_SOURCES = new Set(["http", "mcp", "ui", "system"]);
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_OUTPUT_PREVIEW_BYTES = 4096;

export function registerVerifyPackRoutes(app, deps) {
  const { jobRegistry, runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace } = deps || {};
  const runVerifyCommand =
    typeof deps?.runVerifyCommand === "function" ? deps.runVerifyCommand : defaultRunVerifyCommand;
  const mutationMiddleware = Array.isArray(deps?.mutationMiddleware) ? deps.mutationMiddleware : [];

  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new Error("registerVerifyPackRoutes: express app required");
  }
  if (!jobRegistry || typeof jobRegistry.get !== "function") {
    throw new Error("registerVerifyPackRoutes: jobRegistry (with get) required");
  }

  app.get("/api/jobs/:jobId/verify-pack", (req, res) => {
    const prepared = prepareVerifyPackRequest({ req, res, jobRegistry, requireActiveJob: false });
    if (!prepared) return;
    return res.status(200).json({
      jobId: prepared.job.id,
      verifyPack: prepared.job.verifyPack || null,
      items: enrichVerifyItems(prepared.job),
    });
  });

  app.post("/api/jobs/:jobId/verify-pack/items/:itemId/run", ...mutationMiddleware, async (req, res) => {
    const prepared = prepareVerifyPackRequest({ req, res, jobRegistry, requireActiveJob: true });
    if (!prepared) return;
    if (!assertRuntimeDeps(res, { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace })) return;

    const body = requireObjectBody(req, res);
    if (body === undefined) return;
    const unknown = rejectUnknownFields(body, COMMAND_RUN_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    const item = findVerifyItem(prepared.job, req.params.itemId);
    if (!item) return sendError(res, 404, "VERIFY_ITEM_NOT_FOUND", `verify item not found: ${req.params.itemId}`);
    if (item.kind !== "command") {
      return sendError(res, 409, "VERIFY_ITEM_NOT_RUNNABLE", `verify item '${item.id}' is not a command`);
    }

    const command = typeof item.cmd === "string" ? item.cmd : "";
    if (command.length === 0) {
      return sendError(res, 400, "INVALID_VERIFY_ITEM", "command verify item requires non-empty cmd");
    }
    const timeoutSec = normalizeTimeoutSec(item.timeoutSec);
    const expectExit = Number.isInteger(item.expectExit) ? item.expectExit : 0;
    const cwdOrErr = resolveCommandCwd(item.cwd, workspace);
    if (cwdOrErr.error) return sendError(res, 400, "INVALID_VERIFY_ITEM", cwdOrErr.error);
    const source = resolveSource(body.source);
    if (source.error) return sendError(res, 400, "INVALID_BODY", source.error);

    const started = await appendRuntimeEvent(res, {
      runtimeStore,
      validateRuntimeEvent,
      event: {
        schemaVersion: 1,
        id: makeRuntimeId("evt"),
        ts: new Date().toISOString(),
        type: "verify.command.started",
        source: source.value,
        workspace,
        jobId: prepared.job.id,
        sessionId: prepared.job.sessionId,
        itemId: item.id,
        command,
        cwd: cwdOrErr.cwd,
        timeoutSec,
        expectExit,
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
      },
    });
    if (!started) return;

    const startedAt = Date.now();
    let runResult;
    try {
      runResult = await runVerifyCommand({
        command,
        cwd: cwdOrErr.cwd,
        timeoutMs: timeoutSec * 1000,
        item,
        job: prepared.job,
      });
    } catch (err) {
      runResult = {
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: err?.message || "verify command failed",
      };
    }
    const durationMs =
      Number.isFinite(runResult?.durationMs) && runResult.durationMs >= 0
        ? Math.floor(runResult.durationMs)
        : Date.now() - startedAt;
    const exitCode = Number.isInteger(runResult?.exitCode) ? runResult.exitCode : null;
    const timedOut = runResult?.timedOut === true;
    const passed = !timedOut && exitCode === expectExit;
    const completed = await appendRuntimeEvent(res, {
      runtimeStore,
      validateRuntimeEvent,
      event: {
        schemaVersion: 1,
        id: makeRuntimeId("evt"),
        ts: new Date().toISOString(),
        type: "verify.command.completed",
        source: source.value,
        workspace,
        jobId: prepared.job.id,
        sessionId: prepared.job.sessionId,
        itemId: item.id,
        command,
        status: passed ? "succeeded" : "failed",
        exitCode,
        expectExit,
        timedOut,
        durationMs,
        stdoutPreview: preview(runResult?.stdout),
        stderrPreview: preview(runResult?.stderr),
        ...(runResult?.error ? { error: String(runResult.error) } : {}),
      },
    });
    if (!completed) return;

    return res.status(200).json({
      ok: passed,
      mode: "command_completed",
      jobId: prepared.job.id,
      itemId: item.id,
      status: passed ? "succeeded" : "failed",
      exitCode,
      expectExit,
      timedOut,
      durationMs,
      startedEventId: started.eventId,
      completedEventId: completed.eventId,
      job: jobRegistry.get(prepared.job.id),
    });
  });

  app.post("/api/jobs/:jobId/verify-pack/items/:itemId/resolve", ...mutationMiddleware, async (req, res) => {
    const prepared = prepareVerifyPackRequest({ req, res, jobRegistry, requireActiveJob: true });
    if (!prepared) return;
    if (!assertRuntimeDeps(res, { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace })) return;

    const body = requireObjectBody(req, res);
    if (body === undefined) return;
    const unknown = rejectUnknownFields(body, RESOLVE_ALLOWED_FIELDS);
    if (unknown) return sendError(res, 400, "UNKNOWN_FIELDS", `unknown body field(s): ${unknown.join(", ")}`, { unknown });

    const item = findVerifyItem(prepared.job, req.params.itemId);
    if (!item) return sendError(res, 404, "VERIFY_ITEM_NOT_FOUND", `verify item not found: ${req.params.itemId}`);
    if (item.kind !== "human_approval" && item.kind !== "dod_check") {
      return sendError(res, 409, "VERIFY_ITEM_NOT_RESOLVABLE", `verify item '${item.id}' is not resolvable`);
    }
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`reason` must be a non-empty string when present");
    }
    if (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`summary` must be a non-empty string when present");
    }
    if (body.user !== undefined && (typeof body.user !== "string" || body.user.length === 0)) {
      return sendError(res, 400, "INVALID_BODY", "`user` must be a non-empty string when present");
    }
    const resolvedStatus = resolveVerifyStatus(item.kind, body);
    if (resolvedStatus.error) return sendError(res, 400, "INVALID_BODY", resolvedStatus.error);
    const source = resolveSource(body.source);
    if (source.error) return sendError(res, 400, "INVALID_BODY", source.error);

    const result = await appendRuntimeEvent(res, {
      runtimeStore,
      validateRuntimeEvent,
      event: {
        schemaVersion: 1,
        id: makeRuntimeId("evt"),
        ts: new Date().toISOString(),
        type: "verify.human_approval.resolved",
        source: source.value,
        workspace,
        jobId: prepared.job.id,
        sessionId: prepared.job.sessionId,
        itemId: item.id,
        itemKind: item.kind,
        status: resolvedStatus.value,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        ...(body.user !== undefined ? { user: body.user } : {}),
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
      },
    });
    if (!result) return;

    return res.status(200).json({
      ok: resolvedStatus.value === "satisfied",
      mode: "verify_item_resolved",
      jobId: prepared.job.id,
      itemId: item.id,
      itemKind: item.kind,
      status: resolvedStatus.value,
      eventId: result.eventId,
      rev: result.rev,
      job: jobRegistry.get(prepared.job.id),
    });
  });
}

function prepareVerifyPackRequest({ req, res, jobRegistry, requireActiveJob }) {
  const { jobId } = req.params;
  if (!isJobId(jobId)) {
    sendError(res, 400, "INVALID_JOB_ID", `not a valid job_ id: ${jobId}`);
    return null;
  }
  const job = jobRegistry.get(jobId);
  if (!job) {
    sendError(res, 404, "JOB_NOT_FOUND", `job not found: ${jobId}`);
    return null;
  }
  if (requireActiveJob && TERMINAL_JOB_STATUS.includes(job.status)) {
    sendError(res, 409, "JOB_TERMINAL", `job '${jobId}' is terminal (${job.status})`, {
      jobId,
      status: job.status,
    });
    return null;
  }
  if (!job.verifyPack || !Array.isArray(job.verifyPack.items)) {
    sendError(res, 404, "VERIFY_PACK_NOT_FOUND", `job ${jobId} has no verify pack`);
    return null;
  }
  return { job };
}

function enrichVerifyItems(job) {
  const gatesById = new Map();
  if (Array.isArray(job.completionGates)) {
    for (const gate of job.completionGates) {
      if (typeof gate?.id === "string") gatesById.set(gate.id, gate);
    }
  }
  return job.verifyPack.items.map((item) => ({
    ...item,
    ...(gatesById.has(item.id) ? { gate: gatesById.get(item.id) } : {}),
  }));
}

function findVerifyItem(job, itemId) {
  if (typeof itemId !== "string" || itemId.length === 0) return null;
  return job.verifyPack.items.find((item) => item?.id === itemId) || null;
}

function normalizeTimeoutSec(value) {
  if (Number.isInteger(value) && value >= 1 && value <= 3600) return value;
  return DEFAULT_TIMEOUT_SEC;
}

function resolveCommandCwd(cwd, workspace) {
  if (cwd === undefined || cwd === null || cwd === "") return { cwd: workspace };
  if (typeof cwd !== "string") return { error: "command cwd must be a string when present" };
  if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) {
    return { error: "command cwd must be workspace-relative and must not contain '..'" };
  }
  return { cwd: path.resolve(workspace, cwd) };
}

function resolveSource(value) {
  if (value === undefined || value === null || value === "") return { value: "http" };
  if (typeof value !== "string" || !VERIFY_EVENT_SOURCES.has(value)) {
    return { error: `source must be one of: ${[...VERIFY_EVENT_SOURCES].join(", ")}` };
  }
  return { value };
}

function resolveVerifyStatus(itemKind, body) {
  if (body.status !== undefined) {
    if (body.status === "satisfied" || body.status === "failed") return { value: body.status };
    return { error: "`status` must be 'satisfied' or 'failed' when present" };
  }
  if (itemKind === "human_approval" && body.approved !== undefined) {
    if (typeof body.approved !== "boolean") return { error: "`approved` must be boolean when present" };
    return { value: body.approved ? "satisfied" : "failed" };
  }
  if (itemKind === "dod_check" && body.satisfied !== undefined) {
    if (typeof body.satisfied !== "boolean") return { error: "`satisfied` must be boolean when present" };
    return { value: body.satisfied ? "satisfied" : "failed" };
  }
  return {
    error:
      itemKind === "human_approval"
        ? "human_approval resolve requires `approved` or `status`"
        : "dod_check resolve requires `satisfied` or `status`",
  };
}

function requireObjectBody(req, res) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "INVALID_BODY", "request body must be a JSON object");
    return undefined;
  }
  return body;
}

function rejectUnknownFields(body, allowed) {
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) unknown.push(key);
  }
  return unknown.length > 0 ? unknown : null;
}

function assertRuntimeDeps(res, deps) {
  const { runtimeStore, makeRuntimeId, validateRuntimeEvent, workspace } = deps || {};
  if (
    !runtimeStore ||
    typeof runtimeStore.append !== "function" ||
    typeof makeRuntimeId !== "function" ||
    typeof validateRuntimeEvent !== "function" ||
    typeof workspace !== "string" ||
    workspace.length === 0
  ) {
    sendError(
      res,
      501,
      "NOT_IMPLEMENTED",
      "verify-pack endpoints require runtimeStore, makeRuntimeId, validateRuntimeEvent, and workspace wiring.",
    );
    return false;
  }
  return true;
}

async function appendRuntimeEvent(res, { event, runtimeStore, validateRuntimeEvent }) {
  try {
    validateRuntimeEvent(event);
  } catch (err) {
    sendError(res, 400, "INVALID_BODY", err.message || "event failed schema validation", {
      errors: err.errors,
    });
    return null;
  }
  const { id: _placeholderEventId, ...eventForAppend } = event;
  try {
    return await runtimeStore.append(eventForAppend);
  } catch (err) {
    sendError(res, 500, "APPEND_FAILED", err.message || "runtime store append failed");
    return null;
  }
}

function defaultRunVerifyCommand({ command, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stderr = appendPreview(stderr, "\nverify command timed out");
      try {
        child.kill("SIGTERM");
      } catch {}
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1000);
      forceKillTimer.unref?.();
      finish({
        exitCode: null,
        timedOut: true,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendPreview(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendPreview(stderr, chunk);
    });
    child.on("error", (err) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      clearTimeout(timer);
      finish({
        exitCode: null,
        timedOut,
        stdout,
        stderr,
        error: err.message,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      clearTimeout(timer);
      finish({
        exitCode: Number.isInteger(code) ? code : null,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function appendPreview(current, chunk) {
  return preview(`${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`);
}

function preview(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return text.length > MAX_OUTPUT_PREVIEW_BYTES ? text.slice(0, MAX_OUTPUT_PREVIEW_BYTES) : text;
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
