// hub/run-session/drafts.js — sh-3-01 (TDD v0.5 §6.7, §8A.1; PRD §6.7; §23.2 #33)
//
// RunSessionDraft model + ephemeral storage. A draft is the short-lived
// launch/preflight object created by every Run Session entry point
// (task card, swimlane, Hub, CLI, attach). All entry points converge on
// the same draft → launch path; this module owns just the model + store.
//
// Storage is in-memory only. There is no rehydration on server restart;
// drafts are discarded with the process, which matches the "ephemeral
// launch/preflight" semantics from PRD §6.7 and TDD §6.7.
//
// v0.7 shape (TDD §23.2 #33): every draft carries an explicit `source` and
// `mode`. `taskId` is required iff `mode === "task_backed"` and must be
// null/absent otherwise. The store enforces these invariants on create
// and on every update — RunSessionService and the endpoints layer can
// rely on a draft always being structurally valid.

import { randomBytes } from "node:crypto";
import { validateProviderCapabilities } from "../providers/capabilities.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes per DoD
const DRAFT_ID_RE = /^draft_[0-9a-f]{24}$/;

const SOURCES = Object.freeze([
  "task_card",
  "swimlane_next",
  "hub_run",
  "global_new_session",
  "attach",
  "cli",
]);
const MODES = Object.freeze(["task_backed", "untasked", "attach_existing"]);
const SANDBOXES = Object.freeze(["readonly", "workspace-write", "autoedit", "full-auto"]);
const CLAIM_MODES = Object.freeze(["fail_if_active", "join", "force"]);
const RUN_PREFLIGHT_WARNING_KINDS = Object.freeze([
  "task_already_has_active_job",
  "missing_repo_metadata",
  "shared_worktree",
  "dependencies_not_satisfied",
  "verify_pack_empty",
  "adapter_capability_missing",
  "provider_unavailable",
  "capability_mismatch",
  "sandbox_disallowed",
  "context_injection_unsupported",
  "task_already_bound_other_session",
  "attach_context_overflow",
]);
const RUN_PREFLIGHT_WARNING_SEVERITIES = Object.freeze(["high", "medium", "low"]);

export const RUN_SESSION_DRAFT_SOURCES = SOURCES;
export const RUN_SESSION_DRAFT_MODES = MODES;
export const RUN_SESSION_DRAFT_SANDBOXES = SANDBOXES;
export const RUN_SESSION_DRAFT_CLAIM_MODES = CLAIM_MODES;
export const DRAFT_ID_PATTERN = DRAFT_ID_RE;

export function isRunSessionDraftId(value) {
  return typeof value === "string" && DRAFT_ID_RE.test(value);
}

export function makeDraftId() {
  return `draft_${randomBytes(12).toString("hex")}`;
}

/**
 * Create an in-memory RunSessionDraft store.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] expiry window from creation; default 30 min.
 * @param {() => number} [options.now] clock injection for tests.
 * @returns {{
 *   create(input: object): object,
 *   get(id: string): object | null,
 *   update(id: string, patch: object): object,
 *   delete(id: string): boolean,
 *   sweep(): number,
 *   readonly size: number,
 * }}
 */
export function createDraftStore(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`createDraftStore: ttlMs must be a positive number, got ${ttlMs}`);
  }
  if (typeof now !== "function") {
    throw new TypeError("createDraftStore: now must be a function returning ms");
  }

  /** @type {Map<string, object>} */
  const drafts = new Map();

  function isExpired(draft, at) {
    return Date.parse(draft.expiresAt) <= at;
  }

  function create(input) {
    const normalized = validateDraftInput(input);
    const id = makeDraftId();
    const createdMs = now();
    const draft = freezeDraft({
      ...normalized,
      id,
      createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(createdMs + ttlMs).toISOString(),
    });
    drafts.set(id, draft);
    return draft;
  }

  function get(id) {
    if (!isRunSessionDraftId(id)) return null;
    const draft = drafts.get(id);
    if (!draft) return null;
    if (isExpired(draft, now())) {
      drafts.delete(id);
      return null;
    }
    return draft;
  }

  function update(id, patch) {
    if (!isRunSessionDraftId(id)) {
      throw new TypeError(`update: invalid draft id ${JSON.stringify(id)}`);
    }
    const existing = drafts.get(id);
    if (!existing) throw new Error(`update: draft ${id} not found`);
    if (isExpired(existing, now())) {
      drafts.delete(id);
      throw new Error(`update: draft ${id} has expired`);
    }
    if (patch == null || typeof patch !== "object") {
      throw new TypeError("update: patch must be an object");
    }
    if ("id" in patch || "createdAt" in patch || "expiresAt" in patch) {
      throw new TypeError("update: id/createdAt/expiresAt are immutable");
    }
    const merged = validateDraftInput({ ...existing, ...patch });
    const next = freezeDraft({
      ...merged,
      id: existing.id,
      createdAt: existing.createdAt,
      expiresAt: existing.expiresAt,
    });
    drafts.set(id, next);
    return next;
  }

  function del(id) {
    if (!isRunSessionDraftId(id)) return false;
    return drafts.delete(id);
  }

  function sweep() {
    const at = now();
    let removed = 0;
    for (const [id, draft] of drafts) {
      if (isExpired(draft, at)) {
        drafts.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    create,
    get,
    update,
    delete: del,
    sweep,
    get size() {
      return drafts.size;
    },
  };
}

function validateDraftInput(input) {
  if (input == null || typeof input !== "object") {
    throw new TypeError("RunSessionDraft input must be an object");
  }
  const { source, mode } = input;
  if (!SOURCES.includes(source)) {
    throw new TypeError(
      `RunSessionDraft.source must be one of ${SOURCES.join("|")}, got ${JSON.stringify(source)}`,
    );
  }
  if (!MODES.includes(mode)) {
    throw new TypeError(
      `RunSessionDraft.mode must be one of ${MODES.join("|")}, got ${JSON.stringify(mode)}`,
    );
  }

  const rawTaskId = input.taskId;
  const hasTaskId = rawTaskId != null;
  if (mode === "task_backed") {
    if (!hasTaskId || typeof rawTaskId !== "string" || rawTaskId.length === 0) {
      throw new TypeError(
        'RunSessionDraft.taskId is required when mode === "task_backed"',
      );
    }
  } else if (hasTaskId) {
    throw new TypeError(
      `RunSessionDraft.taskId must be null/absent when mode === ${JSON.stringify(mode)}`,
    );
  }

  // taskLocked defaults to true for task_backed entries from a task card,
  // false otherwise. Endpoints layer (sh-3-03) may override.
  const taskLocked =
    typeof input.taskLocked === "boolean"
      ? input.taskLocked
      : mode === "task_backed" && source === "task_card";

  const newTaskFormDraft = validateNewTaskFormDraft(input.newTaskFormDraft);
  if (newTaskFormDraft && mode === "task_backed") {
    throw new TypeError(
      "RunSessionDraft.newTaskFormDraft must be promoted to a durable taskId before mode === \"task_backed\"",
    );
  }

  const normalized = {
    ...input,
    source,
    mode,
    taskId: mode === "task_backed" ? rawTaskId : null,
    taskLocked,
    providerId: validateOptionalString(input.providerId, "providerId"),
    model: validateOptionalString(input.model, "model"),
    sandbox: validateOptionalEnum(input.sandbox, "sandbox", SANDBOXES),
    worktreePath: validateOptionalString(input.worktreePath, "worktreePath"),
    branch: validateOptionalString(input.branch, "branch"),
    capabilityPreview: validateCapabilityPreview(input.capabilityPreview),
    claimMode: validateOptionalEnum(input.claimMode, "claimMode", CLAIM_MODES) ?? "fail_if_active",
    expectedTrackerRev: validateExpectedTrackerRev(input.expectedTrackerRev),
    refreshContext: validateRefreshContext(input.refreshContext),
    newTaskFormDraft,
    warnings: validateWarnings(input.warnings),
  };
  return normalized;
}

function validateOptionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`RunSessionDraft.${field} must be a non-empty string when present`);
  }
  return value;
}

function validateOptionalEnum(value, field, allowed) {
  if (value == null) return null;
  if (!allowed.includes(value)) {
    throw new TypeError(
      `RunSessionDraft.${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateCapabilityPreview(value) {
  if (value == null) return null;
  return cloneDraftValue(validateProviderCapabilities(value));
}

function validateExpectedTrackerRev(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("RunSessionDraft.expectedTrackerRev must be a non-negative integer");
  }
  return value;
}

function validateRefreshContext(value) {
  if (value == null) return false;
  if (typeof value !== "boolean") {
    throw new TypeError("RunSessionDraft.refreshContext must be boolean");
  }
  return value;
}

function validateNewTaskFormDraft(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    throw new TypeError("RunSessionDraft.newTaskFormDraft must be an object when present");
  }
  const title = validateNewTaskString(value.title, "title");
  const projectSlug = validateNewTaskString(value.projectSlug, "projectSlug");
  const out = { title, projectSlug };
  if (value.lane != null) out.lane = validateNewTaskString(value.lane, "lane");
  if (value.priority != null) out.priority = validateNewTaskString(value.priority, "priority");
  if (value.dod != null) {
    if (!Array.isArray(value.dod) || value.dod.some((item) => typeof item !== "string")) {
      throw new TypeError("RunSessionDraft.newTaskFormDraft.dod must be an array of strings");
    }
    out.dod = cloneDraftValue(value.dod);
  }
  return out;
}

function validateNewTaskString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`RunSessionDraft.newTaskFormDraft.${field} must be a non-empty string`);
  }
  return value;
}

function validateWarnings(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("RunSessionDraft.warnings must be an array when present");
  }
  return value.map((warning, index) => validateWarning(warning, index));
}

function validateWarning(warning, index) {
  if (!isPlainObject(warning)) {
    throw new TypeError(`RunSessionDraft.warnings[${index}] must be an object`);
  }
  if (!RUN_PREFLIGHT_WARNING_KINDS.includes(warning.kind)) {
    throw new TypeError(`RunSessionDraft.warnings[${index}].kind is invalid`);
  }
  if (!RUN_PREFLIGHT_WARNING_SEVERITIES.includes(warning.severity)) {
    throw new TypeError(`RunSessionDraft.warnings[${index}].severity is invalid`);
  }
  switch (warning.kind) {
    case "task_already_has_active_job":
      requireWarningString(warning, index, "jobId");
      requireWarningSeverity(warning, index, "high");
      break;
    case "shared_worktree":
      requireWarningString(warning, index, "worktreePath");
      requireWarningStringArray(warning, index, "sessionIds");
      requireWarningSeverity(warning, index, "medium", "high");
      break;
    case "dependencies_not_satisfied":
      requireWarningStringArray(warning, index, "dependencyTaskIds");
      requireWarningSeverity(warning, index, "high");
      break;
    case "adapter_capability_missing":
      requireWarningString(warning, index, "capability");
      requireWarningSeverity(warning, index, "low", "medium");
      break;
    case "provider_unavailable":
      requireWarningString(warning, index, "providerId");
      requireWarningSeverity(warning, index, "high");
      break;
    case "capability_mismatch":
      requireWarningString(warning, index, "requiredCap");
      requireWarningSeverity(warning, index, "medium", "high");
      break;
    case "sandbox_disallowed":
      requireWarningString(warning, index, "sandbox");
      requireWarningString(warning, index, "reason");
      requireWarningSeverity(warning, index, "high");
      break;
    case "task_already_bound_other_session":
      requireWarningString(warning, index, "otherSessionId");
      requireWarningString(warning, index, "otherJobId");
      requireWarningSeverity(warning, index, "high");
      break;
    case "attach_context_overflow":
      requireWarningNumber(warning, index, "currentUsed");
      requireWarningNumber(warning, index, "estBriefTokens");
      requireWarningNumber(warning, index, "capacity");
      requireWarningSeverity(warning, index, "medium", "high");
      break;
    case "missing_repo_metadata":
    case "verify_pack_empty":
      requireWarningSeverity(warning, index, "medium");
      break;
    case "context_injection_unsupported":
      requireWarningSeverity(warning, index, "low", "medium");
      break;
  }
  return cloneDraftValue(warning);
}

function requireWarningSeverity(warning, index, ...allowed) {
  if (!allowed.includes(warning.severity)) {
    throw new TypeError(
      `RunSessionDraft.warnings[${index}].severity for ${warning.kind} must be one of ${allowed.join("|")}`,
    );
  }
}

function requireWarningString(warning, index, field) {
  if (typeof warning[field] !== "string" || warning[field].length === 0) {
    throw new TypeError(`RunSessionDraft.warnings[${index}].${field} must be a non-empty string`);
  }
}

function requireWarningStringArray(warning, index, field) {
  if (!Array.isArray(warning[field]) || warning[field].some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`RunSessionDraft.warnings[${index}].${field} must be an array of non-empty strings`);
  }
}

function requireWarningNumber(warning, index, field) {
  if (!Number.isFinite(warning[field]) || warning[field] < 0) {
    throw new TypeError(`RunSessionDraft.warnings[${index}].${field} must be a non-negative number`);
  }
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function cloneDraftValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneDraftValue(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneDraftValue(child)]),
    );
  }
  return value;
}

function freezeDraft(value) {
  return deepFreeze(cloneDraftValue(value));
}

function deepFreeze(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
