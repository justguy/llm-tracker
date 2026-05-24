// hub/jobs/skill-plan.js — SH-5-03 (TDD v0.5 §6.4, §6.5, §11.3)
//
// Compose a SkillPlan (an ordered array of §6.5 SkillPlanItems) for a single
// JobProfile. The plan is what hub/jobs/registry.js (SH-5-01) stamps onto a
// JobRecord at create time so the lifecycle pipeline knows which skills to
// invoke at which phase.
//
// What this module is responsible for:
//   - Resolving a profileId against a supplied profile map (default:
//     BUILT_IN_PROFILES_BY_ID from hub/jobs/profiles.js).
//   - Walking the profile's hooks in TDD §6.5 phase order (before_start →
//     on_start → checkpoint → on_quiet → on_blocked → before_complete →
//     after_complete → on_rollover → on_resume) and emitting one
//     SkillPlanItem per hook entry: { id, skillId, phase, required, status }.
//     `status` is always "pending" for a freshly-generated plan; `runId` and
//     `source` are intentionally omitted (the run stamps them later).
//   - Appending skill-default fillers: for every skill registered in the
//     SkillsRegistry, emit a SkillPlanItem at each of its `defaultPhases`
//     unless the profile already claimed that exact (skillId, phase) pair.
//   - Honouring the **profile-wins-on-conflict** rule:
//
//       If both the profile and the skill's defaultPhases reference the same
//       (skillId, phase) combination, the profile's entry — including its
//       `required` flag — wins; the skill default for that combo is dropped.
//
//     Worked example: profile `code-implementer` claims `lt.closeout_sweep`
//     at `after_complete` with `required: true`. The skill `lt.closeout_sweep`
//     also lists `after_complete` in its defaultPhases. The output contains
//     a single SkillPlanItem for (`lt.closeout_sweep`, `after_complete`) with
//     `required: true` — the skill-default duplicate is NOT emitted.
//
// What this module does NOT do:
//   - Verify-pack composition (SH-5-04 owns hub/jobs/verify-pack.js).
//   - Gate stamping (SH-5-04 / SH-5-09 territory).
//   - Run skills or emit RuntimeEvents (run-time / adapter layer).
//   - Generate ids — `makeId` is a required dependency so golden fixtures /
//     replay paths stay deterministic.

import { BUILT_IN_PROFILES_BY_ID, ALLOWED_PROFILE_PHASES } from "./profiles.js";

/**
 * @typedef {import("./profiles.js").JobProfile} JobProfile
 * @typedef {import("./profiles.js").JobProfileHookEntry} JobProfileHookEntry
 */

/**
 * @typedef {object} SkillsRegistryLike
 * @property {() => Array<{ id: string; defaultPhases: ReadonlyArray<string> }>} list
 */

/**
 * @typedef {object} SkillPlanItem
 * @property {string} id
 * @property {string} skillId
 * @property {string} phase
 * @property {boolean} required
 * @property {"pending"} status
 */

/**
 * Build a skill-plan-shaped Error. Stable `.code` for callers.
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
 * Build a SkillPlan for a JobProfile.
 *
 * @param {object} args
 * @param {string} args.profileId
 * @param {SkillsRegistryLike} args.skillsRegistry
 * @param {() => string} args.makeId
 * @param {Map<string, JobProfile>} [args.profiles]
 * @returns {SkillPlanItem[]}
 */
export function buildSkillPlan(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw makeError("buildSkillPlan: args must be an object", "INVALID_INPUT");
  }
  const { profileId, skillsRegistry, makeId, profiles = BUILT_IN_PROFILES_BY_ID } = args;

  if (typeof profileId !== "string" || profileId.length === 0) {
    throw makeError("buildSkillPlan: profileId required (non-empty string)", "INVALID_INPUT", { field: "profileId" });
  }
  if (!profiles || typeof profiles.get !== "function") {
    throw makeError(
      "buildSkillPlan: profiles must be a Map-like with .get()",
      "INVALID_INPUT",
      { field: "profiles" },
    );
  }
  if (!skillsRegistry || typeof skillsRegistry.list !== "function") {
    throw makeError(
      "buildSkillPlan: skillsRegistry must expose .list()",
      "INVALID_INPUT",
      { field: "skillsRegistry" },
    );
  }
  if (typeof makeId !== "function") {
    throw makeError("buildSkillPlan: makeId function required", "INVALID_INPUT", { field: "makeId" });
  }

  const profile = profiles.get(profileId);
  if (!profile) {
    throw makeError(
      `buildSkillPlan: unknown profile '${profileId}'`,
      "UNKNOWN_PROFILE",
      { profileId },
    );
  }

  /** @type {SkillPlanItem[]} */
  const out = [];
  /** @type {Set<string>} */
  const claimed = new Set();

  // Phase 1: profile-emitted items, in TDD §6.5 phase order, then declaration
  // order within each phase.
  for (const phase of ALLOWED_PROFILE_PHASES) {
    const entries = profile.hooks[phase];
    if (!entries || entries.length === 0) continue;
    for (const entry of entries) {
      claimed.add(`${entry.skillId}::${phase}`);
      out.push({
        id: makeId(),
        skillId: entry.skillId,
        phase,
        required: entry.required === true,
        status: "pending",
      });
    }
  }

  // Phase 2: skill-default fillers, in TDD §6.5 phase order across skills,
  // skill-declaration order within each phase. Profile-claimed combos are
  // skipped — profile wins on conflict.
  const skills = skillsRegistry.list();
  for (const phase of ALLOWED_PROFILE_PHASES) {
    for (const skill of skills) {
      if (!Array.isArray(skill.defaultPhases)) continue;
      if (!skill.defaultPhases.includes(phase)) continue;
      const key = `${skill.id}::${phase}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      out.push({
        id: makeId(),
        skillId: skill.id,
        phase,
        required: false,
        status: "pending",
      });
    }
  }

  return out;
}
