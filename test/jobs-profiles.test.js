// test/jobs-profiles.test.js — SH-5-03 (TDD v0.5 §11.3, §6.4, §6.5)
//
// Acceptance suite for the built-in JobProfile catalog (hub/jobs/profiles.js).
// Verifies shape invariants, deep-freeze, and the verbatim hook entries from
// TDD §11.3 plus the extrapolated planner/closeout profiles required by the
// SH-5-03 DoD.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_PROFILES,
  BUILT_IN_PROFILES_BY_ID,
  ALLOWED_PROFILE_PHASES,
  getProfile,
  validateProfile,
} from "../hub/jobs/profiles.js";
import { ALLOWED_JOB_KIND } from "../hub/jobs/registry.js";

const EXPECTED_IDS = ["code-implementer", "prd-writer", "reviewer", "planner", "closeout"];
const EXPECTED_KINDS_BY_ID = {
  "code-implementer": "code",
  "prd-writer": "prd",
  reviewer: "review",
  planner: "planning",
  closeout: "closeout",
};

// --- catalog shape ---------------------------------------------------------

test("BUILT_IN_PROFILES: exposes exactly five profiles in declaration order", () => {
  const ids = BUILT_IN_PROFILES.map((p) => p.id);
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(BUILT_IN_PROFILES.length, EXPECTED_IDS.length);
});

test("BUILT_IN_PROFILES: each profile has the expected id and kind; every kind is in ALLOWED_JOB_KIND", () => {
  for (const profile of BUILT_IN_PROFILES) {
    assert.equal(profile.kind, EXPECTED_KINDS_BY_ID[profile.id], `${profile.id}: kind`);
    assert.ok(ALLOWED_JOB_KIND.includes(profile.kind), `${profile.id}: kind '${profile.kind}' in ALLOWED_JOB_KIND`);
  }
});

test("getProfile(): returns the right object; unknown id returns null", () => {
  for (const id of EXPECTED_IDS) {
    const profile = getProfile(id);
    assert.ok(profile, `getProfile('${id}')`);
    assert.equal(profile.id, id);
  }
  assert.equal(getProfile("does-not-exist"), null);
  assert.equal(getProfile(undefined), null);
  assert.equal(getProfile(42), null);
});

test("BUILT_IN_PROFILES_BY_ID: mirrors BUILT_IN_PROFILES", () => {
  assert.equal(BUILT_IN_PROFILES_BY_ID.size, BUILT_IN_PROFILES.length);
  for (const profile of BUILT_IN_PROFILES) {
    assert.equal(BUILT_IN_PROFILES_BY_ID.get(profile.id), profile);
  }
});

test("BUILT_IN_PROFILES: every hook key is in the SkillPhase enum", () => {
  for (const profile of BUILT_IN_PROFILES) {
    for (const phase of Object.keys(profile.hooks)) {
      assert.ok(
        ALLOWED_PROFILE_PHASES.includes(phase),
        `${profile.id}: hook key '${phase}' must be in ALLOWED_PROFILE_PHASES`,
      );
    }
  }
});

test("BUILT_IN_PROFILES: every hook entry has a non-empty skillId and correct types for required/everyMinutes", () => {
  for (const profile of BUILT_IN_PROFILES) {
    for (const phase of Object.keys(profile.hooks)) {
      for (const entry of profile.hooks[phase]) {
        assert.equal(typeof entry.skillId, "string", `${profile.id}.${phase}: skillId is string`);
        assert.ok(entry.skillId.length > 0, `${profile.id}.${phase}: skillId non-empty`);
        if (entry.required !== undefined) {
          assert.equal(typeof entry.required, "boolean", `${profile.id}.${phase}: required is boolean`);
        }
        if (entry.everyMinutes !== undefined) {
          assert.equal(typeof entry.everyMinutes, "number", `${profile.id}.${phase}: everyMinutes is number`);
          assert.ok(entry.everyMinutes > 0, `${profile.id}.${phase}: everyMinutes positive`);
        }
      }
    }
  }
});

// --- deep freeze -----------------------------------------------------------

test("BUILT_IN_PROFILES: profiles + hooks + entries are deeply frozen", () => {
  for (const profile of BUILT_IN_PROFILES) {
    assert.equal(Object.isFrozen(profile), true, `${profile.id}: profile frozen`);
    assert.equal(Object.isFrozen(profile.hooks), true, `${profile.id}: hooks frozen`);
    for (const phase of Object.keys(profile.hooks)) {
      assert.equal(Object.isFrozen(profile.hooks[phase]), true, `${profile.id}.${phase}: array frozen`);
      for (const entry of profile.hooks[phase]) {
        assert.equal(Object.isFrozen(entry), true, `${profile.id}.${phase}: entry frozen`);
      }
    }
  }
});

test("BUILT_IN_PROFILES: mutation attempts throw in strict mode", () => {
  "use strict";
  const profile = getProfile("code-implementer");
  assert.throws(() => {
    profile.hooks.before_start.push({ skillId: "evil.skill" });
  });
  assert.throws(() => {
    profile.hooks.before_start[0].required = false;
  });
  assert.throws(() => {
    profile.kind = "review";
  });
});

// --- verbatim contents -----------------------------------------------------

test("code-implementer: carries the four hook entries from TDD §11.3 verbatim", () => {
  const profile = getProfile("code-implementer");
  assert.deepEqual(
    { ...profile.hooks },
    {
      before_start: [{ skillId: "lt.execute_scope", required: true }],
      checkpoint: [{ skillId: "lt.status_heartbeat", everyMinutes: 5 }],
      before_complete: [{ skillId: "lt.verify", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep", required: true }],
    },
  );
});

test("prd-writer: carries the three hook entries from TDD §11.3 verbatim", () => {
  const profile = getProfile("prd-writer");
  assert.deepEqual(
    { ...profile.hooks },
    {
      before_start: [{ skillId: "lt.task_planner" }],
      before_complete: [{ skillId: "prd.quality_review", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  );
});

test("reviewer: carries the three hook entries from TDD §11.3 verbatim", () => {
  const profile = getProfile("reviewer");
  assert.deepEqual(
    { ...profile.hooks },
    {
      before_start: [{ skillId: "lt.changed_since" }],
      before_complete: [{ skillId: "lt.verify", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  );
});

test("planner: carries the extrapolated hook entries (snapshot)", () => {
  const profile = getProfile("planner");
  assert.deepEqual(
    { ...profile.hooks },
    {
      before_start: [{ skillId: "lt.task_planner", required: true }],
      checkpoint: [{ skillId: "lt.status_heartbeat", everyMinutes: 5 }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  );
});

test("closeout: carries the extrapolated hook entries (snapshot)", () => {
  const profile = getProfile("closeout");
  assert.deepEqual(
    { ...profile.hooks },
    {
      before_start: [{ skillId: "lt.closeout_sweep", required: true }],
      after_complete: [{ skillId: "lt.closeout_sweep" }],
    },
  );
});

// --- validateProfile() ------------------------------------------------------

test("validateProfile(): rejects malformed custom profiles with .code", () => {
  // missing id
  let err;
  try {
    validateProfile({ kind: "code", hooks: {} });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_PROFILE");

  // bad kind
  err = undefined;
  try {
    validateProfile({ id: "p", kind: "no-such-kind", hooks: {} });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_PROFILE_KIND");

  // bad phase
  err = undefined;
  try {
    validateProfile({ id: "p", kind: "code", hooks: { never_happens: [{ skillId: "lt.x" }] } });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_PROFILE_PHASE");

  // empty hook entries
  err = undefined;
  try {
    validateProfile({ id: "p", kind: "code", hooks: { before_start: [] } });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_PROFILE");

  // missing skillId
  err = undefined;
  try {
    validateProfile({ id: "p", kind: "code", hooks: { before_start: [{ skillId: "" }] } });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_PROFILE_HOOK_ENTRY");

  // bad required type
  err = undefined;
  try {
    validateProfile({ id: "p", kind: "code", hooks: { before_start: [{ skillId: "lt.x", required: "yes" }] } });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_PROFILE_HOOK_ENTRY");

  // bad everyMinutes
  err = undefined;
  try {
    validateProfile({ id: "p", kind: "code", hooks: { checkpoint: [{ skillId: "lt.x", everyMinutes: -1 }] } });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_PROFILE_HOOK_ENTRY");
});

test("validateProfile(): accepts a well-formed custom profile and freezes it", () => {
  const profile = validateProfile({
    id: "custom",
    kind: "custom",
    hooks: {
      before_start: [{ skillId: "x.skill", required: true }],
      checkpoint: [{ skillId: "y.skill", everyMinutes: 10 }],
    },
  });
  assert.equal(profile.id, "custom");
  assert.equal(profile.kind, "custom");
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.hooks), true);
  assert.equal(Object.isFrozen(profile.hooks.before_start), true);
  assert.equal(Object.isFrozen(profile.hooks.before_start[0]), true);
});

// --- ALLOWED_PROFILE_PHASES exposure ---------------------------------------

test("ALLOWED_PROFILE_PHASES: matches TDD §6.5 SkillPhase order and is frozen", () => {
  assert.deepEqual(
    [...ALLOWED_PROFILE_PHASES],
    [
      "before_start",
      "on_start",
      "checkpoint",
      "on_quiet",
      "on_blocked",
      "before_complete",
      "after_complete",
      "on_rollover",
      "on_resume",
    ],
  );
  assert.throws(() => {
    ALLOWED_PROFILE_PHASES.push("nope");
  });
});
