import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveProject } from "./progress.js";
import { loadProjectWithRuntimeOverlay } from "./runtime-overlay.js";
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

function loadProjectFile(workspace, path, slug) {
  if (!existsSync(path)) {
    return { ok: false, status: 404, message: "project not found", slug, path };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const notes = { warnings: [] };
    const normalized = normalizeProjectStatuses(parsed, notes).data;
    const loaded = loadProjectWithRuntimeOverlay({
      workspace,
      slug,
      trackerPath: path,
      baseProject: normalized
    });
    const validation = validateProject(loaded.data);
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
      data: loaded.data,
      base: loaded.base,
      derived: deriveProject(loaded.data),
      rev: loaded.data?.meta?.rev ?? null,
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
  return loadProjectFile(workspace, trackerFilePath(workspace, slug), slug);
}

export function listProjectEntries(workspace) {
  const dir = join(workspace, "trackers");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".errors.json"))
    .sort()
    .map((name) => {
      const slug = name.slice(0, -5);
      return loadProjectFile(workspace, join(dir, name), slug);
    });
}
