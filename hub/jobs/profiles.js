// hub/jobs/profiles.js — SH-5-03 (TDD v0.5 §11.3, §6.4, §6.5)
//
// Declarative table of the built-in JobProfiles that the Session Hub ships.
// Each profile pins a job `kind` (TDD §6.4 JobKind enum mirrored in
// hub/jobs/registry.js as ALLOWED_JOB_KIND) to the lifecycle hooks the hub
// should evaluate when planning a job's SkillPlan (TDD §6.5 SkillPlanItem).
// Hub/jobs/skill-plan.js consumes this table; SkillsRegistry (SH-5-02)
// resolves any referenced skillIds at run time.
//
// What this module is responsible for:
//   - Declaring the five built-in profiles required by the SH-5-03 DoD:
//     `code-implementer`, `prd-writer`, `reviewer`, `planner`, `closeout`.
//     The first three are verbatim from TDD §11.3; the latter two are
//     extrapolations the DoD names but the YAML does not spell out.
//   - Validating each profile's shape at module load: every hook key must be
//     a valid SkillPhase (§6.5); every entry must carry a non-empty skillId,
//     and `required` / `everyMinutes` (when present) must be the right type.
//   - Deep-freezing the exported profiles + nested arrays/objects so callers
//     cannot mutate the catalog after import.
//   - Exposing a small lookup surface (`BUILT_IN_PROFILES`,
//     `BUILT_IN_PROFILES_BY_ID`, `getProfile`, `validateProfile`) and the
//     `ALLOWED_PROFILE_PHASES` enum.
//
// What this module does NOT do:
//   - Resolve skillIds against the SkillsRegistry. Some hook entries reference
//     skills that intentionally are NOT registered yet (e.g. `prd.quality_review`,
//     `lt.changed_since`). The skill-plan generator still emits SkillPlanItems
//     for them; resolution failure is the run-time layer's problem.
//   - Compose the full SkillPlan (precedence with skill defaultPhases lives in
//     hub/jobs/skill-plan.js).
//   - Persist or hot-reload profiles. The catalog is rebuilt in-process on
//     startup; user-supplied profiles can be passed directly to buildSkillPlan.

import { ALLOWED_JOB_KIND } from "./registry.js";

/**
 * @typedef {"before_start" | "on_start" | "checkpoint" | "on_quiet" | "on_blocked" | "before_complete" | "after_complete" | "on_rollover" | "on_resume"} SkillPhase
 */

/**
 * @typedef {object} JobProfileHookEntry
 * @property {string} skillId
 * @property {boolean} [required]
 * @property {number} [everyMinutes]
 */

/**
 * @typedef {object} JobProfile
 * @property {string} id
 * @property {import("./registry.js").JobKind} kind
 * @property {{ [phase in SkillPhase]?: JobProfileHookEntry[] }} hooks
 */

/**
 * TDD §6.5 SkillPhase enum. Mirrored from hub/skills/registry.js — kept local
 * so profiles can validate themselves without importing the skills registry
 * (no cyclic dep between jobs and skills).
 */
export const ALLOWED_PROFILE_PHASES = Object.freeze([
  "before_start",
  "on_start",
  "checkpoint",
  "on_quiet",
  "on_blocked",
  "before_complete",
  "after_complete",
  "on_rollover",
  "on_resume",
]);

/**
 * Build a profiles-shaped Error. Stable `.code` for callers.
 *
 * @param {string} message
 * @param {string} code
 * @param {object} [details]
 * @returns {Error & { code: string; details?: object }}
 */
function makeError(message, code, details) {
  const err = /** @type {any} */ (new Error(message));
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Validate + freeze a single hook entry.
 *
 * @param {unknown} raw
 * @param {string} context
 * @returns {JobProfileHookEntry}
 */
function normalizeHookEntry(raw, context) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw makeError(`${context}: hook entry must be an object`, "INVALID_PROFILE_HOOK_ENTRY");
  }
  const entry = /** @type {JobProfileHookEntry} */ (raw);
  if (typeof entry.skillId !== "string" || entry.skillId.length === 0) {
    throw makeError(
      `${context}: hook entry skillId required (non-empty string)`,
      "INVALID_PROFILE_HOOK_ENTRY",
      { field: "skillId" },
    );
  }
  if (entry.required !== undefined && typeof entry.required !== "boolean") {
    throw makeError(
      `${context}: hook entry 'required' must be a boolean when present`,
      "INVALID_PROFILE_HOOK_ENTRY",
      { field: "required" },
    );
  }
  if (entry.everyMinutes !== undefined) {
    if (typeof entry.everyMinutes !== "number" || !Number.isFinite(entry.everyMinutes) || entry.everyMinutes <= 0) {
      throw makeError(
        `${context}: hook entry 'everyMinutes' must be a positive number when present`,
        "INVALID_PROFILE_HOOK_ENTRY",
        { field: "everyMinutes" },
      );
    }
  }
  /** @type {JobProfileHookEntry} */
  const normalized = { skillId: entry.skillId };
  if (entry.required !== undefined) normalized.required = entry.required;
  if (entry.everyMinutes !== undefined) normalized.everyMinutes = entry.everyMinutes;
  return /** @type {JobProfileHookEntry} */ (Object.freeze(normalized));
}

/**
 * Validate a raw JobProfile and return a deeply-frozen clone. Throws with
 * `.code` on the first invariant violation.
 *
 * @param {unknown} raw
 * @returns {JobProfile}
 */
export function validateProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw makeError("validateProfile: profile must be an object", "INVALID_PROFILE");
  }
  const p = /** @type {JobProfile} */ (raw);
  const context = `validateProfile('${typeof p.id === "string" ? p.id : "<no-id>"}')`;
  if (typeof p.id !== "string" || p.id.length === 0) {
    throw makeError(`${context}: id required (non-empty string)`, "INVALID_PROFILE", { field: "id" });
  }
  if (typeof p.kind !== "string" || !ALLOWED_JOB_KIND.includes(/** @type {any} */ (p.kind))) {
    throw makeError(
      `${context}: kind '${p.kind}' not in ${ALLOWED_JOB_KIND.join("|")}`,
      "INVALID_PROFILE_KIND",
      { kind: p.kind, allowed: [...ALLOWED_JOB_KIND] },
    );
  }
  if (!p.hooks || typeof p.hooks !== "object" || Array.isArray(p.hooks)) {
    throw makeError(`${context}: hooks must be an object`, "INVALID_PROFILE", { field: "hooks" });
  }

  /** @type {{ [phase: string]: JobProfileHookEntry[] }} */
  const hooks = {};
  for (const phase of Object.keys(p.hooks)) {
    if (!ALLOWED_PROFILE_PHASES.includes(/** @type {SkillPhase} */ (phase))) {
      throw makeError(
        `${context}: hook key '${phase}' not in ${ALLOWED_PROFILE_PHASES.join("|")}`,
        "INVALID_PROFILE_PHASE",
        { phase, allowed: [...ALLOWED_PROFILE_PHASES] },
      );
    }
    const entries = /** @type {any} */ (p.hooks)[phase];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw makeError(
        `${context}: hooks.${phase} must be a non-empty array`,
        "INVALID_PROFILE",
        { field: `hooks.${phase}` },
      );
    }
    hooks[phase] = Object.freeze(
      entries.map((entry, idx) => normalizeHookEntry(entry, `${context}.hooks.${phase}[${idx}]`)),
    );
  }

  return /** @type {JobProfile} */ (Object.freeze({
    id: p.id,
    kind: p.kind,
    hooks: Object.freeze(hooks),
  }));
}

/**
 * Raw profile declarations. Validated + frozen below before export so any
 * shape regression is caught at module load.
 *
 * Cross-skill notes:
 *   - `prd.quality_review` and `lt.changed_since` are external (not yet
 *     registered) skills — TDD §11.3 names them but SH-5-02 only shipped the
 *     five lt.* built-ins. The skill-plan generator still emits SkillPlanItems
 *     for them; the run-time layer will surface UNKNOWN_SKILL when resolution
 *     fails.
 */
const RAW_PROFILES = [
  // code-implementer — verbatim from TDD §11.3.
  {
    id: "code-implementer",
    kind: "code",
    hooks: {
      before_start: [{ skillId: "lt.execute_scope", required: true }],
      checkpoint: [{ skillId: "lt.status_heartbeat", everyMinutes: 5 }],
      before_complete: [{ skillId: "lt.verify", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep", required: true }],
    },
  },
  // prd-writer — verbatim from TDD §11.3.
  // NOTE: prd.quality_review is an external skill (not yet in SkillsRegistry).
  {
    id: "prd-writer",
    kind: "prd",
    hooks: {
      before_start: [{ skillId: "lt.task_planner" }],
      before_complete: [{ skillId: "prd.quality_review", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  },
  // reviewer — verbatim from TDD §11.3.
  // NOTE: lt.changed_since is an external skill (not yet in SkillsRegistry).
  {
    id: "reviewer",
    kind: "review",
    hooks: {
      before_start: [{ skillId: "lt.changed_since" }],
      before_complete: [{ skillId: "lt.verify", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  },
  // planner — extrapolated; mirrors code-implementer's spirit but centered
  // on planning. Required by SH-5-03 DoD.
  {
    id: "planner",
    kind: "planning",
    hooks: {
      before_start: [{ skillId: "lt.task_planner", required: true }],
      checkpoint: [{ skillId: "lt.status_heartbeat", everyMinutes: 5 }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  },
  // closeout — extrapolated; exists to run a final sweep. Required by
  // SH-5-03 DoD.
  {
    id: "closeout",
    kind: "closeout",
    hooks: {
      before_start: [{ skillId: "lt.closeout_sweep", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  },
];

/** All built-in profiles, validated + deep-frozen, in declaration order. */
export const BUILT_IN_PROFILES = Object.freeze(RAW_PROFILES.map(validateProfile));

/** Lookup index over BUILT_IN_PROFILES. */
export const BUILT_IN_PROFILES_BY_ID = new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]));

/**
 * Look up a built-in profile by id. Returns null when no such profile exists
 * so callers don't have to try/catch.
 *
 * @param {string} id
 * @returns {JobProfile | null}
 */
export function getProfile(id) {
  if (typeof id !== "string") return null;
  return BUILT_IN_PROFILES_BY_ID.get(id) || null;
}
