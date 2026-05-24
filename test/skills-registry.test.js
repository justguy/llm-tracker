// test/skills-registry.test.js — SH-5-02 (TDD v0.5 §11.1, §11.2, §6.5)
//
// Acceptance suite for SkillsRegistry. Exercises the built-in catalog plus
// register()'s validation surface against user-supplied definitions.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SkillsRegistry,
  BUILT_IN_SKILLS,
  ALLOWED_SKILL_PHASES,
  ALLOWED_SKILL_ADAPTER_KINDS,
} from "../hub/skills/registry.js";

const BUILT_IN_IDS = [
  "lt.execute_scope",
  "lt.closeout_sweep",
  "lt.task_planner",
  "lt.verify",
  "lt.status_heartbeat",
];

function customSkill(overrides = {}) {
  return {
    id: "custom.skill",
    title: "Custom Skill",
    description: "User-supplied skill for tests.",
    appliesTo: ["task_backed"],
    defaultPhases: ["before_start"],
    adapters: {
      codexSkill: { shortcut: "$custom" },
    },
    ...overrides,
  };
}

// --- enums + exports --------------------------------------------------------

test("SkillsRegistry: exports frozen §6.5 phase enum", () => {
  assert.deepEqual(
    [...ALLOWED_SKILL_PHASES],
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
    ALLOWED_SKILL_PHASES.push("nope");
  });
});

test("SkillsRegistry: exports frozen §11.1 adapter-kind enum", () => {
  assert.deepEqual(
    [...ALLOWED_SKILL_ADAPTER_KINDS],
    ["codexSkill", "mcpPrompt", "promptTemplate", "httpAction"],
  );
  assert.throws(() => {
    ALLOWED_SKILL_ADAPTER_KINDS.push("nope");
  });
});

// --- constructor / built-ins ------------------------------------------------

test("SkillsRegistry: constructor() loads all five built-ins in declaration order", () => {
  const reg = new SkillsRegistry();
  const ids = reg.list().map((s) => s.id);
  assert.deepEqual(ids, BUILT_IN_IDS);
  assert.equal(BUILT_IN_SKILLS.length, BUILT_IN_IDS.length);
});

test("SkillsRegistry: has()/get() round-trip; unknown ids return false/null", () => {
  const reg = new SkillsRegistry();
  for (const id of BUILT_IN_IDS) {
    assert.equal(reg.has(id), true, `has('${id}')`);
    assert.equal(reg.get(id).id, id, `get('${id}').id`);
  }
  assert.equal(reg.has("does.not.exist"), false);
  assert.equal(reg.get("does.not.exist"), null);
  assert.equal(reg.get(undefined), null);
  assert.equal(reg.has(undefined), false);
});

test("SkillsRegistry: every built-in carries the full §11.1 SkillDefinition shape", () => {
  const reg = new SkillsRegistry();
  for (const skill of reg.list()) {
    assert.equal(typeof skill.id, "string");
    assert.ok(skill.id.length > 0, `${skill.id}: id non-empty`);
    assert.equal(typeof skill.title, "string");
    assert.ok(skill.title.length > 0, `${skill.id}: title non-empty`);
    assert.equal(typeof skill.description, "string");
    assert.ok(skill.description.length > 0, `${skill.id}: description non-empty`);
    assert.ok(Array.isArray(skill.appliesTo) && skill.appliesTo.length > 0, `${skill.id}: appliesTo non-empty`);
    assert.ok(
      Array.isArray(skill.defaultPhases) && skill.defaultPhases.length > 0,
      `${skill.id}: defaultPhases non-empty`,
    );
    assert.equal(typeof skill.adapters, "object");
    assert.ok(skill.adapters !== null && !Array.isArray(skill.adapters));
    assert.ok(Object.keys(skill.adapters).length > 0, `${skill.id}: at least one adapter`);
  }
});

test("SkillsRegistry: built-in objects are deeply frozen", () => {
  const reg = new SkillsRegistry();
  for (const skill of reg.list()) {
    assert.equal(Object.isFrozen(skill), true, `${skill.id}: skill frozen`);
    assert.equal(Object.isFrozen(skill.defaultPhases), true, `${skill.id}: defaultPhases frozen`);
    assert.equal(Object.isFrozen(skill.appliesTo), true, `${skill.id}: appliesTo frozen`);
    assert.equal(Object.isFrozen(skill.adapters), true, `${skill.id}: adapters frozen`);
    assert.throws(() => {
      skill.defaultPhases.push("on_quiet");
    });
    assert.throws(() => {
      skill.adapters.codexSkill = { shortcut: "$evil" };
    });
    for (const kind of Object.keys(skill.adapters)) {
      assert.equal(Object.isFrozen(skill.adapters[kind]), true, `${skill.id}: ${kind} adapter frozen`);
    }
  }
});

// --- resolveAdapter ---------------------------------------------------------

test("SkillsRegistry.resolveAdapter: returns descriptor when present, undefined when absent", () => {
  const reg = new SkillsRegistry();

  // lt.execute_scope: codexSkill + mcpPrompt defined; httpAction + promptTemplate absent.
  assert.deepEqual(reg.resolveAdapter("lt.execute_scope", "codexSkill"), { shortcut: "$lt:execute" });
  assert.deepEqual(reg.resolveAdapter("lt.execute_scope", "mcpPrompt"), { tool: "tracker_execute_scope" });
  assert.equal(reg.resolveAdapter("lt.execute_scope", "httpAction"), undefined);
  assert.equal(reg.resolveAdapter("lt.execute_scope", "promptTemplate"), undefined);

  // lt.closeout_sweep
  assert.deepEqual(reg.resolveAdapter("lt.closeout_sweep", "codexSkill"), { shortcut: "$lt:closeout" });
  assert.deepEqual(reg.resolveAdapter("lt.closeout_sweep", "mcpPrompt"), { tool: "tracker_closeout_sweep" });
  assert.equal(reg.resolveAdapter("lt.closeout_sweep", "httpAction"), undefined);

  // lt.task_planner
  assert.deepEqual(reg.resolveAdapter("lt.task_planner", "codexSkill"), { shortcut: "$lt:plan" });
  assert.deepEqual(reg.resolveAdapter("lt.task_planner", "mcpPrompt"), { tool: "tracker_plan_tasks" });

  // lt.verify: httpAction only.
  assert.deepEqual(reg.resolveAdapter("lt.verify", "httpAction"), {
    endpoint: "/api/projects/:slug/tasks/:taskId/verify",
  });
  assert.equal(reg.resolveAdapter("lt.verify", "codexSkill"), undefined);
  assert.equal(reg.resolveAdapter("lt.verify", "mcpPrompt"), undefined);

  // lt.status_heartbeat: mcpPrompt only, hitting tracker_session_context_usage per §13.1.
  assert.deepEqual(reg.resolveAdapter("lt.status_heartbeat", "mcpPrompt"), {
    tool: "tracker_session_context_usage",
  });
  assert.equal(reg.resolveAdapter("lt.status_heartbeat", "codexSkill"), undefined);
  assert.equal(reg.resolveAdapter("lt.status_heartbeat", "httpAction"), undefined);

  // Unknown skill id: undefined (matches missing-adapter behaviour).
  assert.equal(reg.resolveAdapter("does.not.exist", "codexSkill"), undefined);
});

test("SkillsRegistry.resolveAdapter: rejects unknown adapter kinds", () => {
  const reg = new SkillsRegistry();
  assert.throws(
    () => reg.resolveAdapter("lt.execute_scope", "bogus"),
    /kind 'bogus' not in/,
  );
});

// --- phasesFor --------------------------------------------------------------

test("SkillsRegistry.phasesFor: returns declared defaultPhases per skill", () => {
  const reg = new SkillsRegistry();
  assert.deepEqual(reg.phasesFor("lt.execute_scope"), ["before_start"]);
  assert.deepEqual(reg.phasesFor("lt.closeout_sweep"), ["before_complete", "after_complete", "on_rollover"]);
  assert.deepEqual(reg.phasesFor("lt.task_planner"), ["before_start", "after_complete"]);
  assert.deepEqual(reg.phasesFor("lt.verify"), ["before_complete"]);
  assert.deepEqual(reg.phasesFor("lt.status_heartbeat"), ["checkpoint"]);
  assert.deepEqual(reg.phasesFor("does.not.exist"), []);
});

test("SkillsRegistry.phasesFor: returns a fresh array (mutation does not leak)", () => {
  const reg = new SkillsRegistry();
  const phases = reg.phasesFor("lt.execute_scope");
  phases.push("on_quiet");
  assert.deepEqual(reg.phasesFor("lt.execute_scope"), ["before_start"]);
});

// --- register: duplicate + bad shape ---------------------------------------

test("SkillsRegistry.register: throws DUPLICATE_SKILL_ID when id already exists", () => {
  const reg = new SkillsRegistry({ definitions: [customSkill()] });
  assert.equal(reg.has("custom.skill"), true);
  let err;
  try {
    reg.register(customSkill({ title: "Conflict" }));
  } catch (e) {
    err = e;
  }
  assert.ok(err, "second register should throw");
  assert.equal(err.code, "DUPLICATE_SKILL_ID");
  assert.match(err.message, /already registered/);
});

test("SkillsRegistry.register: rejects malformed top-level fields", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  assert.throws(() => reg.register(undefined), /definition must be an object/);
  assert.throws(() => reg.register([]), /definition must be an object/);
  assert.throws(() => reg.register(customSkill({ id: "" })), /id required/);
  assert.throws(() => reg.register(customSkill({ title: "" })), /title required/);
  assert.throws(() => reg.register(customSkill({ description: "" })), /description required/);
  assert.throws(() => reg.register(customSkill({ appliesTo: [] })), /appliesTo must be a non-empty/);
  assert.throws(() => reg.register(customSkill({ appliesTo: [""] })), /appliesTo entries must be non-empty/);
  assert.throws(() => reg.register(customSkill({ defaultPhases: [] })), /defaultPhases must be a non-empty/);
  assert.throws(() => reg.register(customSkill({ adapters: undefined })), /adapters must be an object/);
  assert.throws(() => reg.register(customSkill({ adapters: {} })), /at least one adapter/);
});

// --- register: unknown phase / adapter kind --------------------------------

test("SkillsRegistry.register: rejects unknown SkillPhase values", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  let err;
  try {
    reg.register(customSkill({ defaultPhases: ["never_happens"] }));
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_SKILL_PHASE");
  assert.match(err.message, /'never_happens' not in/);
});

test("SkillsRegistry.register: rejects unknown adapter kinds", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  let err;
  try {
    reg.register(customSkill({ adapters: { bogusAdapter: {} } }));
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, "INVALID_SKILL_ADAPTER");
  assert.match(err.message, /unknown adapter kind 'bogusAdapter'/);
});

// --- register: per-adapter sub-shape validation ----------------------------

test("SkillsRegistry.register: codexSkill requires non-empty shortcut", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  assert.throws(
    () => reg.register(customSkill({ adapters: { codexSkill: {} } })),
    /codexSkill\.shortcut required/,
  );
  assert.throws(
    () => reg.register(customSkill({ adapters: { codexSkill: { shortcut: "" } } })),
    /codexSkill\.shortcut required/,
  );
});

test("SkillsRegistry.register: mcpPrompt requires non-empty tool", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  assert.throws(
    () => reg.register(customSkill({ adapters: { mcpPrompt: {} } })),
    /mcpPrompt\.tool required/,
  );
  assert.throws(
    () => reg.register(customSkill({ adapters: { mcpPrompt: { tool: "" } } })),
    /mcpPrompt\.tool required/,
  );
});

test("SkillsRegistry.register: promptTemplate requires non-empty path", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  assert.throws(
    () => reg.register(customSkill({ adapters: { promptTemplate: {} } })),
    /promptTemplate\.path required/,
  );
  assert.throws(
    () => reg.register(customSkill({ adapters: { promptTemplate: { path: "" } } })),
    /promptTemplate\.path required/,
  );
});

test("SkillsRegistry.register: httpAction requires non-empty endpoint", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  assert.throws(
    () => reg.register(customSkill({ adapters: { httpAction: {} } })),
    /httpAction\.endpoint required/,
  );
  assert.throws(
    () => reg.register(customSkill({ adapters: { httpAction: { endpoint: "" } } })),
    /httpAction\.endpoint required/,
  );
});

// --- register: custom definitions become first-class ------------------------

test("SkillsRegistry.register: custom definitions are queryable and frozen", () => {
  const reg = new SkillsRegistry({ definitions: [] });
  const stored = reg.register(
    customSkill({
      id: "my.skill",
      adapters: {
        codexSkill: { shortcut: "$my" },
        mcpPrompt: { tool: "my_tool" },
        promptTemplate: { path: "templates/my.md" },
        httpAction: { endpoint: "/api/my" },
      },
      defaultPhases: ["before_start", "after_complete"],
    }),
  );
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(reg.has("my.skill"), true);
  assert.equal(reg.get("my.skill").title, "Custom Skill");
  assert.deepEqual(reg.resolveAdapter("my.skill", "codexSkill"), { shortcut: "$my" });
  assert.deepEqual(reg.resolveAdapter("my.skill", "mcpPrompt"), { tool: "my_tool" });
  assert.deepEqual(reg.resolveAdapter("my.skill", "promptTemplate"), { path: "templates/my.md" });
  assert.deepEqual(reg.resolveAdapter("my.skill", "httpAction"), { endpoint: "/api/my" });
  assert.deepEqual(reg.phasesFor("my.skill"), ["before_start", "after_complete"]);
  assert.deepEqual(
    reg.list().map((s) => s.id),
    ["my.skill"],
  );
});

// --- constructor: rejects non-iterable definitions -------------------------

test("SkillsRegistry: constructor rejects non-iterable definitions input", () => {
  assert.throws(() => new SkillsRegistry({ definitions: 42 }), /definitions must be iterable/);
});
