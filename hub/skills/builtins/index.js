// hub/skills/builtins/index.js — SH-5-02 (TDD v0.5 §11.2, §11.3)
//
// Declarative table of the workflow skills that ship with the Session Hub.
// Each entry mirrors the TDD §11.1 SkillDefinition shape; the SkillsRegistry
// constructor (hub/skills/registry.js) feeds them through the same
// register() validation path that user-supplied definitions take, then
// freezes the per-skill object plus the surrounding array.
//
// What this module is responsible for:
//   - Naming the five built-in skills called out in the SH-5-02 DoD and the
//     §11.3 job-profile hooks: lt.execute_scope, lt.closeout_sweep,
//     lt.task_planner, lt.verify, and lt.status_heartbeat.
//   - Declaring each one's default lifecycle phases (matched to the §11.3
//     hooks so SH-5-03's profile plan generator has a reasonable fallback).
//   - Wiring each skill to the adapter(s) the TDD calls out: codexSkill
//     shortcuts for the lt.* trio, an mcpPrompt for the heartbeat, and an
//     httpAction endpoint for verify.
//
// What this module does NOT do:
//   - Validate adapter shape / phase membership — SkillsRegistry.register()
//     does that on construction so user-supplied skills face the same checks.
//   - Freeze its own objects — SkillsRegistry.register() applies Object.freeze
//     once validation passes so a single code path owns immutability.
//   - Declare job profiles (SH-5-03 owns hub/jobs/profiles.js).

/** @type {ReadonlyArray<import("../registry.js").SkillDefinition>} */
export const BUILT_IN_SKILLS = [
  {
    id: "lt.execute_scope",
    title: "Execute Scope",
    description:
      "Run the LLM Project Tracker execute-scope skill for the current task.",
    appliesTo: ["task_backed"],
    defaultPhases: ["before_start"],
    adapters: {
      codexSkill: { shortcut: "$lt:execute" },
      mcpPrompt: { tool: "tracker_execute_scope" },
    },
  },
  {
    id: "lt.closeout_sweep",
    title: "Closeout Sweep",
    description:
      "Sweep tracker state for stale, in-progress, or near-complete work before/after a job ends.",
    appliesTo: ["task_backed"],
    defaultPhases: ["before_complete", "after_complete", "on_rollover"],
    adapters: {
      codexSkill: { shortcut: "$lt:closeout" },
      mcpPrompt: { tool: "tracker_closeout_sweep" },
    },
  },
  {
    id: "lt.task_planner",
    title: "Task Planner",
    description:
      "Turn the current goal into tracker tasks with dependencies and DoD; also re-plan after completion.",
    appliesTo: ["task_backed"],
    defaultPhases: ["before_start", "after_complete"],
    adapters: {
      codexSkill: { shortcut: "$lt:plan" },
      mcpPrompt: { tool: "tracker_plan_tasks" },
    },
  },
  {
    id: "lt.verify",
    title: "Verify Task",
    description:
      "Drive the per-task VerifyPack via the tracker verify HTTP endpoint before completion.",
    appliesTo: ["task_backed"],
    defaultPhases: ["before_complete"],
    adapters: {
      httpAction: { endpoint: "/api/projects/:slug/tasks/:taskId/verify" },
    },
  },
  {
    id: "lt.status_heartbeat",
    title: "Status Heartbeat",
    description:
      "Periodic structured heartbeat from the session — keeps ActivityMonitor tier-aware.",
    appliesTo: ["task_backed", "untasked"],
    defaultPhases: ["checkpoint"],
    adapters: {
      mcpPrompt: { tool: "tracker_session_context_usage" },
    },
  },
];
