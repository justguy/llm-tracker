import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../skills/", import.meta.url));

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

test("skill Markdown resources have portable, resolvable local references", () => {
  const directories = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(directories.length > 0);
  for (const directory of directories) {
    const skillRoot = resolve(root, directory.name);
    assert.ok(statSync(resolve(skillRoot, "SKILL.md")).isFile());
    for (const path of filesIn(skillRoot).filter((file) => file.endsWith(".md"))) {
      const content = readFileSync(path, "utf8");
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
        const resolved = resolve(dirname(path), target.split("#", 1)[0]);
        const inside = relative(skillRoot, resolved);
        assert.ok(inside !== ".." && !inside.startsWith("../") && !inside.startsWith("..\\") && !isAbsolute(inside),
          `${relative(root, path)} references a resource outside the skill: ${target}`);
        assert.ok(statSync(resolved).isFile(), `${relative(root, path)} has a missing resource: ${target}`);
      }
    }
  }
});
