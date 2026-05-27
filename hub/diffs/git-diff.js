// hub/diffs/git-diff.js - SH-7A-02
//
// Safe git helpers for DiffReview base/head computation. These functions only
// compute on-demand evidence; callers decide whether and how to render it.

import { resolve } from "node:path";

import {
  DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES,
  DEFAULT_GIT_EVIDENCE_TIMEOUT_MS,
  createGitRunner,
  isMissingGitError,
} from "../workspaces/git-evidence.js";

export const DEFAULT_GIT_DIFF_MAX_OUTPUT_BYTES = DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES;
export const DEFAULT_GIT_DIFF_TIMEOUT_MS = DEFAULT_GIT_EVIDENCE_TIMEOUT_MS;

export const GIT_DIFF_COMMANDS = Object.freeze({
  status: Object.freeze(["status", "--short", "--branch"]),
  headSha: Object.freeze(["rev-parse", "HEAD"]),
  baseShaBefore: Object.freeze(["rev-list", "-n", "1", "--before"]),
  diffStat: Object.freeze(["diff", "--stat"]),
  nameStatus: Object.freeze(["diff", "--name-status", "--find-renames"]),
  numStat: Object.freeze(["diff", "--numstat"]),
});

/**
 * @typedef {object} GitBaseHead
 * @property {number|null} baseRev
 * @property {string|null} baseGitSha
 * @property {string|null} headGitSha
 * @property {boolean} unavailable
 * @property {string|null} reason
 * @property {object} commands
 */

export async function computeGitBaseHead(input = {}) {
  const repoRoot = resolve(requiredString(resolveRepoRoot(input), "computeGitBaseHead: repoRoot is required"));
  const runGit = gitRunner(input);
  const baseRev = integerOrNull(input.baseRev, input.job?.startRev);
  const commands = {};

  const explicitBaseGitSha = firstString(
    input.baseGitSha,
    input.job?.baseGitSha,
    input.job?.startGitSha,
    input.job?.gitShaAtStart,
    input.job?.context?.baseGitSha,
    input.job?.context?.startGitSha,
  );
  let baseGitSha = explicitBaseGitSha;

  if (!baseGitSha && firstString(input.startedAt, input.job?.startedAt, input.job?.createdAt)) {
    const startedAt = firstString(input.startedAt, input.job?.startedAt, input.job?.createdAt);
    commands.baseSha = await runGitCommand("baseSha", ["rev-list", "-n", "1", "--before", startedAt, "HEAD"], {
      cwd: repoRoot,
      runGit,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
    });
    if (commands.baseSha.ok) baseGitSha = cleanSha(commands.baseSha.stdout);
  }

  commands.headSha = await runGitCommand("headSha", GIT_DIFF_COMMANDS.headSha, {
    cwd: repoRoot,
    runGit,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
  });
  const headGitSha = commands.headSha.ok ? cleanSha(commands.headSha.stdout) : null;
  const unavailable = Object.values(commands).some((command) => command.unavailable);

  return {
    baseRev,
    baseGitSha: baseGitSha || null,
    headGitSha,
    unavailable,
    reason: unavailable ? "git_unavailable" : null,
    repoRoot,
    commands,
  };
}

export async function collectGitDiff(input = {}) {
  const repoRoot = resolve(requiredString(resolveRepoRoot(input), "collectGitDiff: repoRoot is required"));
  const runGit = gitRunner(input);
  const baseHead = input.baseHead || (await computeGitBaseHead({ ...input, repoRoot, runGit }));
  const baseRef = validateRef(firstString(input.baseRef, input.baseGitSha, baseHead.baseGitSha), "baseRef");
  const headRef = validateRef(firstString(input.headRef, input.headGitSha, baseHead.headGitSha, "HEAD"), "headRef");
  const paths = normalizePaths(input.paths);
  const range = diffRange(baseRef, headRef);
  const commands = { ...(baseHead.commands || {}) };
  commands.status = await runGitCommand("status", GIT_DIFF_COMMANDS.status, {
    cwd: repoRoot,
    runGit,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
  });

  if (baseHead.unavailable || !baseRef) {
    const reason = baseHead.unavailable ? "git_unavailable" : "base_git_sha_missing";
    commands.diffStat = unavailableCommandResult("diffStat", diffArgs(GIT_DIFF_COMMANDS.diffStat, range, paths), repoRoot);
    commands.nameStatus = unavailableCommandResult("nameStatus", diffArgs(GIT_DIFF_COMMANDS.nameStatus, range, paths), repoRoot);
    commands.numStat = unavailableCommandResult("numStat", diffArgs(GIT_DIFF_COMMANDS.numStat, range, paths), repoRoot);
    commands.diffStat.reason = reason;
    commands.nameStatus.reason = reason;
    commands.numStat.reason = reason;
  } else if (range === null) {
    commands.diffStat = emptyCommandResult("diffStat", diffArgs(GIT_DIFF_COMMANDS.diffStat, range, paths), repoRoot);
    commands.nameStatus = emptyCommandResult("nameStatus", diffArgs(GIT_DIFF_COMMANDS.nameStatus, range, paths), repoRoot);
    commands.numStat = emptyCommandResult("numStat", diffArgs(GIT_DIFF_COMMANDS.numStat, range, paths), repoRoot);
  } else {
    commands.diffStat = await runGitCommand("diffStat", diffArgs(GIT_DIFF_COMMANDS.diffStat, range, paths), {
      cwd: repoRoot,
      runGit,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
    });
    commands.nameStatus = await runGitCommand("nameStatus", diffArgs(GIT_DIFF_COMMANDS.nameStatus, range, paths), {
      cwd: repoRoot,
      runGit,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
    });
    commands.numStat = await runGitCommand("numStat", diffArgs(GIT_DIFF_COMMANDS.numStat, range, paths), {
      cwd: repoRoot,
      runGit,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
    });
    if (input.includePatch === true) {
      commands.patch = await runGitCommand("patch", diffArgs(["diff"], range, paths), {
        cwd: repoRoot,
        runGit,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
      });
    }
  }

  const commandList = Object.values(commands);
  const unavailable = commandList.some((command) => command.unavailable);
  const partialReason = !baseRef ? "base_git_sha_missing" : null;
  return {
    ok: !unavailable && !partialReason && commandList.every((command) => command.ok),
    unavailable: unavailable || !!partialReason,
    reason: partialReason || (unavailable ? "git_unavailable" : null),
    repoRoot,
    collectedAt: typeof input.now === "function" ? input.now() : new Date().toISOString(),
    baseRev: baseHead.baseRev,
    baseRef,
    headRef,
    baseGitSha: baseHead.baseGitSha || baseRef,
    headGitSha: baseHead.headGitSha || (headRef === "HEAD" ? null : headRef),
    paths,
    range,
    commands,
    files: mergeFileRows(commands.nameStatus?.stdout, commands.numStat?.stdout),
    diffStat: commands.diffStat,
    nameStatus: commands.nameStatus,
  };
}

function diffArgs(baseArgs, range, paths = []) {
  const args = baseArgs.slice();
  if (range) args.push(range);
  if (paths.length) args.push("--", ...paths);
  return args;
}

function diffRange(baseGitSha, headGitSha) {
  if (baseGitSha && headGitSha && baseGitSha !== headGitSha) {
    return `${baseGitSha}..${headGitSha}`;
  }
  if (baseGitSha && !headGitSha) return baseGitSha;
  return null;
}

function mergeFileRows(nameStatusText = "", numStatText = "") {
  const byPath = new Map();
  for (const row of parseNameStatus(nameStatusText)) {
    byPath.set(row.path, row);
  }
  for (const row of parseNumStat(numStatText)) {
    byPath.set(row.path, { ...(byPath.get(row.path) || { path: row.path }), ...row });
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function parseNameStatus(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] || "";
    const path = parts.length > 2 ? parts[2] : parts[1];
    if (path) rows.push({ path, status });
  }
  return rows;
}

function parseNumStat(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [additionsRaw, deletionsRaw, path] = line.split("\t");
    if (!path) continue;
    rows.push({
      path,
      additions: additionsRaw === "-" ? null : Number.parseInt(additionsRaw, 10),
      deletions: deletionsRaw === "-" ? null : Number.parseInt(deletionsRaw, 10),
    });
  }
  return rows;
}

async function runGitCommand(name, args, { cwd, runGit, timeoutMs, maxOutputBytes } = {}) {
  const resolvedCwd = resolve(requiredString(cwd, `runGitCommand: cwd required for ${name}`));
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.length === 0)) {
    throw new TypeError("runGitCommand: args must be a non-empty string array");
  }
  try {
    const result = await runGit(args.slice(), {
      cwd: resolvedCwd,
      timeoutMs,
      maxOutputBytes,
    });
    return normalizeCommandResult(name, args, resolvedCwd, result);
  } catch (error) {
    return errorCommandResult(name, args, resolvedCwd, error);
  }
}

function gitRunner(input) {
  if (typeof input.runGit === "function") return input.runGit;
  return createGitRunner({
    spawn: input.spawn,
    timeoutMs: input.timeoutMs ?? DEFAULT_GIT_DIFF_TIMEOUT_MS,
    maxOutputBytes: input.maxOutputBytes ?? DEFAULT_GIT_DIFF_MAX_OUTPUT_BYTES,
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
    error: null,
    errorCode: "ENOENT",
    durationMs: null,
  };
}

function emptyCommandResult(name, args, cwd) {
  return {
    name,
    command: "git",
    args: args.slice(),
    cwd,
    ok: true,
    unavailable: false,
    reason: null,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    error: null,
    errorCode: null,
    durationMs: null,
  };
}

function errorCommandResult(name, args, cwd, error) {
  const unavailable = isMissingGitError(error);
  return {
    name,
    command: "git",
    args: args.slice(),
    cwd,
    ok: false,
    unavailable,
    reason: unavailable ? "git_unavailable" : "git_error",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    error: error?.message ? String(error.message) : String(error),
    errorCode: error?.code || null,
    durationMs: null,
  };
}

function resolveRepoRoot(input) {
  return firstString(
    input.repoRoot,
    input.worktreePath,
    input.cwd,
    input.session?.worktreePath,
    input.session?.repoRoot,
    input.session?.cwd,
    input.job?.worktreePath,
    input.job?.repoRoot,
    input.job?.cwd,
  );
}

function cleanSha(value) {
  const sha = String(value || "").trim().split(/\s+/)[0] || "";
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

function validateRef(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string when present`);
  }
  if (value.startsWith("-") || value.includes("\0") || /\s/.test(value)) {
    throw new Error(`${field} is not a safe git ref`);
  }
  return value;
}

function normalizePaths(paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new Error("paths must be an array when present");
  return paths.map((path) => {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("paths entries must be non-empty strings");
    }
    if (path.includes("\0")) {
      throw new Error("paths entries must not contain NUL bytes");
    }
    return path;
  });
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function integerOrNull(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) return value;
  }
  return null;
}

function requiredString(value, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}
