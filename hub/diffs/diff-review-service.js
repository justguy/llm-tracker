// hub/diffs/diff-review-service.js - SH-7A-01
//
// DiffReviewRecord is durable metadata only. Diff hunks, file lists, and patch
// text are computed on demand from git/worktree state by later DiffReviewService
// slices and must not be persisted with the record.

import { randomUUID } from "node:crypto";

import { isJobId, isRuntimeEventId, isSessionId } from "../runtime/ids.js";
import { evaluateAllowedPathForRepoChange } from "../workspaces/allowed-paths.js";

/**
 * @typedef {"open" | "reviewed" | "changes_requested" | "approved" | "closed"} DiffReviewStatus
 */

/**
 * @typedef {object} DiffReviewRecord
 * @property {string} id
 * @property {string} projectSlug
 * @property {string} [taskId]
 * @property {string} [jobId]
 * @property {string} [sessionId]
 * @property {number} [baseRev]
 * @property {string} [baseGitSha]
 * @property {DiffReviewStatus} status
 * @property {string[]} evidenceRefs
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export const DIFF_REVIEW_STATUSES = Object.freeze([
  "open",
  "reviewed",
  "changes_requested",
  "approved",
  "closed",
]);

export const DIFF_REVIEW_FORBIDDEN_PERSISTED_KEYS = Object.freeze([
  "diff",
  "diffs",
  "files",
  "fileDiffs",
  "hunk",
  "hunks",
  "content",
  "patch",
  "patchText",
  "rawDiff",
]);

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class DiffReviewService {
  /**
   * @param {{ records?: DiffReviewRecord[], now?: () => string, makeId?: () => string }} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
    this.makeId = typeof options.makeId === "function" ? options.makeId : makeDiffReviewId;
    this.records = new Map();
    for (const record of arrayOrEmpty(options.records)) {
      const normalized = normalizeDiffReviewRecord(record);
      this.records.set(normalized.id, normalized);
    }
  }

  /**
   * @param {Partial<DiffReviewRecord> & Record<string, unknown>} input
   * @returns {DiffReviewRecord}
   */
  create(input) {
    const record = createDiffReviewRecord(input, {
      now: this.now,
      makeId: this.makeId,
    });
    this.records.set(record.id, record);
    return { ...record, evidenceRefs: record.evidenceRefs.slice() };
  }

  /**
   * @param {string} id
   * @returns {DiffReviewRecord | null}
   */
  get(id) {
    const record = this.records.get(id);
    return record ? { ...record, evidenceRefs: record.evidenceRefs.slice() } : null;
  }

  /**
   * @param {{ projectSlug?: string, taskId?: string, jobId?: string, sessionId?: string, status?: DiffReviewStatus }} [filter]
   * @returns {DiffReviewRecord[]}
   */
  list(filter = {}) {
    return Array.from(this.records.values())
      .filter((record) => matchesFilter(record, filter))
      .map((record) => ({ ...record, evidenceRefs: record.evidenceRefs.slice() }));
  }

  /**
   * @param {string} id
   * @param {DiffReviewStatus} status
   * @param {{ evidenceRefs?: string[] }} [options]
   * @returns {DiffReviewRecord}
   */
  updateStatus(id, status, options = {}) {
    const current = this.records.get(id);
    if (!current) {
      throw new Error(`DiffReviewRecord ${id} not found`);
    }
    const evidenceRefs =
      options.evidenceRefs === undefined
        ? current.evidenceRefs
        : mergeEvidenceRefs(current.evidenceRefs, options.evidenceRefs);
    const next = updateDiffReviewStatus(
      {
        ...current,
        evidenceRefs,
      },
      status,
      { now: this.now },
    );
    this.records.set(next.id, next);
    return { ...next, evidenceRefs: next.evidenceRefs.slice() };
  }

  /**
   * @returns {DiffReviewRecord[]}
   */
  serialize() {
    return this.list();
  }

  /**
   * @param {unknown} payload
   * @param {{ now?: () => string, makeId?: () => string }} [options]
   * @returns {DiffReviewService}
   */
  static deserialize(payload, options = {}) {
    if (!Array.isArray(payload)) {
      throw new Error("DiffReviewService payload must be an array");
    }
    return new DiffReviewService({ ...options, records: payload });
  }
}

/**
 * @param {unknown} status
 * @returns {status is DiffReviewStatus}
 */
export function isDiffReviewStatus(status) {
  return DIFF_REVIEW_STATUSES.includes(
    /** @type {DiffReviewStatus} */ (status),
  );
}

/**
 * Create a validated DiffReviewRecord from metadata input. `id`, `status`,
 * `createdAt`, and `updatedAt` default when omitted; diff content fields are
 * rejected before normalization.
 *
 * @param {Partial<DiffReviewRecord> & Record<string, unknown>} input
 * @param {{ now?: () => string, makeId?: () => string }} [options]
 * @returns {DiffReviewRecord}
 */
export function createDiffReviewRecord(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new Error("DiffReviewRecord input must be a plain object");
  }
  assertNoPersistedDiffContent(input);
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const makeId = typeof options.makeId === "function" ? options.makeId : makeDiffReviewId;
  const ts = now();
  return normalizeDiffReviewRecord({
    ...input,
    id: input.id === undefined ? makeId() : input.id,
    status: input.status === undefined ? "open" : input.status,
    evidenceRefs: input.evidenceRefs === undefined ? [] : input.evidenceRefs,
    createdAt: input.createdAt === undefined ? ts : input.createdAt,
    updatedAt: input.updatedAt === undefined ? ts : input.updatedAt,
  });
}

/**
 * Normalize and validate the durable DiffReviewRecord shape, dropping unknown
 * non-diff metadata rather than persisting caller-specific baggage.
 *
 * @param {Partial<DiffReviewRecord> & Record<string, unknown>} input
 * @returns {DiffReviewRecord}
 */
export function normalizeDiffReviewRecord(input) {
  if (!isPlainObject(input)) {
    throw new Error("DiffReviewRecord input must be a plain object");
  }
  assertNoPersistedDiffContent(input);
  const record = withOptionalFields({
    id: input.id,
    projectSlug: input.projectSlug,
    taskId: input.taskId,
    jobId: input.jobId,
    sessionId: input.sessionId,
    baseRev: input.baseRev,
    baseGitSha: input.baseGitSha,
    status: input.status,
    evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.slice() : input.evidenceRefs,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  assertValidDiffReviewRecord(record);
  return /** @type {DiffReviewRecord} */ (record);
}

/**
 * Return a validated copy of `record` with an updated status and timestamp.
 *
 * @param {DiffReviewRecord} record
 * @param {DiffReviewStatus} status
 * @param {{ now?: () => string }} [options]
 * @returns {DiffReviewRecord}
 */
export function updateDiffReviewStatus(record, status, options = {}) {
  const current = normalizeDiffReviewRecord(record);
  if (!isDiffReviewStatus(status)) {
    throw new Error(`DiffReviewRecord.status '${status}' not in DIFF_REVIEW_STATUSES`);
  }
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  return normalizeDiffReviewRecord({
    ...current,
    status,
    updatedAt: now(),
  });
}

/**
 * Annotate on-demand diff file rows with outside-allowed-path warning evidence.
 * The returned rows are presentation data only and are not persisted in
 * DiffReviewRecord storage.
 *
 * @param {Array<Record<string, unknown>>} files
 * @param {{ task?: object, repoRoot?: string }} [options]
 * @returns {{ files: Array<Record<string, unknown>>, allowedPathWarnings: string[] }}
 */
export function annotateDiffAllowedPathWarnings(files = [], options = {}) {
  if (!Array.isArray(files)) {
    throw new TypeError("annotateDiffAllowedPathWarnings: files must be an array");
  }
  const allowedPathWarnings = [];
  const annotatedFiles = files.map((file) => {
    const warnings = diffAllowedPathWarningsForFile(file, options);
    if (warnings.length === 0) return { ...file };
    allowedPathWarnings.push(...warnings.map((warning) => warning.id));
    return {
      ...file,
      outsideAllowedPaths: true,
      allowedPathWarnings: mergeStringLists(
        file.allowedPathWarnings,
        warnings.map((warning) => warning.id),
      ),
      allowedPathWarningDetails: mergeWarningDetails(file.allowedPathWarningDetails, warnings),
    };
  });

  return {
    files: annotatedFiles,
    allowedPathWarnings: Array.from(new Set(allowedPathWarnings)),
  };
}

/**
 * @param {Record<string, unknown>} file
 * @param {{ task?: object, repoRoot?: string }} [options]
 * @returns {object | null}
 */
export function diffAllowedPathWarningForFile(file, options = {}) {
  return diffAllowedPathWarningsForFile(file, options)[0] || null;
}

/**
 * @param {Record<string, unknown>} file
 * @param {{ task?: object, repoRoot?: string }} [options]
 * @returns {object[]}
 */
export function diffAllowedPathWarningsForFile(file, options = {}) {
  if (!isPlainObject(file)) return [];
  const repoRoot = firstString(options.repoRoot, file.repoRoot, taskPrimaryRoot(options.task));
  const warnings = [];
  const seen = new Set();

  for (const candidate of diffFilePathCandidates(file)) {
    const result = evaluateAllowedPathForRepoChange({
      task: options.task,
      repoRoot,
      path: candidate.path,
      filePath: candidate.filePath,
    });
    if (!result.outsideAllowedPaths || seen.has(result.changedPath)) continue;
    seen.add(result.changedPath);
    warnings.push({
      id: diffAllowedPathWarningId(repoRoot, result.changedPath),
      kind: "outside_allowed_paths",
      path: result.changedPath,
      allowedPaths: result.patterns.slice(),
      repoRoot: repoRoot || null,
      reason: result.reason,
    });
  }

  return warnings;
}

/**
 * Validate a persisted DiffReviewRecord. Throws on the first violation.
 *
 * @param {unknown} record
 * @returns {void}
 */
export function assertValidDiffReviewRecord(record) {
  if (!isPlainObject(record)) {
    throw new Error("DiffReviewRecord must be a plain object");
  }
  assertNoPersistedDiffContent(record);
  const r = /** @type {Record<string, unknown>} */ (record);
  if (!isNonEmptyString(r.id)) {
    throw new Error("DiffReviewRecord.id required (non-empty string)");
  }
  if (!isNonEmptyString(r.projectSlug)) {
    throw new Error("DiffReviewRecord.projectSlug required (non-empty string)");
  }
  if (!isDiffReviewStatus(r.status)) {
    throw new Error(`DiffReviewRecord.status '${r.status}' not in DIFF_REVIEW_STATUSES`);
  }
  if (!Array.isArray(r.evidenceRefs)) {
    throw new Error("DiffReviewRecord.evidenceRefs must be an array");
  }
  for (const ref of r.evidenceRefs) {
    if (!isRuntimeEventId(ref)) {
      throw new Error("DiffReviewRecord.evidenceRefs entries must be RuntimeEventId strings");
    }
  }
  if (!isIsoTimestamp(r.createdAt)) {
    throw new Error("DiffReviewRecord.createdAt must be an ISO-8601 timestamp");
  }
  if (!isIsoTimestamp(r.updatedAt)) {
    throw new Error("DiffReviewRecord.updatedAt must be an ISO-8601 timestamp");
  }
  if (r.baseRev !== undefined && (!Number.isInteger(r.baseRev) || r.baseRev < 0)) {
    throw new Error("DiffReviewRecord.baseRev must be a non-negative integer when present");
  }
  for (const optional of ["taskId", "jobId", "sessionId", "baseGitSha"]) {
    if (r[optional] !== undefined && !isNonEmptyString(r[optional])) {
      throw new Error(`DiffReviewRecord.${optional} must be a non-empty string when present`);
    }
  }
  if (r.jobId !== undefined && !isJobId(r.jobId)) {
    throw new Error("DiffReviewRecord.jobId must be a JobId when present");
  }
  if (r.sessionId !== undefined && !isSessionId(r.sessionId)) {
    throw new Error("DiffReviewRecord.sessionId must be a SessionId when present");
  }
}

export function makeDiffReviewId() {
  return `dfr_${randomUUID().replace(/-/g, "")}`;
}

export function diffAllowedPathWarningId(repoRoot, path) {
  const rootPart = repoRoot ? `${encodeURIComponent(String(repoRoot))}:` : "";
  return `outside_allowed_paths:${rootPart}${encodeURIComponent(String(path || ""))}`;
}

function assertNoPersistedDiffContent(value) {
  if (!isPlainObject(value)) return;
  for (const key of DIFF_REVIEW_FORBIDDEN_PERSISTED_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new Error(
        `DiffReviewRecord must not persist diff content field '${key}'; compute diff content on demand`,
      );
    }
  }
}

function withOptionalFields(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function matchesFilter(record, filter) {
  for (const key of ["projectSlug", "taskId", "jobId", "sessionId", "status"]) {
    if (filter[key] !== undefined && record[key] !== filter[key]) return false;
  }
  return true;
}

function mergeEvidenceRefs(current, next) {
  if (!Array.isArray(next)) {
    throw new Error("DiffReviewRecord.evidenceRefs must be an array");
  }
  return Array.from(new Set([...current, ...next]));
}

function mergeStringLists(current, next) {
  return Array.from(new Set([...arrayOrEmpty(current).filter(isNonEmptyString), ...next]));
}

function mergeWarningDetails(current, next) {
  return [...arrayOrEmpty(current).filter(isPlainObject), ...next];
}

function diffFilePathCandidates(file) {
  const candidates = [];
  addCandidate(candidates, { path: file.path, filePath: file.filePath });
  addCandidate(candidates, { path: file.oldPath, filePath: file.oldFilePath });
  addCandidate(candidates, { path: file.previousPath, filePath: file.previousFilePath });
  addCandidate(candidates, { path: file.fromPath, filePath: file.fromFilePath });
  addCandidate(candidates, { path: file.toPath, filePath: file.toFilePath });
  return candidates;
}

function addCandidate(candidates, candidate) {
  if (!isNonEmptyString(candidate.path) && !isNonEmptyString(candidate.filePath)) return;
  candidates.push(candidate);
}

function firstString(...values) {
  return values.find(isNonEmptyString) || null;
}

function taskPrimaryRoot(task) {
  return firstString(
    task?.repos?.primary?.root,
    task?.repos?.primary?.worktree,
    task?.repos?.primary?.worktreePath,
  );
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

function isIsoTimestamp(value) {
  return typeof value === "string" && ISO_8601_RE.test(value);
}
