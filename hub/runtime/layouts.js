// hub/runtime/layouts.js — SH-2-08 (TDD v0.5 §6.11, §23.1, §23.2 #13)
//
// SessionHubLayoutFile is the SOLE source of truth for hub layout state.
// One workspace-local file: `.runtime/layouts/session-hub.json`. Per-project
// subsections live INSIDE that one file (not in per-project files). Writes
// are atomic via `atomicWriteJson` (temp → fsync → rename → dir-fsync).
//
// Per §23.1 the layout surface is decoupled from the runtime event log:
// LayoutUpdatedEvent was removed, so this module MUST NOT touch
// `runtime-events.jsonl` or any RuntimeStore symbol. The fallback path on
// missing / corrupt / invalid JSON returns a deep-cloned DEFAULT_LAYOUT so
// the UI always has something safe to render.

import { readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson as defaultAtomicWriteJson } from "./atomic.js";
import { ATTENTION_KINDS } from "../attention/types.js";
import { SESSION_ID_RE } from "./ids.js";

/**
 * Frozen default layout — matches §6.11 with the minimum required keys.
 * Callers receive deep-cloned copies via `load()` so mutation is safe.
 */
export const DEFAULT_LAYOUT = Object.freeze({
  version: 1,
  global: Object.freeze({ cardSizeDefault: "normal" }),
  views: Object.freeze({}),
});

export const CARD_SIZES = Object.freeze(["compact", "normal", "large"]);

export const HUB_GROUP_BY = Object.freeze([
  "project",
  "urgency",
  "custom",
  "provider",
  "repo_worktree",
  "swimlane",
]);

export const TRIAGE_SORT_BY = Object.freeze(["severity", "createdAt"]);

const ALLOWED_TOP_KEYS = new Set(["version", "global", "views"]);
const ALLOWED_GLOBAL_KEYS = new Set(["cardSizeDefault", "dockWidth"]);
const ALLOWED_VIEWS_KEYS = new Set(["hub", "triage", "project"]);
const ALLOWED_HUB_KEYS = new Set([
  "groupBy",
  "collapsedGroups",
  "pinnedSessionIds",
  "cardSizeOverride",
]);
const ALLOWED_TRIAGE_KEYS = new Set(["visibleKinds", "sortBy"]);
const ALLOWED_PROJECT_KEYS = new Set(["collapsed", "pinnedSessionIds"]);

const CARD_SIZE_SET = new Set(CARD_SIZES);
const HUB_GROUP_BY_SET = new Set(HUB_GROUP_BY);
const TRIAGE_SORT_BY_SET = new Set(TRIAGE_SORT_BY);
const ATTENTION_KIND_SET = new Set(ATTENTION_KINDS);

/**
 * Workspace-local layout file path (DoD #1).
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function layoutFilePath(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError("layoutFilePath: workspaceRoot must be a non-empty string");
  }
  return path.join(workspaceRoot, ".runtime", "layouts", "session-hub.json");
}

/**
 * Deep clone via JSON round-trip — fine because the layout is pure JSON data.
 * Frozen sources (DEFAULT_LAYOUT) round-trip into mutable plain objects.
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Strict validator for the §6.11 shape. Throws on the first violation with
 * a path-prefixed message; rejects unknown keys at every level so the file
 * really is a single source of truth (no silent drops).
 *
 * @param {unknown} layout
 * @returns {void}
 */
export function assertValidLayout(layout) {
  if (!isPlainObject(layout)) {
    throw new Error("layout must be a plain object");
  }
  for (const key of Object.keys(layout)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`layout: unknown top-level key '${key}'`);
    }
  }
  if (layout.version !== 1) {
    throw new Error(`layout.version must be 1 (got ${JSON.stringify(layout.version)})`);
  }
  if (!isPlainObject(layout.global)) {
    throw new Error("layout.global must be a plain object");
  }
  for (const key of Object.keys(layout.global)) {
    if (!ALLOWED_GLOBAL_KEYS.has(key)) {
      throw new Error(`layout.global: unknown key '${key}'`);
    }
  }
  if (!CARD_SIZE_SET.has(layout.global.cardSizeDefault)) {
    throw new Error(
      `layout.global.cardSizeDefault must be one of ${CARD_SIZES.join(", ")} (got ${JSON.stringify(layout.global.cardSizeDefault)})`,
    );
  }
  if (layout.global.dockWidth !== undefined) {
    if (typeof layout.global.dockWidth !== "number" || !Number.isFinite(layout.global.dockWidth) || layout.global.dockWidth <= 0) {
      throw new Error("layout.global.dockWidth must be a positive number when present");
    }
  }

  if (layout.views === undefined) {
    // views is optional only at the top-level interface boundary; per §6.11
    // the field is declared but its sub-keys are all optional. We accept an
    // omitted `views` and treat it as `{}`.
    return;
  }
  if (!isPlainObject(layout.views)) {
    throw new Error("layout.views must be a plain object when present");
  }
  for (const key of Object.keys(layout.views)) {
    if (!ALLOWED_VIEWS_KEYS.has(key)) {
      throw new Error(`layout.views: unknown key '${key}'`);
    }
  }

  if (layout.views.hub !== undefined) assertHubLayout(layout.views.hub);
  if (layout.views.triage !== undefined) assertTriageLayout(layout.views.triage);
  if (layout.views.project !== undefined) assertProjectMap(layout.views.project);
}

function assertHubLayout(hub) {
  if (!isPlainObject(hub)) {
    throw new Error("layout.views.hub must be a plain object");
  }
  for (const key of Object.keys(hub)) {
    if (!ALLOWED_HUB_KEYS.has(key)) {
      throw new Error(`layout.views.hub: unknown key '${key}'`);
    }
  }
  if (hub.groupBy !== undefined && !HUB_GROUP_BY_SET.has(hub.groupBy)) {
    throw new Error(
      `layout.views.hub.groupBy must be one of ${HUB_GROUP_BY.join(", ")} (got ${JSON.stringify(hub.groupBy)})`,
    );
  }
  if (hub.collapsedGroups !== undefined) {
    if (!Array.isArray(hub.collapsedGroups) || !hub.collapsedGroups.every((s) => typeof s === "string")) {
      throw new Error("layout.views.hub.collapsedGroups must be an array of strings");
    }
  }
  if (hub.pinnedSessionIds !== undefined) {
    if (!Array.isArray(hub.pinnedSessionIds)) {
      throw new Error("layout.views.hub.pinnedSessionIds must be an array of SessionIds");
    }
    for (const id of hub.pinnedSessionIds) {
      if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
        throw new Error(`layout.views.hub.pinnedSessionIds: '${id}' is not a valid SessionId`);
      }
    }
  }
  if (hub.cardSizeOverride !== undefined) {
    if (!isPlainObject(hub.cardSizeOverride)) {
      throw new Error("layout.views.hub.cardSizeOverride must be a plain object");
    }
    for (const [k, v] of Object.entries(hub.cardSizeOverride)) {
      if (!SESSION_ID_RE.test(k)) {
        throw new Error(`layout.views.hub.cardSizeOverride: '${k}' is not a valid SessionId`);
      }
      if (!CARD_SIZE_SET.has(v)) {
        throw new Error(
          `layout.views.hub.cardSizeOverride[${k}] must be one of ${CARD_SIZES.join(", ")} (got ${JSON.stringify(v)})`,
        );
      }
    }
  }
}

function assertTriageLayout(triage) {
  if (!isPlainObject(triage)) {
    throw new Error("layout.views.triage must be a plain object");
  }
  for (const key of Object.keys(triage)) {
    if (!ALLOWED_TRIAGE_KEYS.has(key)) {
      throw new Error(`layout.views.triage: unknown key '${key}'`);
    }
  }
  if (triage.visibleKinds !== undefined) {
    if (!Array.isArray(triage.visibleKinds)) {
      throw new Error("layout.views.triage.visibleKinds must be an array of AttentionKinds");
    }
    for (const k of triage.visibleKinds) {
      if (!ATTENTION_KIND_SET.has(k)) {
        throw new Error(`layout.views.triage.visibleKinds: '${k}' not in ATTENTION_KINDS`);
      }
    }
  }
  if (triage.sortBy !== undefined && !TRIAGE_SORT_BY_SET.has(triage.sortBy)) {
    throw new Error(
      `layout.views.triage.sortBy must be one of ${TRIAGE_SORT_BY.join(", ")} (got ${JSON.stringify(triage.sortBy)})`,
    );
  }
}

function assertProjectMap(projects) {
  if (!isPlainObject(projects)) {
    throw new Error("layout.views.project must be a plain object keyed by project slug");
  }
  for (const [slug, sub] of Object.entries(projects)) {
    if (!isPlainObject(sub)) {
      throw new Error(`layout.views.project[${slug}] must be a plain object`);
    }
    for (const key of Object.keys(sub)) {
      if (!ALLOWED_PROJECT_KEYS.has(key)) {
        throw new Error(`layout.views.project[${slug}]: unknown key '${key}'`);
      }
    }
    if (sub.collapsed !== undefined && typeof sub.collapsed !== "boolean") {
      throw new Error(`layout.views.project[${slug}].collapsed must be boolean when present`);
    }
    if (sub.pinnedSessionIds !== undefined) {
      if (!Array.isArray(sub.pinnedSessionIds)) {
        throw new Error(`layout.views.project[${slug}].pinnedSessionIds must be an array of SessionIds`);
      }
      for (const id of sub.pinnedSessionIds) {
        if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
          throw new Error(`layout.views.project[${slug}].pinnedSessionIds: '${id}' is not a valid SessionId`);
        }
      }
    }
  }
}

/**
 * Recursive merge that overlays `partial` onto `base`. Plain objects are
 * merged key-by-key; arrays and scalars on `partial` REPLACE the base value
 * (mirrors typical PATCH semantics — pinning lists, for example, are
 * replaced wholesale rather than concatenated).
 */
function deepMerge(base, partial) {
  if (!isPlainObject(partial)) return clone(partial);
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(partial)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = isPlainObject(v) || Array.isArray(v) ? clone(v) : v;
    }
  }
  return out;
}

/**
 * Service over the workspace-local layout file. Pure data access — no event
 * log, no projection writes, no WebSocket broadcasts. Wire-in is up to the
 * HTTP layer.
 */
export class LayoutStore {
  /**
   * @param {object} opts
   * @param {string} opts.workspaceRoot
   * @param {typeof defaultAtomicWriteJson} [opts.atomicWriteJson]
   * @param {typeof defaultReadFile} [opts.readFile]
   */
  constructor({ workspaceRoot, atomicWriteJson = defaultAtomicWriteJson, readFile = defaultReadFile } = {}) {
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      throw new TypeError("LayoutStore: workspaceRoot must be a non-empty string");
    }
    this.workspaceRoot = workspaceRoot;
    this.filePath = layoutFilePath(workspaceRoot);
    this._atomicWriteJson = atomicWriteJson;
    this._readFile = readFile;
  }

  /**
   * Load the layout. On missing file: return a clone of DEFAULT_LAYOUT
   * silently. On parse or schema failure: log one warning and return the
   * default (DoD #4 — corrupt file falls back to default).
   * @returns {Promise<object>}
   */
  async load() {
    let raw;
    try {
      raw = await this._readFile(this.filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return clone(DEFAULT_LAYOUT);
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[layouts] corrupt JSON at ${this.filePath} (${err.message}); falling back to DEFAULT_LAYOUT`,
      );
      return clone(DEFAULT_LAYOUT);
    }
    try {
      assertValidLayout(parsed);
    } catch (err) {
      console.warn(
        `[layouts] invalid layout at ${this.filePath} (${err.message}); falling back to DEFAULT_LAYOUT`,
      );
      return clone(DEFAULT_LAYOUT);
    }
    return parsed;
  }

  /**
   * Validate then atomically overwrite the layout file. Returns the saved
   * layout (a clone) for convenience.
   * @param {object} layout
   * @returns {Promise<object>}
   */
  async save(layout) {
    assertValidLayout(layout);
    await this._atomicWriteJson(this.filePath, layout);
    return clone(layout);
  }

  /**
   * Deep-merge `partial` onto the on-disk layout, validate, atomically
   * overwrite, return the new layout. Used by PATCH.
   * @param {object} partial
   * @returns {Promise<object>}
   */
  async update(partial) {
    if (!isPlainObject(partial)) {
      throw new TypeError("LayoutStore.update: partial must be a plain object");
    }
    const current = await this.load();
    const next = deepMerge(current, partial);
    return this.save(next);
  }
}
