import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url);
const SKILL_NAMES = ["tracker-execute-scope", "tracker-closeout-sweep", "tracker-task-planner"];
const PLUGIN_SKILLS = ["execute", "closeout", "plan"];

test("packaged tracker workflow skills are installable and complete", () => {
  for (const name of SKILL_NAMES) {
    const skillDir = join(ROOT.pathname, "skills", name);
    const skillPath = join(skillDir, "SKILL.md");
    const openaiPath = join(skillDir, "agents", "openai.yaml");

    assert.equal(existsSync(skillPath), true, `${name} should include SKILL.md`);
    assert.equal(existsSync(openaiPath), true, `${name} should include agents/openai.yaml`);

    const skill = readFileSync(skillPath, "utf8");
    assert.match(skill, new RegExp(`name: ${name}`));
    assert.match(skill, /description: .+Use when /);
    assert.doesNotMatch(skill, /TODO/);
    assert.match(skill, /tracker_help|tracker:\/\/help/);
    assert.match(skill, /Default to the relevant slug for the current app\/project/);

    const openai = readFileSync(openaiPath, "utf8");
    assert.match(openai, new RegExp(`\\$${name}`));
    assert.doesNotMatch(openai, /TODO/);
  }
});

test("Codex plugin wrapper exposes the same workflow skills", () => {
  const marketplacePath = join(ROOT.pathname, ".agents", "plugins", "marketplace.json");
  const pluginPath = join(
    ROOT.pathname,
    "plugins",
    "llm-tracker-workflows",
    "local",
    ".codex-plugin",
    "plugin.json"
  );
  const pluginSkillsRoot = join(ROOT.pathname, "plugins", "llm-tracker-workflows", "local", "skills");

  const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
  const pluginEntry = marketplace.plugins.find((plugin) => plugin.name === "llm-tracker-workflows");
  assert.equal(pluginEntry.source.path, "./plugins/llm-tracker-workflows/local");

  const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
  assert.equal(plugin.name, "llm-tracker-workflows");
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.interface.displayName, "lt");

  for (const name of PLUGIN_SKILLS) {
    const skill = readFileSync(join(pluginSkillsRoot, name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`name: ${name}`));
    assert.match(skill, /description: .+Use when /);
    assert.match(skill, /tracker_help|tracker:\/\/help/);
    assert.match(skill, /Default to the relevant slug for the current app\/project/);
    assert.doesNotMatch(skill, /TODO/);
  }
});
