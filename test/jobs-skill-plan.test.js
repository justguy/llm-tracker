// test/jobs-skill-plan.test.js — SH-5-03 (TDD v0.5 §6.5, §11.3)
//
// Acceptance suite for hub/jobs/skill-plan.js. Drives the generator with a
// counter-based makeId so golden fixtures stay deterministic, then asserts
// the full plan for each of the five built-in profiles plus the
// profile-wins-on-conflict and skill-default filler edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSkillPlan } from "../hub/jobs/skill-plan.js";
import { BUILT_IN_PROFILES_BY_ID, validateProfile } from "../hub/jobs/profiles.js";
import { SkillsRegistry } from "../hub/skills/registry.js";

function makeCounterId() {
  let i = 0;
  return () => `spi_${(++i).toString().padStart(2, "0")}`;
}

function pending(id, skillId, phase, required) {
  return { id, skillId, phase, required, status: "pending" };
}

// --- error path ------------------------------------------------------------

test("buildSkillPlan(): unknown profile rejects with .code 'UNKNOWN_PROFILE'", () => {
  const skillsRegistry = new SkillsRegistry();
  let err;
  try {
    buildSkillPlan({ profileId: "no-such-profile", skillsRegistry, makeId: makeCounterId() });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "UNKNOWN_PROFILE");
  assert.match(err.message, /unknown profile/);
});

test("buildSkillPlan(): missing required arg throws INVALID_INPUT", () => {
  const skillsRegistry = new SkillsRegistry();
  assert.throws(
    () => buildSkillPlan({ profileId: "code-implementer", skillsRegistry }),
    /makeId function required/,
  );
  assert.throws(
    () => buildSkillPlan({ profileId: "code-implementer", makeId: makeCounterId() }),
    /skillsRegistry/,
  );
  assert.throws(
    () => buildSkillPlan({ skillsRegistry, makeId: makeCounterId() }),
    /profileId required/,
  );
});

// --- golden fixtures (one per built-in profile) ----------------------------

test("buildSkillPlan('code-implementer'): matches golden fixture", () => {
  const skillsRegistry = new SkillsRegistry();
  const plan = buildSkillPlan({
    profileId: "code-implementer",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  assert.deepEqual(plan, [
    // Profile-emitted, in §6.5 phase order:
    pending("spi_01", "lt.execute_scope", "before_start", true),
    pending("spi_02", "lt.status_heartbeat", "checkpoint", false),
    pending("spi_03", "lt.verify", "before_complete", true),
    pending("spi_04", "lt.closeout_sweep", "after_complete", true),
    // Skill-default fillers — profile-claimed combos are dropped:
    //   skipped: lt.execute_scope::before_start (profile-claimed)
    //   skipped: lt.status_heartbeat::checkpoint (profile-claimed)
    //   skipped: lt.verify::before_complete (profile-claimed)
    //   skipped: lt.closeout_sweep::after_complete (profile-claimed)
    pending("spi_05", "lt.task_planner", "before_start", false),
    pending("spi_06", "lt.closeout_sweep", "before_complete", false),
    pending("spi_07", "lt.task_planner", "after_complete", false),
    pending("spi_08", "lt.closeout_sweep", "on_rollover", false),
  ]);
});

test("buildSkillPlan('prd-writer'): matches golden fixture", () => {
  const skillsRegistry = new SkillsRegistry();
  const plan = buildSkillPlan({
    profileId: "prd-writer",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  assert.deepEqual(plan, [
    // Profile-emitted:
    pending("spi_01", "lt.task_planner", "before_start", false),
    pending("spi_02", "prd.quality_review", "before_complete", true),
    pending("spi_03", "lt.closeout_sweep", "after_complete", false),
    // Skill-default fillers:
    pending("spi_04", "lt.execute_scope", "before_start", false),
    pending("spi_05", "lt.status_heartbeat", "checkpoint", false),
    pending("spi_06", "lt.closeout_sweep", "before_complete", false),
    pending("spi_07", "lt.verify", "before_complete", false),
    pending("spi_08", "lt.task_planner", "after_complete", false),
    pending("spi_09", "lt.closeout_sweep", "on_rollover", false),
  ]);
});

test("buildSkillPlan('reviewer'): matches golden fixture", () => {
  const skillsRegistry = new SkillsRegistry();
  const plan = buildSkillPlan({
    profileId: "reviewer",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  assert.deepEqual(plan, [
    // Profile-emitted:
    pending("spi_01", "lt.changed_since", "before_start", false),
    pending("spi_02", "lt.verify", "before_complete", true),
    pending("spi_03", "lt.closeout_sweep", "after_complete", false),
    // Skill-default fillers:
    pending("spi_04", "lt.execute_scope", "before_start", false),
    pending("spi_05", "lt.task_planner", "before_start", false),
    pending("spi_06", "lt.status_heartbeat", "checkpoint", false),
    pending("spi_07", "lt.closeout_sweep", "before_complete", false),
    pending("spi_08", "lt.task_planner", "after_complete", false),
    pending("spi_09", "lt.closeout_sweep", "on_rollover", false),
  ]);
});

test("buildSkillPlan('planner'): matches golden fixture", () => {
  const skillsRegistry = new SkillsRegistry();
  const plan = buildSkillPlan({
    profileId: "planner",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  assert.deepEqual(plan, [
    // Profile-emitted:
    pending("spi_01", "lt.task_planner", "before_start", true),
    pending("spi_02", "lt.status_heartbeat", "checkpoint", false),
    pending("spi_03", "lt.closeout_sweep", "after_complete", false),
    // Skill-default fillers:
    pending("spi_04", "lt.execute_scope", "before_start", false),
    pending("spi_05", "lt.closeout_sweep", "before_complete", false),
    pending("spi_06", "lt.verify", "before_complete", false),
    pending("spi_07", "lt.task_planner", "after_complete", false),
    pending("spi_08", "lt.closeout_sweep", "on_rollover", false),
  ]);
});

test("buildSkillPlan('closeout'): matches golden fixture", () => {
  const skillsRegistry = new SkillsRegistry();
  const plan = buildSkillPlan({
    profileId: "closeout",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  assert.deepEqual(plan, [
    // Profile-emitted:
    pending("spi_01", "lt.closeout_sweep", "before_start", true),
    pending("spi_02", "lt.closeout_sweep", "after_complete", false),
    // Skill-default fillers:
    pending("spi_03", "lt.execute_scope", "before_start", false),
    pending("spi_04", "lt.task_planner", "before_start", false),
    pending("spi_05", "lt.status_heartbeat", "checkpoint", false),
    pending("spi_06", "lt.closeout_sweep", "before_complete", false),
    pending("spi_07", "lt.verify", "before_complete", false),
    pending("spi_08", "lt.task_planner", "after_complete", false),
    pending("spi_09", "lt.closeout_sweep", "on_rollover", false),
  ]);
});

// --- profile-wins-on-conflict regression -----------------------------------

test("profile-wins: profile's required flag overrides skill default for the same (skillId, phase)", () => {
  // lt.execute_scope's defaultPhases includes before_start. A custom profile
  // claims that same combo with required:false. The plan must contain
  // exactly ONE SkillPlanItem for that combo, with required:false.
  const profiles = new Map([
    [
      "conflict",
      validateProfile({
        id: "conflict",
        kind: "code",
        hooks: {
          before_start: [{ skillId: "lt.execute_scope", required: false }],
        },
      }),
    ],
  ]);
  const skillsRegistry = new SkillsRegistry();
  const plan = buildSkillPlan({
    profileId: "conflict",
    skillsRegistry,
    makeId: makeCounterId(),
    profiles,
  });
  const matches = plan.filter((item) => item.skillId === "lt.execute_scope" && item.phase === "before_start");
  assert.equal(matches.length, 1, "single entry for the conflict combo");
  assert.equal(matches[0].required, false, "profile's required:false wins");
});

// --- skill-default filler regression ---------------------------------------

test("skill-default filler: an empty profile still picks up skill defaultPhases as required:false", () => {
  const profiles = new Map([
    [
      "empty",
      validateProfile({
        id: "empty",
        kind: "custom",
        hooks: {},
      }),
    ],
  ]);
  const skillsRegistry = new SkillsRegistry({
    definitions: [
      {
        id: "x.test",
        title: "Test Skill",
        description: "Filler test skill.",
        appliesTo: ["task_backed"],
        defaultPhases: ["checkpoint"],
        adapters: { codexSkill: { shortcut: "$x" } },
      },
    ],
  });
  const plan = buildSkillPlan({
    profileId: "empty",
    skillsRegistry,
    makeId: makeCounterId(),
    profiles,
  });
  assert.deepEqual(plan, [pending("spi_01", "x.test", "checkpoint", false)]);
});

// --- external-skill survival -----------------------------------------------

test("external skills survive plan generation (prd-writer includes prd.quality_review)", () => {
  const skillsRegistry = new SkillsRegistry();
  // SkillsRegistry should NOT contain prd.quality_review (SH-5-02 only ships lt.*).
  assert.equal(skillsRegistry.has("prd.quality_review"), false);
  const plan = buildSkillPlan({
    profileId: "prd-writer",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  const externalEntry = plan.find((item) => item.skillId === "prd.quality_review");
  assert.ok(externalEntry, "prd.quality_review SkillPlanItem present");
  assert.equal(externalEntry.phase, "before_complete");
  assert.equal(externalEntry.required, true);
  assert.equal(externalEntry.status, "pending");
});

// --- determinism -----------------------------------------------------------

test("buildSkillPlan(): two invocations with fresh counter ids yield structurally identical output", () => {
  const skillsRegistry = new SkillsRegistry();
  const planA = buildSkillPlan({
    profileId: "code-implementer",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  const planB = buildSkillPlan({
    profileId: "code-implementer",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  assert.deepEqual(planA, planB);
});

// --- phase ordering --------------------------------------------------------

test("buildSkillPlan(): phase field appears in TDD §6.5 phase order across plan", () => {
  const skillsRegistry = new SkillsRegistry();
  const PHASE_ORDER = [
    "before_start",
    "on_start",
    "checkpoint",
    "on_quiet",
    "on_blocked",
    "before_complete",
    "after_complete",
    "on_rollover",
    "on_resume",
  ];
  for (const profileId of ["code-implementer", "prd-writer", "reviewer", "planner", "closeout"]) {
    const plan = buildSkillPlan({ profileId, skillsRegistry, makeId: makeCounterId() });
    // Within the profile-emitted block, phases are non-decreasing in PHASE_ORDER.
    // Same for the filler block. Concretely: the merge places all
    // profile-emitted items first (in phase order) then all fillers (in phase order).
    // We assert: when we walk the plan, the phase index across the
    // profile-emitted prefix and again across the filler suffix is monotonic.
    const profileHooks = BUILT_IN_PROFILES_BY_ID.get(profileId).hooks;
    const profileEntryCount = Object.values(profileHooks).reduce((n, list) => n + list.length, 0);
    let prevIdx = -1;
    for (let i = 0; i < profileEntryCount; i += 1) {
      const idx = PHASE_ORDER.indexOf(plan[i].phase);
      assert.ok(idx >= prevIdx, `${profileId}: profile-block phase order at i=${i}`);
      prevIdx = idx;
    }
    prevIdx = -1;
    for (let i = profileEntryCount; i < plan.length; i += 1) {
      const idx = PHASE_ORDER.indexOf(plan[i].phase);
      assert.ok(idx >= prevIdx, `${profileId}: filler-block phase order at i=${i}`);
      prevIdx = idx;
    }
  }
});

// --- default profiles wiring -----------------------------------------------

test("buildSkillPlan(): defaults to BUILT_IN_PROFILES_BY_ID when no profiles arg supplied", () => {
  const skillsRegistry = new SkillsRegistry();
  const planA = buildSkillPlan({
    profileId: "closeout",
    skillsRegistry,
    makeId: makeCounterId(),
  });
  const planB = buildSkillPlan({
    profileId: "closeout",
    skillsRegistry,
    makeId: makeCounterId(),
    profiles: BUILT_IN_PROFILES_BY_ID,
  });
  assert.deepEqual(planA, planB);
});
