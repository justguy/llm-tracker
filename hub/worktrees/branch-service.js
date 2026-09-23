// hub/worktrees/branch-service.js - SH-7B-02
//
// BranchService keeps branch operations dependency-injected so callers and
// tests can exercise behavior without mutating a real repository.

import { resolve } from "node:path";

import {
  DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES,
  DEFAULT_GIT_EVIDENCE_TIMEOUT_MS,
  createGitRunner,
  isMissingGitError,
} from "../workspaces/git-evidence.js";

export const BRANCH_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "invalid_input",
  UNSAFE_REF: "unsafe_ref",
  FORCE_REFUSED: "force_refused",
  GIT_UNAVAILABLE: "git_unavailable",
  GIT_ERROR: "git_error",
});

export class BranchService {
  /**
   * @param {{
   *   runGit?: (args: string[], options?: object) => Promise<object>,
   *   spawn?: Function,
   *   timeoutMs?: number,
   *   maxOutputBytes?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_EVIDENCE_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES;
    this.runGit =
      typeof options.runGit === "function"
        ? options.runGit
        : createGitRunner({
            spawn: options.spawn,
            timeoutMs: this.timeoutMs,
            maxOutputBytes: this.maxOutputBytes,
          });
  }

  /**
   * Create a local branch from an optional base ref. This does not switch the
   * current worktree and never accepts force/reset flags.
   *
   * @param {object} input
   * @returns {Promise<{ok: true, status: 201, branch: string, baseRef: string|null, git: object} | object>}
   */
  async createBranch(input = {}) {
    const prepared = prepareBranchInput(input, "createBranch");
    if (!prepared.ok) return prepared;

    const args = ["branch", prepared.branch];
    if (prepared.baseRef) args.push(prepared.baseRef);
    const command = await this.#runGitCommand("createBranch", args, prepared.repoRoot);
    if (!command.ok) return commandError(command, "Failed to create branch");

    return ok(201, {
      branch: prepared.branch,
      baseRef: prepared.baseRef,
      git: command,
    });
  }

  /**
   * Switch an existing worktree to a local branch. Branch creation is kept as a
   * separate operation so callers cannot accidentally reset or force checkout.
   *
   * @param {object} input
   * @returns {Promise<{ok: true, status: 200, branch: string, git: object} | object>}
   */
  async switchBranch(input = {}) {
    const prepared = prepareBranchInput(input, "switchBranch");
    if (!prepared.ok) return prepared;

    const command = await this.#runGitCommand(
      "switchBranch",
      ["switch", prepared.branch],
      prepared.repoRoot,
    );
    if (!command.ok) return commandError(command, "Failed to switch branch");

    return ok(200, {
      branch: prepared.branch,
      git: command,
    });
  }

  /**
   * Fetch an upstream remote with conservative defaults: `origin`, no tags, no
   * force, and no raw caller-provided argv. Optional `prune` is explicit.
   *
   * @param {object} input
   * @returns {Promise<{ok: true, status: 200, remote: string, ref: string|null, git: object} | object>}
   */
  async fetchUpstream(input = {}) {
    const prepared = prepareFetchInput(input);
    if (!prepared.ok) return prepared;

    const args = ["fetch", "--no-tags"];
    if (prepared.prune) args.push("--prune");
    args.push(prepared.remote);
    if (prepared.ref) args.push(prepared.ref);

    const command = await this.#runGitCommand("fetchUpstream", args, prepared.repoRoot);
    if (!command.ok) return commandError(command, "Failed to fetch upstream");

    return ok(200, {
      remote: prepared.remote,
      ref: prepared.ref,
      git: command,
    });
  }

  async #runGitCommand(name, args, cwd) {
    const resolvedCwd = resolve(requiredString(cwd, `${name}: repoRoot is required`));
    try {
      const result = await this.runGit(args.slice(), {
        cwd: resolvedCwd,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
      return normalizeCommandResult(name, args, resolvedCwd, result);
    } catch (error) {
      return errorCommandResult(name, args, resolvedCwd, error);
    }
  }
}

export function createBranchService(options = {}) {
  return new BranchService(options);
}

export async function createBranch(input = {}, options = {}) {
  return createBranchService(options).createBranch(input);
}

export async function switchBranch(input = {}, options = {}) {
  return createBranchService(options).switchBranch(input);
}

export async function fetchUpstream(input = {}, options = {}) {
  return createBranchService(options).fetchUpstream(input);
}

function prepareBranchInput(input, operation) {
  if (!isPlainObject(input)) {
    return err(400, BRANCH_ERROR_CODES.INVALID_INPUT, `${operation} input must be an object`);
  }
  const forceRefusal = rejectForceInput(input);
  if (forceRefusal) return forceRefusal;
  if (hasRawArgs(input)) {
    return err(400, BRANCH_ERROR_CODES.INVALID_INPUT, `${operation} does not accept raw git args`);
  }

  try {
    return {
      ok: true,
      repoRoot: safePath(input.repoRoot ?? input.worktreePath, `${operation}.repoRoot`),
      branch: safeBranchName(input.branch ?? input.branchName, `${operation}.branch`),
      baseRef:
        input.baseRef === undefined && input.startPoint === undefined
          ? null
          : safeRef(input.baseRef ?? input.startPoint, `${operation}.baseRef`),
    };
  } catch (error) {
    return err(400, BRANCH_ERROR_CODES.UNSAFE_REF, error.message);
  }
}

function prepareFetchInput(input) {
  if (!isPlainObject(input)) {
    return err(400, BRANCH_ERROR_CODES.INVALID_INPUT, "fetchUpstream input must be an object");
  }
  const forceRefusal = rejectForceInput(input);
  if (forceRefusal) return forceRefusal;
  if (hasRawArgs(input)) {
    return err(400, BRANCH_ERROR_CODES.INVALID_INPUT, "fetchUpstream does not accept raw git args");
  }

  try {
    return {
      ok: true,
      repoRoot: safePath(input.repoRoot ?? input.worktreePath, "fetchUpstream.repoRoot"),
      remote: safeRemote(input.remote ?? input.upstream ?? "origin", "fetchUpstream.remote"),
      ref:
        input.ref === undefined && input.branch === undefined
          ? null
          : safeRef(input.ref ?? input.branch, "fetchUpstream.ref"),
      prune: input.prune === true,
    };
  } catch (error) {
    return err(400, BRANCH_ERROR_CODES.UNSAFE_REF, error.message);
  }
}

function rejectForceInput(input) {
  for (const key of ["force", "forcePush", "forceWithLease", "forceCheckout", "reset"]) {
    if (input[key] === true) {
      return err(
        400,
        BRANCH_ERROR_CODES.FORCE_REFUSED,
        "force branch operations are not supported",
      );
    }
  }
  return null;
}

function hasRawArgs(input) {
  return input.args !== undefined || input.argv !== undefined || input.gitArgs !== undefined;
}

function safeBranchName(value, field) {
  const branch = safeRef(value, field);
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) {
    throw new TypeError(`${field} has an invalid branch boundary`);
  }
  if (branch.endsWith(".lock")) {
    throw new TypeError(`${field} must not end with .lock`);
  }
  return branch;
}

function safeRemote(value, field) {
  const remote = safeRef(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) {
    throw new TypeError(`${field} contains unsupported characters`);
  }
  return remote;
}

function safeRef(value, field) {
  const ref = requiredString(value, `${field} is required`);
  if (ref.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
  if (ref.startsWith("-")) throw new TypeError(`${field} must not start with '-'`);
  if (ref === "@") throw new TypeError(`${field} must not be '@'`);
  if (ref.includes("..")) throw new TypeError(`${field} must not contain '..'`);
  if (ref.includes("//")) throw new TypeError(`${field} must not contain '//'`);
  if (ref.includes("@{")) throw new TypeError(`${field} must not contain '@{'`);
  if (/[\\\s~^:?*[`\x00-\x1f\x7f]/.test(ref)) {
    throw new TypeError(`${field} contains unsupported characters`);
  }
  return ref;
}

function safePath(value, field) {
  const path = requiredString(value, `${field} is required`);
  if (path.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
  if (path.startsWith("-")) throw new TypeError(`${field} must not start with '-'`);
  return path;
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
    reason: unavailable ? BRANCH_ERROR_CODES.GIT_UNAVAILABLE : null,
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

function errorCommandResult(name, args, cwd, error) {
  const unavailable = isMissingGitError(error);
  return {
    name,
    command: "git",
    args: args.slice(),
    cwd,
    ok: false,
    unavailable,
    reason: unavailable ? BRANCH_ERROR_CODES.GIT_UNAVAILABLE : BRANCH_ERROR_CODES.GIT_ERROR,
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

function commandError(command, fallbackMessage) {
  const code = command.unavailable
    ? BRANCH_ERROR_CODES.GIT_UNAVAILABLE
    : BRANCH_ERROR_CODES.GIT_ERROR;
  return err(command.unavailable ? 503 : 400, code, command.error || command.stderr || fallbackMessage, {
    git: command,
  });
}

function ok(status, body) {
  return { ok: true, status, ...body };
}

function err(status, code, message, extra = {}) {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      ...extra,
    },
  };
}

function requiredString(value, message) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(message);
  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
