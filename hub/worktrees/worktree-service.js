// hub/worktrees/worktree-service.js - SH-7B-01
//
// WorktreeService owns first-class worktree lifecycle metadata. This skeleton
// intentionally routes all git/fs effects through injected dependencies so
// unit tests can exercise behavior without touching real repositories.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  DEFAULT_GIT_EVIDENCE_MAX_OUTPUT_BYTES,
  DEFAULT_GIT_EVIDENCE_TIMEOUT_MS,
  createGitRunner,
  isMissingGitError,
} from "../workspaces/git-evidence.js";

export const WORKTREE_STATUSES = Object.freeze(["active", "archived"]);
export const WORKTREE_ARCHIVE_CONFIRMATION = "archive_worktree";
export const WORKTREE_DELETE_CONFIRMATION = "delete_worktree";

export const WORKTREE_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "invalid_input",
  NOT_FOUND: "worktree_not_found",
  GIT_UNAVAILABLE: "git_unavailable",
  GIT_ERROR: "git_error",
  ARCHIVE_CONFIRMATION_REQUIRED: "archive_confirmation_required",
  ARCHIVE_REASON_REQUIRED: "archive_reason_required",
  DESTRUCTIVE_ARCHIVE_REFUSED: "destructive_archive_refused",
  DELETE_CONFIRMATION_REQUIRED: "delete_confirmation_required",
  DELETE_UNCOMMITTED_CHANGES_REFUSED: "delete_uncommitted_changes_refused",
  DELETE_IN_FLIGHT_COMMITS_REFUSED: "delete_in_flight_commits_refused",
});

/**
 * @typedef {object} WorktreeRecord
 * @property {string} id
 * @property {string} projectSlug
 * @property {string} repoRoot
 * @property {string} path
 * @property {string|null} taskId
 * @property {string|null} jobId
 * @property {string|null} sessionId
 * @property {string|null} branch
 * @property {string|null} baseRef
 * @property {"active"|"archived"} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string|null} archivedAt
 * @property {string|null} archiveReason
 * @property {boolean} deletedFromDisk
 * @property {string|null} deletedAt
 * @property {Array<object>} bindings
 * @property {Array<object>} commands
 */

export class WorktreeService {
  /**
   * @param {{
   *   records?: WorktreeRecord[],
   *   now?: () => string,
   *   makeId?: () => string,
   *   runGit?: (args: string[], options?: object) => Promise<object>,
   *   spawn?: Function,
   *   fs?: object,
   *   timeoutMs?: number,
   *   maxOutputBytes?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
    this.makeId = typeof options.makeId === "function" ? options.makeId : makeWorktreeId;
    this.fs = options.fs || null;
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
    this.records = new Map();
    for (const record of arrayOrEmpty(options.records)) {
      const normalized = normalizeWorktreeRecord(record);
      this.records.set(normalized.id, normalized);
    }
  }

  /**
   * Create a git worktree and record lifecycle metadata.
   *
   * @param {object} input
   * @returns {Promise<{ok: true, status: 201, worktree: WorktreeRecord} | object>}
   */
  async create(input = {}) {
    const prepared = prepareCreateInput(input, { now: this.now, makeId: this.makeId });
    if (!prepared.ok) return prepared;

    const record = prepared.record;
    const args = ["worktree", "add", record.path];
    if (record.baseRef) args.push(record.baseRef);
    const command = await this.#runGitCommand("create", args, record.repoRoot);
    if (!command.ok) {
      return commandError(command, "Failed to create worktree");
    }

    const next = freezeRecord({
      ...record,
      commands: [command],
    });
    this.records.set(next.id, next);
    return ok(201, { worktree: cloneRecord(next) });
  }

  /**
   * Bind an existing worktree record to a session/job/task.
   *
   * @param {object} input
   * @returns {{ok: true, status: 200, worktree: WorktreeRecord} | object}
   */
  bind(input = {}) {
    const prepared = prepareBindInput(input, this.records);
    if (!prepared.ok) return prepared;

    const { record, binding } = prepared;
    const ts = this.now();
    const next = freezeRecord({
      ...record,
      projectSlug: binding.projectSlug || record.projectSlug,
      taskId: binding.taskId ?? record.taskId,
      jobId: binding.jobId ?? record.jobId,
      sessionId: binding.sessionId ?? record.sessionId,
      status: "active",
      updatedAt: ts,
      archivedAt: null,
      archiveReason: null,
      bindings: appendBinding(record.bindings, { ...binding, boundAt: ts }),
    });
    this.records.set(next.id, next);
    return ok(200, { worktree: cloneRecord(next) });
  }

  /**
   * List service records, optionally including parsed `git worktree list`
   * output. Git discovery is read-only and still uses the injected runner.
   *
   * @param {object} [filter]
   * @returns {Promise<{ok: true, status: 200, worktrees: WorktreeRecord[], gitWorktrees?: object[]}>}
   */
  async list(filter = {}) {
    const records = Array.from(this.records.values())
      .filter((record) => matchesFilter(record, filter))
      .map(cloneRecord);

    if (filter.includeGit === true) {
      const repoRoot = firstString(filter.repoRoot, records[0]?.repoRoot);
      if (!repoRoot) return ok(200, { worktrees: records, gitWorktrees: [] });
      const command = await this.#runGitCommand("list", ["worktree", "list", "--porcelain"], repoRoot);
      if (!command.ok) {
        return ok(200, {
          worktrees: records,
          gitWorktrees: [],
          git: command,
          warning: command.reason || WORKTREE_ERROR_CODES.GIT_ERROR,
        });
      }
      return ok(200, {
        worktrees: records,
        gitWorktrees: parseGitWorktreeList(command.stdout),
        git: command,
      });
    }

    return ok(200, { worktrees: records });
  }

  /**
   * Archive lifecycle metadata and optionally remove the git worktree after
   * explicit confirmation plus dirty/ahead safety checks.
   *
   * @param {object} input
   * @returns {Promise<{ok: true, status: 200, worktree: WorktreeRecord} | object>}
   */
  async archive(input = {}) {
    if (!isPlainObject(input)) {
      return err(400, WORKTREE_ERROR_CODES.INVALID_INPUT, "archive input must be an object");
    }
    const destructive = input.deleteFromDisk === true || input.removeFromDisk === true;
    const reason = normalizeOptionalString(input.reason);
    if (!archiveConfirmed(input)) {
      return err(
        400,
        WORKTREE_ERROR_CODES.ARCHIVE_CONFIRMATION_REQUIRED,
        `archive requires explicit confirmation (${WORKTREE_ARCHIVE_CONFIRMATION})`,
      );
    }
    if (!reason) {
      return err(
        400,
        WORKTREE_ERROR_CODES.ARCHIVE_REASON_REQUIRED,
        "archive reason is required",
      );
    }
    if (destructive && !deleteConfirmed(input)) {
      return err(
        400,
        WORKTREE_ERROR_CODES.DELETE_CONFIRMATION_REQUIRED,
        `delete requires explicit confirmation (${WORKTREE_DELETE_CONFIRMATION})`,
        { reason },
      );
    }

    const record = findRecord(input, this.records);
    if (!record) {
      return err(404, WORKTREE_ERROR_CODES.NOT_FOUND, "worktree not found");
    }

    const ts = this.now();
    const commands = record.commands.slice();
    let deletedFromDisk = record.deletedFromDisk === true;
    let deletedAt = record.deletedAt || null;

    if (destructive) {
      const safety = await this.#inspectDeleteSafety(record);
      if (!safety.ok) return safety;
      commands.push(...safety.commands);

      const remove = await this.#runGitCommand("delete", ["worktree", "remove", record.path], record.repoRoot);
      commands.push(remove);
      if (!remove.ok) {
        return commandError(remove, "Failed to delete worktree");
      }
      deletedFromDisk = true;
      deletedAt = ts;
    }

    const next = freezeRecord({
      ...record,
      status: "archived",
      updatedAt: ts,
      archivedAt: ts,
      archiveReason: reason,
      deletedFromDisk,
      deletedAt,
      commands,
    });
    this.records.set(next.id, next);
    return ok(200, { worktree: cloneRecord(next) });
  }

  serialize() {
    return Array.from(this.records.values()).map(cloneRecord);
  }

  static deserialize(payload, options = {}) {
    if (!Array.isArray(payload)) {
      throw new TypeError("WorktreeService payload must be an array");
    }
    return new WorktreeService({ ...options, records: payload });
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

  async #inspectDeleteSafety(record) {
    const commands = [];
    if (resolve(record.path) === resolve(record.repoRoot)) {
      return err(
        400,
        WORKTREE_ERROR_CODES.DESTRUCTIVE_ARCHIVE_REFUSED,
        "refusing to delete the primary repository worktree",
        { reason: "primary_repo_worktree" },
      );
    }

    const status = await this.#runGitCommand("delete-status", ["status", "--porcelain=v1", "--branch"], record.path);
    commands.push(status);
    if (!status.ok) {
      return commandError(status, "Failed to inspect worktree status before delete");
    }

    const statusLines = String(status.stdout || "").split(/\r?\n/).filter((line) => line.length > 0);
    const dirtyLines = statusLines.filter((line) => !line.startsWith("## "));
    if (dirtyLines.length > 0) {
      return err(
        400,
        WORKTREE_ERROR_CODES.DELETE_UNCOMMITTED_CHANGES_REFUSED,
        "refusing to delete worktree with uncommitted changes",
        { reason: "uncommitted_changes", dirtyLines, git: status },
      );
    }

    const inFlight = await this.#runGitCommand(
      "delete-in-flight",
      ["rev-list", "--count", "HEAD", "--not", "--remotes"],
      record.path,
    );
    commands.push(inFlight);
    if (!inFlight.ok) {
      return commandError(inFlight, "Failed to inspect in-flight commits before delete");
    }

    const inFlightCommits = Number.parseInt(String(inFlight.stdout || "").trim(), 10);
    if (Number.isFinite(inFlightCommits) && inFlightCommits > 0) {
      return err(
        400,
        WORKTREE_ERROR_CODES.DELETE_IN_FLIGHT_COMMITS_REFUSED,
        "refusing to delete worktree with in-flight commits",
        { reason: "in_flight_commits", inFlightCommits, git: inFlight },
      );
    }

    const branchLine = statusLines.find((line) => line.startsWith("## ")) || "";
    const aheadMatch = branchLine.match(/\bahead\s+(\d+)/i);
    const aheadCount = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
    if (Number.isFinite(aheadCount) && aheadCount > 0) {
      return err(
        400,
        WORKTREE_ERROR_CODES.DELETE_IN_FLIGHT_COMMITS_REFUSED,
        "refusing to delete worktree with commits ahead of upstream",
        { reason: "ahead_of_upstream", aheadCount, git: status },
      );
    }

    return { ok: true, commands };
  }
}

export function makeWorktreeId() {
  return `wt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function createWorktreeService(options = {}) {
  return new WorktreeService(options);
}

export function parseGitWorktreeList(stdout) {
  const rows = [];
  let current = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) rows.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) rows.push(current);
      current = { path: value, branch: null, head: null, bare: false, detached: false };
    } else if (current && key === "HEAD") {
      current.head = value || null;
    } else if (current && key === "branch") {
      current.branch = value || null;
    } else if (current && key === "bare") {
      current.bare = true;
    } else if (current && key === "detached") {
      current.detached = true;
    }
  }
  if (current) rows.push(current);
  return rows;
}

export function normalizeWorktreeRecord(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("WorktreeRecord must be a plain object");
  }
  const record = {
    id: requiredString(input.id, "WorktreeRecord.id is required"),
    projectSlug: requiredString(input.projectSlug, "WorktreeRecord.projectSlug is required"),
    repoRoot: safePath(input.repoRoot, "WorktreeRecord.repoRoot"),
    path: safePath(input.path ?? input.worktreePath, "WorktreeRecord.path"),
    taskId: nullableString(input.taskId, "WorktreeRecord.taskId"),
    jobId: nullableString(input.jobId, "WorktreeRecord.jobId"),
    sessionId: nullableString(input.sessionId, "WorktreeRecord.sessionId"),
    branch: nullableString(input.branch, "WorktreeRecord.branch"),
    baseRef: nullableString(input.baseRef, "WorktreeRecord.baseRef"),
    status: WORKTREE_STATUSES.includes(input.status) ? input.status : "active",
    createdAt: requiredString(input.createdAt, "WorktreeRecord.createdAt is required"),
    updatedAt: requiredString(input.updatedAt, "WorktreeRecord.updatedAt is required"),
    archivedAt: nullableString(input.archivedAt, "WorktreeRecord.archivedAt"),
    archiveReason: nullableString(input.archiveReason, "WorktreeRecord.archiveReason"),
    deletedFromDisk: input.deletedFromDisk === true,
    deletedAt: nullableString(input.deletedAt, "WorktreeRecord.deletedAt"),
    bindings: arrayOrEmpty(input.bindings).map(normalizeBinding),
    commands: arrayOrEmpty(input.commands).map((command) => ({ ...command })),
  };
  if (record.status === "archived" && !record.archiveReason) {
    throw new TypeError("WorktreeRecord.archiveReason is required for archived records");
  }
  return freezeRecord(record);
}

function prepareCreateInput(input, { now, makeId }) {
  if (!isPlainObject(input)) {
    return err(400, WORKTREE_ERROR_CODES.INVALID_INPUT, "create input must be an object");
  }
  const ts = now();
  try {
    const record = normalizeWorktreeRecord({
      id: normalizeOptionalString(input.id) || makeId(),
      projectSlug: input.projectSlug,
      repoRoot: input.repoRoot,
      path: input.path ?? input.worktreePath,
      taskId: input.taskId,
      jobId: input.jobId,
      sessionId: input.sessionId,
      branch: input.branch,
      baseRef: input.baseRef ?? input.branch,
      status: "active",
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      archiveReason: null,
      bindings: initialBindings(input, ts),
      commands: [],
    });
    return { ok: true, record };
  } catch (error) {
    return err(400, WORKTREE_ERROR_CODES.INVALID_INPUT, error.message);
  }
}

function prepareBindInput(input, records) {
  if (!isPlainObject(input)) {
    return err(400, WORKTREE_ERROR_CODES.INVALID_INPUT, "bind input must be an object");
  }
  const record = findRecord(input, records);
  if (!record) return err(404, WORKTREE_ERROR_CODES.NOT_FOUND, "worktree not found");
  if (!firstString(input.sessionId, input.jobId, input.taskId)) {
    return err(
      400,
      WORKTREE_ERROR_CODES.INVALID_INPUT,
      "bind requires at least one of sessionId, jobId, or taskId",
    );
  }
  try {
    return {
      ok: true,
      record,
      binding: normalizeBinding({
        projectSlug: input.projectSlug,
        taskId: input.taskId,
        jobId: input.jobId,
        sessionId: input.sessionId,
        reason: input.reason,
      }),
    };
  } catch (error) {
    return err(400, WORKTREE_ERROR_CODES.INVALID_INPUT, error.message);
  }
}

function initialBindings(input, boundAt) {
  if (!firstString(input.sessionId, input.jobId, input.taskId)) return [];
  return [
    normalizeBinding({
      projectSlug: input.projectSlug,
      taskId: input.taskId,
      jobId: input.jobId,
      sessionId: input.sessionId,
      reason: input.reason,
      boundAt,
    }),
  ];
}

function normalizeBinding(input) {
  return {
    projectSlug: nullableString(input.projectSlug, "binding.projectSlug"),
    taskId: nullableString(input.taskId, "binding.taskId"),
    jobId: nullableString(input.jobId, "binding.jobId"),
    sessionId: nullableString(input.sessionId, "binding.sessionId"),
    reason: nullableString(input.reason, "binding.reason"),
    boundAt: nullableString(input.boundAt, "binding.boundAt"),
  };
}

function appendBinding(existing, binding) {
  const next = arrayOrEmpty(existing).map((item) => ({ ...item }));
  next.push(binding);
  return next;
}

function findRecord(input, records) {
  const id = normalizeOptionalString(input.id ?? input.worktreeId);
  if (id && records.has(id)) return records.get(id);
  const path = normalizeOptionalString(input.path ?? input.worktreePath);
  if (!path) return null;
  const resolved = resolve(path);
  return Array.from(records.values()).find((record) => resolve(record.path) === resolved) || null;
}

function matchesFilter(record, filter = {}) {
  for (const key of ["projectSlug", "taskId", "jobId", "sessionId", "status"]) {
    if (filter[key] !== undefined && filter[key] !== record[key]) return false;
  }
  if (filter.path !== undefined || filter.worktreePath !== undefined) {
    const path = filter.path ?? filter.worktreePath;
    if (!isNonEmptyString(path) || resolve(path) !== resolve(record.path)) return false;
  }
  return true;
}

function archiveConfirmed(input) {
  return (
    input.confirm === true ||
    input.confirmArchive === true ||
    input.confirmation === WORKTREE_ARCHIVE_CONFIRMATION
  );
}

function deleteConfirmed(input) {
  return (
    input.confirmDelete === true ||
    input.confirmDeletion === true ||
    input.deleteConfirmation === WORKTREE_DELETE_CONFIRMATION ||
    input.confirmation === WORKTREE_DELETE_CONFIRMATION
  );
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
    reason: unavailable ? WORKTREE_ERROR_CODES.GIT_UNAVAILABLE : null,
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
    reason: unavailable ? WORKTREE_ERROR_CODES.GIT_UNAVAILABLE : WORKTREE_ERROR_CODES.GIT_ERROR,
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
    ? WORKTREE_ERROR_CODES.GIT_UNAVAILABLE
    : WORKTREE_ERROR_CODES.GIT_ERROR;
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

function cloneRecord(record) {
  return {
    ...record,
    bindings: record.bindings.map((binding) => ({ ...binding })),
    commands: record.commands.map((command) => ({ ...command, args: command.args?.slice?.() || [] })),
  };
}

function freezeRecord(record) {
  return Object.freeze({
    ...record,
    bindings: Object.freeze(record.bindings.map((binding) => Object.freeze({ ...binding }))),
    commands: Object.freeze(record.commands.map((command) => Object.freeze({ ...command }))),
  });
}

function safePath(value, field) {
  const normalized = requiredString(value, `${field} is required`);
  if (normalized.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
  if (normalized.startsWith("-")) throw new TypeError(`${field} must not start with '-'`);
  return normalized;
}

function nullableString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string when present`);
  if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
  return value.length === 0 ? null : value;
}

function requiredString(value, message) {
  if (!isNonEmptyString(value)) throw new TypeError(message);
  return value;
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(...values) {
  return values.find(isNonEmptyString) || null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
