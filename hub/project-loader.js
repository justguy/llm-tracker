import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveProject } from "./progress.js";
import { normalizeProjectStatuses } from "./status-vocabulary.js";
import { validateProject } from "./validator.js";

export function readWorkspaceHelp(workspace) {
  const readmePath = join(workspace, "README.md");
  if (!existsSync(readmePath)) {
    return { ok: false, status: 404, message: "workspace README not found", path: readmePath };
  }
  return {
    ok: true,
    path: readmePath,
    text: readFileSync(readmePath, "utf-8")
  };
}

export function trackerFilePath(workspace, slug) {
  return join(workspace, "trackers", `${slug}.json`);
}

function loadProjectFile(path, slug) {
  if (!existsSync(path)) {
    return { ok: false, status: 404, message: "project not found", slug, path };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const notes = { warnings: [] };
    const normalized = normalizeProjectStatuses(parsed, notes).data;
    const validation = validateProject(normalized);
    if (!validation.ok) {
      return {
        ok: false,
        status: 400,
        message: validation.errors.join("; "),
        slug,
        path
      };
    }

    return {
      ok: true,
      slug,
      path,
      data: normalized,
      derived: deriveProject(normalized),
      rev: normalized?.meta?.rev ?? null,
      notes
    };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      message: `parse: ${error.message}`,
      slug,
      path
    };
  }
}

export function loadProjectEntry(workspace, slug) {
  return loadProjectFile(trackerFilePath(workspace, slug), slug);
}

export function listProjectEntries(workspace) {
  const dir = join(workspace, "trackers");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".errors.json"))
    .sort()
    .map((name) => {
      const slug = name.slice(0, -5);
      return loadProjectFile(join(dir, name), slug);
    });
}
