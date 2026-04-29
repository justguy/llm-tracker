import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import { validateProject } from "../../hub/validator.js";

const META_OVERLAY_FIELDS = ["scratchpad", "updatedAt", "rev"];
const TASK_OVERLAY_FIELDS = ["status", "assignee", "blocker_reason", "updatedAt", "rev"];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function overlayDir(workspace) {
  return join(workspace, ".runtime", "overlays");
}

function trackerPath(workspace, slug) {
  return join(workspace, "trackers", `${slug}.json`);
}

function overlayPath(workspace, slug) {
  return join(overlayDir(workspace), `${slug}.json`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf-8"));
}

function applyOverlay(project, overlay) {
  const next = clone(project);

  if (overlay?.meta && next.meta) {
    for (const field of META_OVERLAY_FIELDS) {
      if (field in overlay.meta) next.meta[field] = clone(overlay.meta[field]);
    }
  }

  if (overlay?.tasks && Array.isArray(next.tasks)) {
    const taskOverlays = overlay.tasks || {};
    next.tasks = next.tasks.map((task) => {
      const patch = taskOverlays[task.id];
      if (!patch) return task;
      const updated = { ...task };
      for (const field of TASK_OVERLAY_FIELDS) {
        if (field in patch) updated[field] = clone(patch[field]);
      }
      return updated;
    });
  }

  return next;
}

function overlaySlugs(workspace) {
  const dir = overlayDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".errors.json"))
    .map((name) => basename(name, ".json"))
    .sort();
}

function analyzeOverlay(workspace, slug) {
  const registration = trackerPath(workspace, slug);
  const overlayFile = overlayPath(workspace, slug);

  if (!existsSync(registration)) {
    return { slug, overlayFile, ok: false, action: "skip", reason: "missing tracker registration" };
  }

  let target;
  try {
    const stat = lstatSync(registration);
    if (!stat.isSymbolicLink()) {
      return { slug, overlayFile, ok: false, action: "skip", reason: "tracker is not linked" };
    }
    target = realpathSync(registration);
  } catch (error) {
    return { slug, overlayFile, ok: false, action: "skip", reason: error.message };
  }

  let project;
  let overlay;
  try {
    project = readJson(target);
    overlay = readJson(overlayFile);
  } catch (error) {
    return { slug, overlayFile, target, ok: false, action: "error", reason: `parse failed: ${error.message}` };
  }

  const repaired = applyOverlay(project, overlay);
  const validation = validateProject(repaired);
  if (!validation.ok) {
    return {
      slug,
      overlayFile,
      target,
      ok: false,
      action: "error",
      reason: `repaired tracker would be invalid: ${validation.errors.join("; ")}`
    };
  }

  const changed = !sameJson(project, repaired);
  return {
    slug,
    overlayFile,
    target,
    ok: true,
    action: changed ? "repair" : "clear",
    changed,
    repaired
  };
}

function printResults(results, write) {
  const counts = results.reduce(
    (acc, result) => {
      acc[result.action] = (acc[result.action] || 0) + 1;
      return acc;
    },
    {}
  );
  const mode = write ? "write" : "dry-run";
  console.log(`linked-overlay repair (${mode})`);
  console.log(`  repair: ${counts.repair || 0}`);
  console.log(`  clear: ${counts.clear || 0}`);
  console.log(`  skip: ${counts.skip || 0}`);
  console.log(`  error: ${counts.error || 0}`);

  for (const result of results) {
    const target = result.target ? ` -> ${result.target}` : "";
    const reason = result.reason ? ` (${result.reason})` : "";
    console.log(`  ${result.slug}: ${result.action}${target}${reason}`);
  }
}

function publicResult(result) {
  const { repaired, ...rest } = result;
  return rest;
}

export function cmdRepairLinkedOverlays(args, { resolveWorkspace }) {
  const workspace = resolveWorkspace(args.flags.path);
  const write = args.flags.write === true || args.flags.write === "true";
  const json = args.flags.json === true || args.flags.json === "true";
  const slugs = args._.slice(1);
  const selected = slugs.length > 0 ? slugs : overlaySlugs(workspace);
  const results = selected.map((slug) => analyzeOverlay(workspace, slug));

  if (write) {
    for (const result of results) {
      if (!result.ok) continue;
      if (result.changed) atomicWriteJson(result.target, result.repaired);
      try {
        unlinkSync(result.overlayFile);
      } catch {}
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        { ok: results.every((r) => r.action !== "error"), write, results: results.map(publicResult) },
        null,
        2
      )
    );
  } else {
    printResults(results, write);
    if (!write) console.log("  pass --write to update repo-local tracker files and remove repaired overlays");
  }

  if (results.some((result) => result.action === "error")) process.exitCode = 1;
}
