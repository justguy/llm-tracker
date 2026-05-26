import { spawn as nodeSpawn } from "node:child_process";
import { resolve } from "node:path";

export const DEFAULT_GIT_EVIDENCE_TIMEOUT_MS = 5000;
export const DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_GIT_LOG_MAX_COUNT = 50;
export const DEFAULT_GIT_LOG_SINCE = "24 hours ago";

export const GIT_EVIDENCE_COMMANDS = Object.freeze({
  status: Object.freeze(["status", "--short", "--branch"]),
  diffStat: Object.freeze(["diff", "--stat"]),
});

export async function collectGitEvidence(repoRootOrOptions, sinceArg = undefined, optionsArg = {}) {
  const options = normalizeCollectOptions(repoRootOrOptions, sinceArg, optionsArg);
  const repoRoot = requiredString(options.repoRoot, "collectGitEvidence: repoRoot is required");
  const runGit =
    typeof options.runGit === "function"
      ? options.runGit
      : createGitRunner({
          spawn: options.spawn,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        });
  const since = normalizeSince(options.since);
  const logMaxCount = normalizePositiveInteger(options.logMaxCount, DEFAULT_GIT_LOG_MAX_COUNT);
  const cwd = resolve(repoRoot);
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();

  const commands = {};
  commands.status = await runGitEvidenceCommand("status", GIT_EVIDENCE_COMMANDS.status, {
    cwd,
    runGit,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });

  if (commands.status.unavailable) {
    commands.diffStat = unavailableCommandResult("diffStat", GIT_EVIDENCE_COMMANDS.diffStat, cwd);
    commands.log = unavailableCommandResult("log", gitLogArgs(since, logMaxCount), cwd);
  } else {
    commands.diffStat = await runGitEvidenceCommand("diffStat", GIT_EVIDENCE_COMMANDS.diffStat, {
      cwd,
      runGit,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    commands.log = await runGitEvidenceCommand("log", gitLogArgs(since, logMaxCount), {
      cwd,
      runGit,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
  }

  const commandList = [commands.status, commands.diffStat, commands.log];
  const unavailable = commandList.some((command) => command.unavailable);
  return {
    ok: !unavailable && commandList.every((command) => command.ok),
    unavailable,
    reason: unavailable ? "git_unavailable" : null,
    repoRoot: cwd,
    since,
    collectedAt: now(),
    commands,
    status: commands.status,
    diffStat: commands.diffStat,
    log: commands.log,
  };
}

export const collect = collectGitEvidence;

export async function collectGitStatus(repoRootOrOptions, optionsArg = {}) {
  const options = normalizeCommandOptions(repoRootOrOptions, optionsArg);
  return runGitEvidenceCommand("status", GIT_EVIDENCE_COMMANDS.status, options);
}

export async function collectGitDiffStat(repoRootOrOptions, optionsArg = {}) {
  const options = normalizeCommandOptions(repoRootOrOptions, optionsArg);
  return runGitEvidenceCommand("diffStat", GIT_EVIDENCE_COMMANDS.diffStat, options);
}

export async function collectGitLogSince(repoRootOrOptions, sinceArg = undefined, optionsArg = {}) {
  const options = normalizeCollectOptions(repoRootOrOptions, sinceArg, optionsArg);
  const cwd = resolve(requiredString(options.repoRoot, "collectGitLogSince: repoRoot is required"));
  return runGitEvidenceCommand("log", gitLogArgs(normalizeSince(options.since), options.logMaxCount), {
    cwd,
    runGit:
      typeof options.runGit === "function"
        ? options.runGit
        : createGitRunner({
            spawn: options.spawn,
            timeoutMs: options.timeoutMs,
            maxOutputBytes: options.maxOutputBytes,
          }),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}

export function createGitRunner({
  spawn = nodeSpawn,
  timeoutMs = DEFAULT_GIT_EVIDENCE_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES,
} = {}) {
  if (typeof spawn !== "function") {
    throw new TypeError("createGitRunner: spawn function required");
  }
  return (args, options = {}) =>
    runGitWithSpawn(spawn, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? maxOutputBytes,
    });
}

export function gitLogArgs(since = DEFAULT_GIT_LOG_SINCE, maxCount = DEFAULT_GIT_LOG_MAX_COUNT) {
  return [
    "log",
    "--since",
    normalizeSince(since),
    "--oneline",
    "--decorate",
    "--max-count",
    String(normalizePositiveInteger(maxCount, DEFAULT_GIT_LOG_MAX_COUNT)),
  ];
}

export function isMissingGitError(value) {
  if (!value || typeof value !== "object") return false;
  const code = value.code || value.errorCode;
  if (code === "ENOENT") return true;
  const message = String(value.message || value.error || "");
  return /\bENOENT\b/.test(message) && /\bgit\b/i.test(message);
}

async function runGitEvidenceCommand(name, args, { cwd, runGit, timeoutMs, maxOutputBytes } = {}) {
  const resolvedCwd = resolve(requiredString(cwd, `runGitEvidenceCommand: cwd required for ${name}`));
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.length === 0)) {
    throw new TypeError("runGitEvidenceCommand: args must be a non-empty string array");
  }
  const runner =
    typeof runGit === "function"
      ? runGit
      : createGitRunner({ timeoutMs, maxOutputBytes });
  try {
    const result = await runner(args.slice(), {
      cwd: resolvedCwd,
      timeoutMs,
      maxOutputBytes,
    });
    return normalizeCommandResult(name, args, resolvedCwd, result);
  } catch (error) {
    return errorCommandResult(name, args, resolvedCwd, error);
  }
}

function runGitWithSpawn(spawn, args, { cwd, timeoutMs, maxOutputBytes } = {}) {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const limit = normalizePositiveInteger(maxOutputBytes, DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES);
    let stdout = limitedString(limit);
    let stderr = limitedString(limit);
    let child;
    let settled = false;
    let timedOut = false;
    let timer = null;
    let forceKillTimer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveResult({
        ...result,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    }

    try {
      child = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(errorResult(error, timedOut));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1000);
      forceKillTimer.unref?.();
      finish({ exitCode: null, timedOut: true });
    }, normalizePositiveInteger(timeoutMs, DEFAULT_GIT_EVIDENCE_TIMEOUT_MS));
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, limit);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, limit);
    });
    child.on("error", (error) => {
      finish(errorResult(error, timedOut));
    });
    child.on("close", (code, signal) => {
      finish({
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        timedOut,
      });
    });
  });
}

function normalizeCommandResult(name, args, cwd, result = {}) {
  const unavailable = isMissingGitError(result);
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  const timedOut = result.timedOut === true;
  const error = result.error ? String(result.error) : null;
  return {
    name,
    command: "git",
    args: args.slice(),
    cwd,
    ok: !unavailable && !timedOut && !error && exitCode === 0,
    unavailable,
    reason: unavailable ? "git_unavailable" : null,
    exitCode,
    signal: result.signal || null,
    timedOut,
    stdout: result.stdout === undefined || result.stdout === null ? "" : String(result.stdout),
    stderr: result.stderr === undefined || result.stderr === null ? "" : String(result.stderr),
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    error,
    errorCode: result.errorCode || result.code || null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
  };
}

function unavailableCommandResult(name, args, cwd) {
  return {
    name,
    command: "git",
    args: args.slice(),
    cwd,
    ok: false,
    unavailable: true,
    reason: "git_unavailable",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    error: "git unavailable",
    errorCode: "ENOENT",
    durationMs: null,
  };
}

function errorCommandResult(name, args, cwd, error) {
  return normalizeCommandResult(name, args, cwd, {
    exitCode: null,
    error: error?.message || String(error),
    errorCode: error?.code || null,
    code: error?.code || null,
  });
}

function errorResult(error, timedOut) {
  return {
    exitCode: null,
    timedOut,
    error: error?.message || String(error),
    errorCode: error?.code || null,
    code: error?.code || null,
  };
}

function limitedString(limit) {
  return { value: "", truncated: false, limit };
}

function appendLimited(current, chunk, limit) {
  const next = `${current.value}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
  if (next.length <= limit) return { value: next, truncated: current.truncated, limit };
  return { value: next.slice(0, limit), truncated: true, limit };
}

function normalizeCollectOptions(repoRootOrOptions, sinceArg, optionsArg) {
  if (repoRootOrOptions && typeof repoRootOrOptions === "object") {
    return {
      ...repoRootOrOptions,
      since: repoRootOrOptions.since ?? sinceArg,
    };
  }
  return {
    ...optionsArg,
    repoRoot: repoRootOrOptions,
    since: sinceArg,
  };
}

function normalizeCommandOptions(repoRootOrOptions, optionsArg) {
  const options =
    repoRootOrOptions && typeof repoRootOrOptions === "object"
      ? repoRootOrOptions
      : { ...optionsArg, repoRoot: repoRootOrOptions };
  const cwd = resolve(requiredString(options.repoRoot, "git evidence: repoRoot is required"));
  return {
    cwd,
    runGit: options.runGit,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  };
}

function normalizeSince(value) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_GIT_LOG_SINCE;
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function requiredString(value, message) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(message);
  return value;
}
