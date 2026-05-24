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

export const RUN_SESSION_DRAFT_SOURCES = SOURCES;
export const RUN_SESSION_DRAFT_MODES = MODES;
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
    const draft = Object.freeze({
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
    const next = Object.freeze({
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

  const normalized = {
    ...input,
    source,
    mode,
    taskId: mode === "task_backed" ? rawTaskId : null,
    taskLocked,
    warnings: Array.isArray(input.warnings) ? [...input.warnings] : [],
  };
  return normalized;
}
