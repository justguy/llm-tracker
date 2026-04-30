import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  statSync,
  lstatSync,
  realpathSync
} from "node:fs";
import { isAbsolute } from "node:path";
import { basename, join } from "node:path";
import { buildTrackerErrorBody, inferTrackerErrorHint } from "./error-payload.js";
import { validateProject } from "./validator.js";
import { deriveProject } from "./progress.js";
import { mergeProject, stableEq } from "./merge.js";
import { computeDelta, hasChanges, summarize } from "./versioning.js";
import { normalizeProjectStatuses } from "./status-vocabulary.js";
import {
  clearRuntimeOverlay,
  loadProjectWithRuntimeOverlay,
  persistProjectWithRuntimeOverlay
} from "./runtime-overlay.js";
import {
  writeSnapshot,
  readSnapshot,
  maxRev,
  appendHistoryEntry,
  historySince,
  readHistory,
  listRevs
} from "./snapshots.js";
import { buildPickedPayload, resolvePickSelection } from "./pick.js";

export function slugFromFile(filePath) {
  const base = basename(filePath);
  if (!base.endsWith(".json")) return null;
  if (base.endsWith(".errors.json")) return null;
  return base.slice(0, -".json".length);
}

export function trackerPath(workspace, slug) {
  return join(workspace, "trackers", `${slug}.json`);
}

export function errorPath(workspace, slug) {
  return join(workspace, "trackers", `${slug}.errors.json`);
}

export function writeErrorFile(workspace, slug, err) {
  const file = errorPath(workspace, slug);
  const body = buildTrackerErrorBody({
    message: err.message,
    kind: err.kind,
    path: trackerPath(workspace, slug)
  });
  try {
    writeFileSync(file, JSON.stringify(body, null, 2));
  } catch {}
}

export function clearErrorFile(workspace, slug) {
  const file = errorPath(workspace, slug);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {}
  }
}

export function atomicWriteJson(file, data) {
  // If `file` is a symlink, resolve to the real path so the atomic rename
  // lands on the target file and does not clobber the symlink itself.
  let target = file;
  try {
    const l = lstatSync(file);
    if (l.isSymbolicLink()) {
      target = realpathSync(file);
    }
  } catch {}
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, target);
}

function normalizeForCompare(obj) {
  if (!obj) return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy?.meta) {
    delete copy.meta.updatedAt;
  }
  return copy;
}

// Summarize what changed between the incoming file shape and the merged shape
// the hub decided to persist. Used when the hub rewrites a file without a rev
// bump so operators can see which keys the merge layer kept or dropped.
function summarizeSilentRewrite(incoming, merged) {
  const summary = { fields: [], reingestNote: null };
  const incomingTasks = new Map();
  const incTasks = Array.isArray(incoming?.tasks)
    ? incoming.tasks
    : incoming?.tasks
      ? Object.entries(incoming.tasks).map(([id, t]) => ({ id, ...(t || {}) }))
      : [];
  for (const t of incTasks) if (t?.id) incomingTasks.set(t.id, t);

  for (const mTask of merged?.tasks || []) {
    const iTask = incomingTasks.get(mTask.id);
    if (!iTask) continue;
    const mCtx = mTask.context || {};
    const iCtx = iTask.context || {};
    const reAdded = Object.keys(mCtx).filter((k) => !(k in iCtx));
    const dropped = Object.keys(iCtx).filter((k) => !(k in mCtx));
    if (reAdded.length || dropped.length) {
      summary.fields.push({
        path: `tasks[${mTask.id}].context`,
        reAddedByMerge: reAdded,
        droppedByMerge: dropped
      });
    }
  }
  if (summary.fields.length === 0) {
    summary.reingestNote =
      "file on disk diverged from merged in-memory shape (non-context fields); hub rewrote the file to match.";
  }
  return summary;
}

function collectPatchTaskArray(patch) {
  if (!patch || typeof patch !== "object" || !patch.tasks) return [];
  if (Array.isArray(patch.tasks)) return patch.tasks.filter((task) => task && typeof task === "object");
  return Object.entries(patch.tasks).map(([id, task]) => ({ id, ...(task || {}) }));
}

function cloneProject(project) {
  return project ? JSON.parse(JSON.stringify(project)) : project;
}

function structuralOpsFromPatch(patch) {
  return {
    swimlaneOps: Array.isArray(patch?.swimlaneOps) ? patch.swimlaneOps : [],
    taskOps: Array.isArray(patch?.taskOps) ? patch.taskOps : []
  };
}

function validateStructuralOpsShape(patch) {
  if (!patch || typeof patch !== "object") return null;
  if ("swimlaneOps" in patch && !Array.isArray(patch.swimlaneOps)) {
    return "swimlaneOps must be an array";
  }
  if ("taskOps" in patch && !Array.isArray(patch.taskOps)) {
    return "taskOps must be an array";
  }
  return null;
}

function patchWithoutStructuralOps(patch) {
  if (!patch || typeof patch !== "object") return patch;
  const { swimlaneOps, taskOps, ...rest } = patch;
  return rest;
}

function validatePatchGuardrails(existing, patch) {
  if (!existing || !patch || typeof patch !== "object") return { ok: true };
  const existingIds = new Set((existing.tasks || []).map((task) => task.id));
  const forbiddenStatuses = new Set(["complete", "deferred"]);
  const violations = [];

  for (const task of collectPatchTaskArray(patch)) {
    if (!task?.id || existingIds.has(task.id)) continue;
    if (!forbiddenStatuses.has(task.status)) continue;
    violations.push(`${task.id} (${task.status})`);
  }

  if (violations.length === 0) return { ok: true };

  const message =
    `new tasks added through patch mode must start as not_started or in_progress; ` +
    `rejecting ${violations.join(", ")}`;

  return {
    ok: false,
    status: 400,
    type: "schema",
    message,
    hint: inferTrackerErrorHint(message)
  };
}

function validateExpectedRev(patch, currentRev) {
  if (!patch || typeof patch !== "object" || !Object.prototype.hasOwnProperty.call(patch, "expectedRev")) {
    return { ok: true };
  }
  const expectedRev = patch.expectedRev;
  if (!Number.isInteger(expectedRev) || expectedRev < 0) {
    return {
      ok: false,
      status: 400,
      type: "schema",
      message: "expectedRev must be a non-negative integer",
      hint: "Read the current project rev, then retry with `expectedRev` set to that exact integer."
    };
  }
  if (expectedRev !== currentRev) {
    return {
      ok: false,
      status: 409,
      type: "conflict",
      message: `stale write rejected: expectedRev ${expectedRev} does not match current rev ${currentRev}`,
      hint: "Refresh the project, reapply your patch to the current state, and retry with the current rev.",
      expectedRev,
      currentRev
    };
  }
  return { ok: true };
}

function nonEmptyStrings(values) {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value) : [];
}

function inferNoopRetryShape(messages) {
  const text = messages.join("\n");
  if (text.includes("meta.swimlanes") && text.includes("cannot remove swimlane")) {
    return "Swimlane removal is structural. Use `swimlaneOps.remove` when structural patch ops are available, or use `PUT /api/projects/:slug` for an intentional full structural replacement.";
  }
  if (text.includes("hub-owned") || text.includes("human-owned")) {
    return "Remove hub-owned or human-owned fields from the patch and retry with mutable fields only.";
  }
  if (text.includes("normalized legacy value")) {
    return "Retry with the canonical status value shown in the warning.";
  }
  if (text.includes("still has tasks; provide reassignTo")) {
    return "Retry the structural removal with `reassignTo` set to another swimlane id from the repair payload.";
  }
  return "Retry with a mutable field change, or use the endpoint named in the warning for structural changes.";
}

function explainNoopPatch(notes) {
  const rejected = [
    ...nonEmptyStrings(notes?.ignored),
    ...nonEmptyStrings(notes?.warnings)
  ];
  if (rejected.length > 0) {
    return {
      reason:
        "Patch accepted but project state did not change because the merge layer rejected or ignored every effective operation.",
      rejected,
      retryShape: inferNoopRetryShape(rejected)
    };
  }
  return {
    reason: "Patch accepted but all submitted values already matched the current project state.",
    rejected: [],
    retryShape: "Skip the write, or change at least one mutable field before retrying."
  };
}

function insertTaskInCell(tasks, task, { swimlaneId, priorityId, targetIndex }) {
  task.placement = { swimlaneId, priorityId };
  const insertBeforeIdsInCell = [];
  let seen = 0;
  for (const existing of tasks) {
    if (existing.placement?.swimlaneId === swimlaneId && existing.placement?.priorityId === priorityId) {
      if (seen === targetIndex) insertBeforeIdsInCell.push(existing.id);
      seen++;
    }
  }

  if (typeof targetIndex === "number" && targetIndex >= 0 && insertBeforeIdsInCell.length > 0) {
    const anchorIdx = tasks.findIndex((existing) => existing.id === insertBeforeIdsInCell[0]);
    tasks.splice(anchorIdx, 0, task);
    return;
  }

  let lastCellIdx = -1;
  for (let i = 0; i < tasks.length; i++) {
    const existing = tasks[i];
    if (existing.placement?.swimlaneId === swimlaneId && existing.placement?.priorityId === priorityId) {
      lastCellIdx = i;
    }
  }
  if (lastCellIdx >= 0) tasks.splice(lastCellIdx + 1, 0, task);
  else tasks.push(task);
}

function applyStructuralOps(existing, patch, notes) {
  const shapeError = validateStructuralOpsShape(patch);
  if (shapeError) return { ok: false, status: 400, message: shapeError };

  const { swimlaneOps, taskOps } = structuralOpsFromPatch(patch);
  if (swimlaneOps.length === 0 && taskOps.length === 0) {
    return { ok: true, data: existing };
  }
  if (swimlaneOps.length > 0 && patch?.meta && "swimlanes" in patch.meta) {
    return {
      ok: false,
      status: 400,
      message: "do not mix swimlaneOps with meta.swimlanes in the same patch"
    };
  }
  if (taskOps.some((op) => (op?.op || op?.kind) === "move")) {
    const movedIds = new Set(
      taskOps
        .filter((op) => (op?.op || op?.kind) === "move")
        .map((op) => op?.id || op?.taskId || op?.sourceId)
        .filter(Boolean)
    );
    const taskPatches = Array.isArray(patch?.tasks)
      ? patch.tasks
      : Object.entries(patch?.tasks || {}).map(([id, task]) => ({ id, ...(task || {}) }));
    for (const taskPatch of taskPatches) {
      if (movedIds.has(taskPatch.id) && "placement" in taskPatch) {
        return {
          ok: false,
          status: 400,
          message: `do not mix taskOps.move for ${taskPatch.id} with tasks.${taskPatch.id}.placement in the same patch`
        };
      }
    }
  }

  const data = cloneProject(existing);
  const lanes = data.meta?.swimlanes || [];
  const tasks = data.tasks || [];
  const laneIds = () => new Set(lanes.map((lane) => lane.id));
  const priorityIds = () => new Set((data.meta?.priorities || []).map((priority) => priority.id));
  const taskIds = () => new Set(tasks.map((task) => task.id));
  const tombstones = () => new Set(Array.isArray(data.meta?.deleted_tasks) ? data.meta.deleted_tasks : []);

  const fail = (message, status = 400, extra = {}) => ({ ok: false, status, message, ...extra });
  const swimlaneReassignRepair = (id, affected) => {
    const candidates = lanes.map((lane) => lane.id).filter((laneId) => laneId !== id);
    const moveTasksTo = candidates[0] || null;
    return {
      type: "swimlane_reassign_required",
      affectedTaskIds: affected.map((task) => task.id),
      validSwimlaneIds: candidates,
      moveTasksTo,
      swimlaneOps: [
        {
          op: "remove",
          id,
          reassignTo: moveTasksTo || "<swimlaneId>"
        }
      ]
    };
  };

  for (const op of swimlaneOps) {
    const kind = op?.op || op?.kind;
    const id = op?.id || op?.swimlaneId || op?.lane?.id;
    if (!kind) return fail("swimlaneOps entries require op");
    if (kind !== "add" && !id) return fail(`swimlaneOps.${kind} requires id`);

    if (kind === "add") {
      const lane = { ...(op.lane || {}) };
      if (!lane.id) return fail("swimlaneOps.add requires lane.id");
      if (laneIds().has(lane.id)) return fail(`swimlane ${lane.id} already exists`);
      delete lane.collapsed;
      const index = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, lanes.length)) : lanes.length;
      lanes.splice(index, 0, lane);
      notes.appended.push(`swimlane:${lane.id}`);
    } else if (kind === "update") {
      const lane = lanes.find((item) => item.id === id);
      if (!lane) return fail(`swimlane ${id} not found`, 404);
      const updates = op.patch || op.lane || {};
      for (const key of ["label", "description"]) {
        if (key in updates) lane[key] = updates[key];
      }
      if ("collapsed" in updates) notes.ignored.push(`meta.swimlanes[${id}].collapsed is human-owned`);
      notes.updated.push(`swimlane:${id}`);
    } else if (kind === "move") {
      const from = lanes.findIndex((lane) => lane.id === id);
      if (from === -1) return fail(`swimlane ${id} not found`, 404);
      let to = from;
      if (Number.isInteger(op.index)) to = Math.max(0, Math.min(op.index, lanes.length - 1));
      else if (op.direction === "up") to = Math.max(0, from - 1);
      else if (op.direction === "down") to = Math.min(lanes.length - 1, from + 1);
      else return fail("swimlaneOps.move requires index or direction up|down");
      if (to !== from) {
        const [lane] = lanes.splice(from, 1);
        lanes.splice(to, 0, lane);
        notes.updated.push(`swimlane:${id}`);
      }
    } else if (kind === "remove") {
      if (lanes.length <= 1) return fail("cannot remove the last swimlane");
      const index = lanes.findIndex((lane) => lane.id === id);
      if (index === -1) return fail(`swimlane ${id} not found`, 404);
      const affected = tasks.filter((task) => task.placement?.swimlaneId === id);
      const reassignTo = op.reassignTo || op.reassignToSwimlaneId;
      if (affected.length > 0 && !reassignTo) {
        return fail(`swimlane ${id} still has tasks; provide reassignTo`, 400, {
          repair: swimlaneReassignRepair(id, affected)
        });
      }
      if (reassignTo === id) return fail("swimlaneOps.remove reassignTo must name a different swimlane");
      if (reassignTo && !laneIds().has(reassignTo)) {
        return fail(`reassignTo swimlane ${reassignTo} not found`, 400, {
          repair: swimlaneReassignRepair(id, affected)
        });
      }
      for (const task of affected) task.placement.swimlaneId = reassignTo;
      lanes.splice(index, 1);
      notes.updated.push(`swimlane:${id}`);
    } else {
      return fail(`unsupported swimlane op ${kind}`);
    }
  }

  for (const op of taskOps) {
    const kind = op?.op || op?.kind;
    const id = op?.id || op?.taskId || op?.sourceId;
    if (!kind) return fail("taskOps entries require op");
    if (kind !== "split" && !id) return fail(`taskOps.${kind} requires id`);

    if (kind === "move") {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return fail(`task ${id} not found`, 404);
      const placement = op.placement || {};
      const swimlaneId = placement.swimlaneId || op.swimlaneId;
      const priorityId = placement.priorityId || op.priorityId;
      if ("targetIndex" in op && (!Number.isInteger(op.targetIndex) || op.targetIndex < 0)) {
        return fail("taskOps.move targetIndex must be a non-negative integer");
      }
      if (!laneIds().has(swimlaneId)) return fail(`unknown swimlaneId ${swimlaneId}`);
      if (!priorityIds().has(priorityId)) return fail(`unknown priorityId ${priorityId}`);
      const [task] = tasks.splice(index, 1);
      insertTaskInCell(tasks, task, { swimlaneId, priorityId, targetIndex: op.targetIndex });
      notes.updated.push(id);
    } else if (kind === "archive") {
      const task = tasks.find((item) => item.id === id);
      if (!task) return fail(`task ${id} not found`, 404);
      task.status = "deferred";
      if (op.reason) task.blocker_reason = op.reason;
      notes.updated.push(id);
    } else if (kind === "split") {
      const sourceId = op.sourceId || op.from || op.id;
      const source = tasks.find((task) => task.id === sourceId);
      if (!source) return fail(`task ${sourceId} not found`, 404);
      const newTask = { ...(op.newTask || {}) };
      if (!newTask.id || !newTask.title) return fail("taskOps.split requires newTask.id and newTask.title");
      if (taskIds().has(newTask.id)) return fail(`task ${newTask.id} already exists`);
      if (tombstones().has(newTask.id)) {
        return fail(`task ${newTask.id} was deleted by a human; pick a new id to reopen the work`);
      }
      newTask.status = newTask.status || "not_started";
      if (newTask.status !== "not_started" && newTask.status !== "in_progress") {
        return fail("split newTask.status must be not_started or in_progress");
      }
      newTask.placement = newTask.placement || { ...(source.placement || {}) };
      if (!laneIds().has(newTask.placement.swimlaneId)) {
        return fail(`unknown swimlaneId ${newTask.placement.swimlaneId}`);
      }
      if (!priorityIds().has(newTask.placement.priorityId)) {
        return fail(`unknown priorityId ${newTask.placement.priorityId}`);
      }
      newTask.dependencies = Array.isArray(newTask.dependencies) ? newTask.dependencies : [];
      const sourceIndex = tasks.findIndex((task) => task.id === sourceId);
      tasks.splice(sourceIndex + 1, 0, newTask);
      notes.appended.push(newTask.id);
    } else if (kind === "merge") {
      const sourceId = op.sourceId || op.id;
      const targetId = op.targetId || op.into;
      if (!sourceId || !targetId) return fail("taskOps.merge requires sourceId and targetId");
      if (sourceId === targetId) return fail("taskOps.merge sourceId and targetId must differ");
      const source = tasks.find((task) => task.id === sourceId);
      const target = tasks.find((task) => task.id === targetId);
      if (!source) return fail(`task ${sourceId} not found`, 404);
      if (!target) return fail(`task ${targetId} not found`, 404);
      const related = new Set([...(target.related || []), sourceId]);
      target.related = [...related];
      target.context = {
        ...(target.context || {}),
        merged_from: [...new Set([...(target.context?.merged_from || []), sourceId])]
      };
      source.status = "deferred";
      source.context = { ...(source.context || {}), merged_into: targetId };
      notes.updated.push(targetId, sourceId);
    } else {
      return fail(`unsupported task op ${kind}`);
    }
  }

  return { ok: true, data };
}

function latestRecordedRev(workspace, slug) {
  const snapRev = maxRev(workspace, slug);
  const historyRev = readHistory(workspace, slug).reduce((max, entry) => {
    return Number.isInteger(entry?.rev) && entry.rev > max ? entry.rev : max;
  }, 0);
  return Math.max(snapRev, historyRev);
}

function defaultNotes() {
  return { ignored: [], warnings: [], appended: [], updated: [] };
}

export class Store {
  constructor(workspace) {
    this.workspace = workspace;
    this.projects = new Map();
    this.locks = new Map();
  }

  _entry(slug, filePath, data, base, rev, notes = defaultNotes()) {
    return {
      data,
      base,
      derived: deriveProject(data),
      path: filePath,
      rev,
      error: null,
      notes
    };
  }

  _persistProject(slug, filePath, baseProject, effectiveProject, overlayEnabled) {
    return persistProjectWithRuntimeOverlay({
      workspace: this.workspace,
      slug,
      trackerPath: filePath,
      baseProject,
      effectiveProject,
      overlayEnabled
    });
  }

  _loadProjectState(slug, filePath, rawContents = null, notes = null, previousBaseProject = null) {
    const raw = typeof rawContents === "string" ? rawContents : readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const normalized = normalizeProjectStatuses(parsed, notes).data;
    return loadProjectWithRuntimeOverlay({
      workspace: this.workspace,
      slug,
      trackerPath: filePath,
      baseProject: normalized,
      previousBaseProject
    });
  }

  _restoreRevisionUnlocked(slug, current, toRev, historyMeta = {}) {
    const snap = readSnapshot(this.workspace, slug, toRev);
    if (!snap) {
      return { ok: false, status: 404, message: `no snapshot for rev ${toRev}` };
    }
    if (!current || !current.data) {
      return { ok: false, status: 404, message: "project not in memory" };
    }

    const baseRev = current.rev;
    const newRev = baseRev + 1;

    const newState = JSON.parse(JSON.stringify(snap));
    newState.meta.rev = newRev;
    newState.meta.updatedAt = new Date().toISOString();

    const { ok, errors } = validateProject(newState);
    if (!ok) {
      return {
        ok: false,
        status: 500,
        message: `snapshot validation failed: ${errors.join("; ")}`
      };
    }

    const delta = computeDelta(current.data, newState);
    const persisted = this._persistProject(
      slug,
      current.path,
      current.base || current.data,
      newState,
      current.overlayEnabled === true
    );

    this.projects.set(
      slug,
      this._entry(slug, current.path, newState, persisted.base, newRev, defaultNotes())
    );

    writeSnapshot(this.workspace, slug, newRev, newState);
    appendHistoryEntry(this.workspace, slug, {
      rev: newRev,
      ts: newState.meta.updatedAt,
      delta,
      summary: summarize(delta),
      rolledBackFrom: baseRev,
      rolledBackTo: toRev,
      ...historyMeta
    });

    return { ok: true, from: baseRev, to: toRev, newRev };
  }

  list() {
    const out = [];
    for (const [slug, p] of this.projects) {
      if (!p.data) continue;
      out.push({
        slug,
        name: p.data.meta.name,
        pct: p.derived.pct,
        counts: p.derived.counts,
        total: p.derived.total,
        rev: p.rev,
        error: p.error || null
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(slug) {
    return this.projects.get(slug) || null;
  }

  async ingestLocked(filePath, rawContents) {
    const slug = slugFromFile(filePath);
    if (!slug) return { ok: false, reason: "not-a-tracker" };
    return this.withLock(slug, () => this.ingest(filePath, rawContents));
  }

  ingest(filePath, rawContents) {
    const slug = slugFromFile(filePath);
    if (!slug) return { ok: false, reason: "not-a-tracker" };

    let prev = this.projects.get(slug);
    let loadedIncoming;
    try {
      const normalizationNotes = { warnings: [] };
      loadedIncoming = this._loadProjectState(
        slug,
        filePath,
        rawContents,
        normalizationNotes,
        prev?.base || null
      );
      let incoming = normalizeProjectStatuses(loadedIncoming.data, normalizationNotes).data;
      const incomingBase = loadedIncoming.base;
      const overlayEnabled = loadedIncoming.overlayEnabled;
      const legacyOverlayPresent = loadedIncoming.legacyOverlayPresent === true;

      // Cold-start resume: if we don't have in-memory state but incoming matches
      // a known snapshot at incoming.meta.rev, adopt without bumping.
      if (!prev || !prev.data) {
        const incomingRev = incoming?.meta?.rev ?? 0;
        if (incomingRev > 0) {
          const snap = readSnapshot(this.workspace, slug, incomingRev);
          if (snap) {
            if (stableEq(normalizeForCompare(snap), normalizeForCompare(incoming))) {
              const { ok: vOk, errors: vErr } = validateProject(incoming);
              if (!vOk) {
                return this._recordError(slug, filePath, { kind: "schema", message: vErr.join("; ") });
              }
              const entry = this._entry(
                slug,
                filePath,
                incoming,
                incomingBase,
                incomingRev,
                {
                  ignored: [],
                  warnings: [...normalizationNotes.warnings],
                  appended: [],
                  updated: []
                }
              );
              entry.overlayEnabled = overlayEnabled;
              this.projects.set(slug, entry);
              if (legacyOverlayPresent) clearRuntimeOverlay(this.workspace, slug);
              clearErrorFile(this.workspace, slug);
              return { ok: true, slug, event: "UPDATE", project: entry, resumed: true };
            }
            // Snapshot differs from incoming — treat snapshot as the prev baseline.
            prev = {
              data: snap,
              base: incomingBase,
              path: filePath,
              rev: incomingRev,
              overlayEnabled
            };
          }
        }
      }

      const prevData = prev?.data || null;
      const { merged, notes } = mergeProject(prevData, incoming);
      if (normalizationNotes.warnings.length > 0) {
        notes.warnings.push(...normalizationNotes.warnings);
      }

      const { ok, errors } = validateProject(merged);
      if (!ok) {
        return this._recordError(slug, filePath, { kind: "schema", message: errors.join("; ") });
      }

      const delta = computeDelta(prevData, merged);
      if (!hasChanges(delta) && prev?.data) {
        // In-memory state is unchanged. If the file on disk differs from what we
        // want (e.g., LLM tried to reorder or flip collapsed, or tried to delete
        // a hub-owned field), correct it without bumping rev.
        let silentRewrite = null;
        if (!stableEq(normalizeForCompare(merged), normalizeForCompare(incoming))) {
          silentRewrite = summarizeSilentRewrite(incoming, merged);
          merged.meta.rev = prev.rev;
          merged.meta.updatedAt = prev.data.meta.updatedAt;
          try {
            this._persistProject(
              slug,
              filePath,
              incomingBase,
              merged,
              overlayEnabled
            );
          } catch {}
        }
        if (legacyOverlayPresent) clearRuntimeOverlay(this.workspace, slug);
        prev.error = null;
        clearErrorFile(this.workspace, slug);
        return {
          ok: true,
          slug,
          event: "UPDATE",
          project: prev,
          noop: true,
          silentRewrite,
          notes
        };
      }

      const baseRev = prev?.rev ?? incoming?.meta?.rev ?? 0;
      const newRev = baseRev + 1;

      merged.meta.rev = newRev;
      merged.meta.updatedAt = new Date().toISOString();
      const persisted = this._persistProject(
        slug,
        filePath,
        incomingBase,
        merged,
        overlayEnabled
      );

      writeSnapshot(this.workspace, slug, newRev, merged);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: merged.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      const entry = this._entry(slug, filePath, merged, persisted.base, newRev, notes);
      entry.overlayEnabled = persisted.overlayEnabled;
      this.projects.set(slug, entry);
      clearErrorFile(this.workspace, slug);

      return { ok: true, slug, event: "UPDATE", project: entry, delta, notes };
    } catch (e) {
      return this._recordError(slug, filePath, { kind: "parse", message: e.message });
    }
  }

  _recordError(slug, filePath, err) {
    writeErrorFile(this.workspace, slug, err);
    const prev = this.projects.get(slug);
    if (prev) {
      prev.error = { ...err, at: new Date().toISOString() };
      return { ok: false, slug, event: "ERROR", project: prev };
    }
    this.projects.set(slug, {
      data: null,
      derived: null,
      path: filePath,
      rev: 0,
      error: { ...err, at: new Date().toISOString() }
    });
    return { ok: false, slug, event: "ERROR", project: this.projects.get(slug) };
  }

  async createOrReplace(slug, data) {
    return this.withLock(slug, async () => {
      data = normalizeProjectStatuses(data).data;
      if (!data?.meta?.slug) {
        return { ok: false, status: 400, message: "meta.slug is required in body" };
      }
      if (data.meta.slug !== slug) {
        return {
          ok: false,
          status: 400,
          message: `meta.slug "${data.meta.slug}" must match URL slug "${slug}"`
        };
      }
      const { ok, errors } = validateProject(data);
      if (!ok) return { ok: false, status: 400, message: errors.join("; ") };
      const file = trackerPath(this.workspace, slug);
      clearRuntimeOverlay(this.workspace, slug);
      atomicWriteJson(file, data);
      // chokidar fires → ingest stamps rev, writes snapshot, broadcasts.
      return { ok: true };
    });
  }

  async symlinkProject(slug, targetPath) {
    return this.withLock(slug, async () => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        return {
          ok: false,
          status: 400,
          message: "slug must match ^[a-z0-9][a-z0-9-]*$"
        };
      }
      if (typeof targetPath !== "string" || !isAbsolute(targetPath)) {
        return { ok: false, status: 400, message: "target must be an absolute file path" };
      }
      if (!existsSync(targetPath)) {
        return { ok: false, status: 404, message: `target not found: ${targetPath}` };
      }
      let stat;
      try {
        stat = statSync(targetPath);
      } catch (e) {
        return { ok: false, status: 400, message: `cannot stat target: ${e.message}` };
      }
      if (!stat.isFile()) {
        return { ok: false, status: 400, message: "target must be a regular file" };
      }
      if (!targetPath.endsWith(".json")) {
        return { ok: false, status: 400, message: "target must be a .json file" };
      }
      let data;
      try {
        data = JSON.parse(readFileSync(targetPath, "utf-8"));
      } catch (e) {
        return { ok: false, status: 400, message: `target is not valid JSON: ${e.message}` };
      }
      data = normalizeProjectStatuses(data).data;
      const { ok, errors } = validateProject(data);
      if (!ok) {
        return { ok: false, status: 400, message: `target fails schema: ${errors.join("; ")}` };
      }
      if (data.meta.slug !== slug) {
        return {
          ok: false,
          status: 400,
          message: `meta.slug "${data.meta.slug}" in target must match URL slug "${slug}"`
        };
      }

      const linkPath = trackerPath(this.workspace, slug);
      if (existsSync(linkPath) || (() => { try { lstatSync(linkPath); return true; } catch { return false; } })()) {
        return {
          ok: false,
          status: 409,
          message: `a tracker already exists at ${linkPath} — unregister it first (DELETE /api/projects/${slug}) or pick a different slug`
        };
      }
      try {
        symlinkSync(targetPath, linkPath);
      } catch (e) {
        if (process.platform === "win32" && (e.code === "EPERM" || e.code === "EACCES")) {
          return {
            ok: false,
            status: 500,
            message:
              "symlink failed on Windows — enable Developer Mode (Settings → Privacy & security → For developers), run the hub as Administrator, or use PUT /api/projects/:slug instead (no filesystem privileges required)."
          };
        }
        return { ok: false, status: 500, message: `symlink failed: ${e.message}` };
      }
      // chokidar's `add` event fires → ingest stamps rev, creates snapshot, broadcasts.
      return { ok: true, linkPath, target: targetPath };
    });
  }

  async deleteTask(slug, taskId) {
    return this.withLock(slug, async () => {
      // In-memory-first so the chokidar re-ingest doesn't merge the task back in.
      const current = this.projects.get(slug);
      if (!current || !current.data) {
        return { ok: false, status: 404, message: "project not found" };
      }
      const file = trackerPath(this.workspace, slug);
      const idx = current.data.tasks.findIndex((t) => t.id === taskId);
      if (idx === -1) return { ok: false, status: 404, message: "task not found" };

      const newState = JSON.parse(JSON.stringify(current.data));
      newState.tasks.splice(idx, 1);
      for (const t of newState.tasks) {
        if (Array.isArray(t.dependencies)) {
          t.dependencies = t.dependencies.filter((d) => d !== taskId);
        }
      }

      // Tombstone the deleted id so a later full-file write from a stale LLM
      // context cannot silently resurrect it. The list is hub-owned; merge.js
      // strips incoming meta.deleted_tasks and refuses to re-add tombstoned ids.
      const tombstones = Array.isArray(newState.meta.deleted_tasks)
        ? [...newState.meta.deleted_tasks]
        : [];
      if (!tombstones.includes(taskId)) tombstones.push(taskId);
      newState.meta.deleted_tasks = tombstones;

      const baseRev = current.rev;
      const newRev = baseRev + 1;
      newState.meta.rev = newRev;
      newState.meta.updatedAt = new Date().toISOString();

      const { ok, errors } = validateProject(newState);
      if (!ok) return { ok: false, status: 400, message: errors.join("; ") };

      const delta = computeDelta(current.data, newState);
      const persisted = this._persistProject(
        slug,
        file,
        current.base || current.data,
        newState,
        current.overlayEnabled === true
      );
      const entry = this._entry(slug, file, newState, persisted.base, newRev, defaultNotes());
      entry.overlayEnabled = persisted.overlayEnabled;
      this.projects.set(slug, entry);

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      return { ok: true, newRev };
    });
  }

  async restoreProject(slug, { rev } = {}) {
    return this.withLock(slug, async () => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        return {
          ok: false,
          status: 400,
          message: "slug must match ^[a-z0-9][a-z0-9-]*$"
        };
      }
      const file = trackerPath(this.workspace, slug);
      if (existsSync(file)) {
        return {
          ok: false,
          status: 409,
          message: `project already registered at ${file} — nothing to restore`
        };
      }

      const revs = listRevs(this.workspace, slug);
      if (revs.length === 0) {
        return {
          ok: false,
          status: 404,
          message: `no snapshots for slug "${slug}" — register with PUT /api/projects/${slug} instead`
        };
      }
      const targetRev = Number.isInteger(rev) ? rev : revs[revs.length - 1];
      if (!revs.includes(targetRev)) {
        return {
          ok: false,
          status: 404,
          message: `no snapshot at rev ${targetRev} for slug "${slug}" (available: ${revs.join(", ")})`
        };
      }

      const snap = readSnapshot(this.workspace, slug, targetRev);
      if (!snap) {
        return { ok: false, status: 500, message: `snapshot at rev ${targetRev} is unreadable` };
      }

      const { ok, errors } = validateProject(snap);
      if (!ok) {
        return {
          ok: false,
          status: 500,
          message: `snapshot failed validation: ${errors.join("; ")}`
        };
      }

      const newRev = latestRecordedRev(this.workspace, slug) + 1;
      const newState = JSON.parse(JSON.stringify(snap));
      newState.meta.rev = newRev;
      newState.meta.updatedAt = new Date().toISOString();

      const entry = this._entry(slug, file, newState, newState, newRev, defaultNotes());
      entry.overlayEnabled = false;
      this.projects.set(slug, entry);

      try {
        clearRuntimeOverlay(this.workspace, slug);
        atomicWriteJson(file, newState);
      } catch (e) {
        this.projects.delete(slug);
        return { ok: false, status: 500, message: `restore write failed: ${e.message}` };
      }

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        action: "restore",
        restoredFromRev: targetRev,
        summary: [`restored project from snapshot rev ${targetRev}`]
      });
      clearErrorFile(this.workspace, slug);

      return { ok: true, slug, restoredFromRev: targetRev, file, newRev };
    });
  }

  async deleteProject(slug) {
    return this.withLock(slug, async () => {
      const file = trackerPath(this.workspace, slug);
      if (!existsSync(file)) {
        return { ok: false, status: 404, message: "project not found" };
      }
      const current = this.projects.get(slug);
      const priorEntry = current ? {
        data: current.data ? JSON.parse(JSON.stringify(current.data)) : null,
        base: current.base ? JSON.parse(JSON.stringify(current.base)) : null,
        derived: current.derived,
        path: current.path,
        rev: current.rev,
        error: current.error,
        notes: current.notes,
        overlayEnabled: current.overlayEnabled === true
      } : null;
      try {
        if (current) this.projects.delete(slug);
        unlinkSync(file);
        clearRuntimeOverlay(this.workspace, slug);
      } catch (e) {
        if (current && priorEntry) this.projects.set(slug, priorEntry);
        return { ok: false, status: 500, message: `delete failed: ${e.message}` };
      }
      const deletedFromRev = Number.isInteger(current?.rev)
        ? current.rev
        : latestRecordedRev(this.workspace, slug);
      const deletedRev = deletedFromRev + 1;
      appendHistoryEntry(this.workspace, slug, {
        rev: deletedRev,
        ts: new Date().toISOString(),
        action: "delete",
        deletedFromRev,
        summary: ["deleted project registration"]
      });
      clearErrorFile(this.workspace, slug);
      // Snapshots and history are preserved for audit.
      return { ok: true, deletedRev, deletedFromRev };
    });
  }

  async applyPatch(slug, patch) {
    return this.withLock(slug, async () => {
      const file = trackerPath(this.workspace, slug);
      if (!existsSync(file)) {
        return {
          ok: false,
          status: 404,
          message: "project not found — register by writing the full tracker file first"
        };
      }
      const current = this.projects.get(slug);
      let existing = current?.data || null;
      let existingBase = current?.base || null;
      let overlayEnabled = current?.overlayEnabled === true;
      let legacyOverlayPresent = false;
      let currentRev = current?.rev ?? null;
      try {
        if (!existing || !existingBase) {
          const loaded = this._loadProjectState(slug, file);
          existing = loaded.data;
          existingBase = loaded.base;
          overlayEnabled = loaded.overlayEnabled;
          legacyOverlayPresent = loaded.legacyOverlayPresent === true;
        }
      } catch (e) {
        return { ok: false, status: 500, message: `tracker file not parseable: ${e.message}` };
      }
      if (!existing) {
        return { ok: false, status: 500, message: "project state is unavailable" };
      }
      if (!Number.isInteger(currentRev)) {
        currentRev = Number.isInteger(existing?.meta?.rev) ? existing.meta.rev : 0;
      }

      const expectedRevGuard = validateExpectedRev(patch, currentRev);
      if (!expectedRevGuard.ok) return expectedRevGuard;

      const guard = validatePatchGuardrails(existing, patch);
      if (!guard.ok) return guard;

      const normalizationNotes = { warnings: [] };
      patch = normalizeProjectStatuses(patch, normalizationNotes).data;
      const notes = defaultNotes();
      const structural = applyStructuralOps(existing, patch, notes);
      if (!structural.ok) {
        return {
          ok: false,
          status: structural.status || 400,
          type: "schema",
          message: structural.message,
          hint: inferTrackerErrorHint(structural.message),
          repair: structural.repair || null,
          notes
        };
      }
      const { merged, notes: mergeNotes } = mergeProject(
        structural.data,
        patchWithoutStructuralOps(patch)
      );
      notes.ignored.push(...mergeNotes.ignored);
      notes.warnings.push(...mergeNotes.warnings);
      notes.appended.push(...mergeNotes.appended);
      notes.updated.push(...mergeNotes.updated);
      if (normalizationNotes.warnings.length > 0) {
        notes.warnings.push(...normalizationNotes.warnings);
      }
      const { ok, errors } = validateProject(merged);
      if (!ok) {
        const message = errors.join("; ");
        return {
          ok: false,
          status: 400,
          type: "schema",
          message,
          hint: inferTrackerErrorHint(message),
          notes
        };
      }

      const delta = computeDelta(existing, merged);
      if (!hasChanges(delta)) {
        if (legacyOverlayPresent) clearRuntimeOverlay(this.workspace, slug);
        if (!current || !current.data) {
          const entry = this._entry(slug, file, existing, existingBase, currentRev, defaultNotes());
          entry.overlayEnabled = overlayEnabled;
          this.projects.set(slug, entry);
          clearErrorFile(this.workspace, slug);
        }
        return { ok: true, notes, noop: true, noopReason: explainNoopPatch(notes), rev: currentRev };
      }

      const newRev = currentRev + 1;
      merged.meta.rev = newRev;
      merged.meta.updatedAt = new Date().toISOString();
      const persisted = this._persistProject(slug, file, existingBase, merged, overlayEnabled);
      const entry = this._entry(slug, file, merged, persisted.base, newRev, notes);
      entry.overlayEnabled = persisted.overlayEnabled;
      this.projects.set(slug, entry);

      writeSnapshot(this.workspace, slug, newRev, merged);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: merged.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      clearErrorFile(this.workspace, slug);
      return { ok: true, notes, rev: newRev, noop: false };
    });
  }

  async pickTask(slug, { taskId, assignee = null, force = false, comment, scratchpad } = {}) {
    return this.withLock(slug, async () => {
      const current = this.projects.get(slug);
      if (!current || !current.data) {
        return { ok: false, status: 404, message: "project not found" };
      }

      const file = trackerPath(this.workspace, slug);
      const history = readHistory(this.workspace, slug);
      const selection = resolvePickSelection({
        slug,
        data: current.data,
        history,
        taskId,
        assignee,
        force
      });
      if (!selection.ok) return selection;

      const newState = JSON.parse(JSON.stringify(current.data));
      const target = newState.tasks.find((task) => task.id === selection.taskId);
      if (!target) {
        return { ok: false, status: 404, message: `task "${selection.taskId}" not found` };
      }

      const effectiveAssignee = assignee ?? target.assignee ?? null;
      const shouldRefreshClaim =
        target.status !== "in_progress" ||
        target.assignee !== effectiveAssignee ||
        target.blocker_reason != null ||
        comment !== undefined;
      target.status = "in_progress";
      target.assignee = effectiveAssignee;
      if (shouldRefreshClaim) {
        target.blocker_reason = null;
      }
      if (comment !== undefined) target.comment = comment;
      if (scratchpad !== undefined) newState.meta.scratchpad = scratchpad;

      const { ok, errors } = validateProject(newState);
      if (!ok) return { ok: false, status: 400, message: errors.join("; ") };

      const delta = computeDelta(current.data, newState);
      if (!hasChanges(delta)) {
        return {
          ok: true,
          noop: true,
          payload: buildPickedPayload({
            slug,
            data: current.data,
            history,
            taskId: selection.taskId,
            autoSelected: selection.autoSelected,
            selectedBecause: selection.selectedBecause,
            noop: true
          })
        };
      }

      const newRev = current.rev + 1;
      newState.meta.rev = newRev;
      newState.meta.updatedAt = new Date().toISOString();

      const persisted = this._persistProject(
        slug,
        file,
        current.base || current.data,
        newState,
        current.overlayEnabled === true
      );
      const entry = this._entry(slug, file, newState, persisted.base, newRev, defaultNotes());
      entry.overlayEnabled = persisted.overlayEnabled;
      this.projects.set(slug, entry);

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      return {
        ok: true,
        noop: false,
        payload: buildPickedPayload({
          slug,
          data: newState,
          history: [...history, { rev: newRev, delta }],
          taskId: selection.taskId,
          autoSelected: selection.autoSelected,
          selectedBecause: selection.selectedBecause,
          noop: false,
          now: newState.meta.updatedAt
        })
      };
    });
  }

  async startTask(slug, { taskId, assignee = null, force = false, comment, scratchpad } = {}) {
    if (!taskId) {
      return { ok: false, status: 400, message: "taskId is required to start a task" };
    }
    if (!assignee) {
      return { ok: false, status: 400, message: "assignee is required to start a task" };
    }
    const result = await this.pickTask(slug, { taskId, assignee, force, comment, scratchpad });
    if (!result.ok) return result;
    return {
      ...result,
      payload: {
        ...result.payload,
        startedTaskId: result.payload?.pickedTaskId || taskId,
        action: "start"
      }
    };
  }

  async rollback(slug, toRev) {
    return this.withLock(slug, async () => {
      const current = this.projects.get(slug);
      return this._restoreRevisionUnlocked(slug, current, toRev, { action: "rollback" });
    });
  }

  async undo(slug) {
    return this.withLock(slug, async () => {
      const current = this.projects.get(slug);
      if (!current || !current.data) {
        return { ok: false, status: 404, message: "project not in memory" };
      }

      const history = readHistory(this.workspace, slug);
      const latest = history[history.length - 1];
      if (!latest) {
        return { ok: false, status: 409, message: "no history to undo" };
      }

      const targetRev = Number.isInteger(latest.rolledBackFrom) ? latest.rolledBackFrom : current.rev - 1;
      if (!Number.isInteger(targetRev) || targetRev < 1 || targetRev === current.rev) {
        return { ok: false, status: 409, message: "no undo target available" };
      }

      return this._restoreRevisionUnlocked(slug, current, targetRev, {
        action: "undo",
        undoOfRev: current.rev
      });
    });
  }

  async redo(slug) {
    return this.withLock(slug, async () => {
      const current = this.projects.get(slug);
      if (!current || !current.data) {
        return { ok: false, status: 404, message: "project not in memory" };
      }

      const history = readHistory(this.workspace, slug);
      const latest = history[history.length - 1];
      if (!latest || latest.action !== "undo" || !Number.isInteger(latest.undoOfRev)) {
        return { ok: false, status: 409, message: "no undo available to redo" };
      }

      return this._restoreRevisionUnlocked(slug, current, latest.undoOfRev, {
        action: "redo",
        redoOfRev: latest.rev
      });
    });
  }

  getSince(slug, fromRev) {
    const entry = this.projects.get(slug);
    if (!entry || !entry.data) return null;
    const events = historySince(this.workspace, slug, fromRev, entry.rev);
    return { slug, fromRev, currentRev: entry.rev, events };
  }

  revisions(slug) {
    const all = readHistory(this.workspace, slug);
    return all.map((e) => ({
      rev: e.rev,
      ts: e.ts,
      summary: e.summary || [],
      action: e.action || null,
      undoOfRev: e.undoOfRev,
      redoOfRev: e.redoOfRev,
      rolledBackFrom: e.rolledBackFrom,
      rolledBackTo: e.rolledBackTo,
      deletedFromRev: e.deletedFromRev,
      restoredFromRev: e.restoredFromRev
    }));
  }

  history(slug, { fromRev = 0, limit = 50 } = {}) {
    const entry = this.projects.get(slug);
    const all = readHistory(this.workspace, slug).filter((event) => event.rev > fromRev);
    if ((!entry || !entry.data) && all.length === 0) return null;
    const clampedLimit = Math.max(1, Math.min(limit, 200));
    const events = all.slice(-clampedLimit);
    const currentRev = entry?.rev ?? all.reduce((max, event) => {
      return Number.isInteger(event?.rev) && event.rev > max ? event.rev : max;
    }, 0);
    return {
      slug,
      fromRev,
      currentRev,
      deleted: !entry?.data,
      events,
      truncation: {
        applied: events.length < all.length,
        returned: events.length,
        totalAvailable: all.length,
        maxCount: clampedLimit
      }
    };
  }

  remove(filePath) {
    const slug = slugFromFile(filePath);
    if (!slug) return null;
    if (!this.projects.has(slug)) return null;
    this.projects.delete(slug);
    clearRuntimeOverlay(this.workspace, slug);
    return { slug, event: "REMOVE" };
  }

  async withLock(slug, fn) {
    const prev = this.locks.get(slug) || Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    const chained = prev.then(() => current);
    this.locks.set(slug, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(slug) === chained) {
        this.locks.delete(slug);
      }
    }
  }

  async applyMove(slug, { taskId, swimlaneId, priorityId, targetIndex }) {
    return this.withLock(slug, async () => {
      const file = trackerPath(this.workspace, slug);
      if (!existsSync(file)) {
        return { ok: false, status: 404, message: "project not found" };
      }
      const raw = readFileSync(file, "utf-8");
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return { ok: false, status: 500, message: `tracker file not parseable: ${e.message}` };
      }

      const idx = data.tasks.findIndex((t) => t.id === taskId);
      if (idx === -1) return { ok: false, status: 404, message: "task not found" };

      const laneIds = new Set(data.meta.swimlanes.map((s) => s.id));
      const priIds = new Set(data.meta.priorities.map((p) => p.id));
      if (!laneIds.has(swimlaneId))
        return { ok: false, status: 400, message: `unknown swimlaneId ${swimlaneId}` };
      if (!priIds.has(priorityId))
        return { ok: false, status: 400, message: `unknown priorityId ${priorityId}` };

      const [task] = data.tasks.splice(idx, 1);
      task.placement = { swimlaneId, priorityId };

      const insertBeforeIdsInCell = [];
      let seen = 0;
      for (const t of data.tasks) {
        if (t.placement.swimlaneId === swimlaneId && t.placement.priorityId === priorityId) {
          if (seen === targetIndex) insertBeforeIdsInCell.push(t.id);
          seen++;
        }
      }

      let inserted = false;
      if (typeof targetIndex === "number" && targetIndex >= 0 && insertBeforeIdsInCell.length > 0) {
        const anchorId = insertBeforeIdsInCell[0];
        const anchorIdx = data.tasks.findIndex((t) => t.id === anchorId);
        data.tasks.splice(anchorIdx, 0, task);
        inserted = true;
      }
      if (!inserted) {
        let lastCellIdx = -1;
        for (let i = 0; i < data.tasks.length; i++) {
          const t = data.tasks[i];
          if (t.placement.swimlaneId === swimlaneId && t.placement.priorityId === priorityId) {
            lastCellIdx = i;
          }
        }
        if (lastCellIdx >= 0) {
          data.tasks.splice(lastCellIdx + 1, 0, task);
        } else {
          data.tasks.push(task);
        }
      }

      const { ok, errors } = validateProject(data);
      if (!ok) return { ok: false, status: 400, message: errors.join("; ") };

      atomicWriteJson(file, data);
      return { ok: true };
    });
  }

  async applyCollapse(slug, { swimlaneId, collapsed }) {
    return this.withLock(slug, async () => {
      // In-memory-first — the merge layer protects `collapsed` from LLM
      // writes, so a file-level round-trip would be overridden. Update
      // memory first, then write the file; the chokidar re-ingest no-ops.
      const current = this.projects.get(slug);
      if (!current || !current.data) {
        return { ok: false, status: 404, message: "project not found" };
      }
      const file = trackerPath(this.workspace, slug);
      const lane = current.data.meta.swimlanes.find((s) => s.id === swimlaneId);
      if (!lane) return { ok: false, status: 404, message: "swimlane not found" };

      const newState = JSON.parse(JSON.stringify(current.data));
      const newLane = newState.meta.swimlanes.find((s) => s.id === swimlaneId);
      newLane.collapsed = !!collapsed;

      const baseRev = current.rev;
      const newRev = baseRev + 1;
      newState.meta.rev = newRev;
      newState.meta.updatedAt = new Date().toISOString();

      const { ok, errors } = validateProject(newState);
      if (!ok) return { ok: false, status: 400, message: errors.join("; ") };

      const delta = computeDelta(current.data, newState);
      const persisted = this._persistProject(
        slug,
        file,
        current.base || current.data,
        newState,
        current.overlayEnabled === true
      );
      const entry = this._entry(slug, file, newState, persisted.base, newRev, defaultNotes());
      entry.overlayEnabled = persisted.overlayEnabled;
      this.projects.set(slug, entry);

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      return { ok: true, newRev };
    });
  }

  async applySwimlaneMove(slug, { swimlaneId, direction }) {
    return this.withLock(slug, async () => {
      const current = this.projects.get(slug);
      if (!current || !current.data) {
        return { ok: false, status: 404, message: "project not found" };
      }
      if (!swimlaneId || (direction !== "up" && direction !== "down")) {
        return { ok: false, status: 400, message: "swimlaneId and direction (up|down) required" };
      }

      const file = trackerPath(this.workspace, slug);
      const newState = JSON.parse(JSON.stringify(current.data));
      const lanes = newState.meta?.swimlanes;
      if (!Array.isArray(lanes)) {
        return { ok: false, status: 500, message: "project has no swimlanes" };
      }

      const index = lanes.findIndex((lane) => lane.id === swimlaneId);
      if (index === -1) return { ok: false, status: 404, message: "swimlane not found" };

      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= lanes.length) {
        return { ok: true, noop: true, newRev: current.rev };
      }

      const [lane] = lanes.splice(index, 1);
      lanes.splice(targetIndex, 0, lane);

      const baseRev = current.rev;
      const newRev = baseRev + 1;
      newState.meta.rev = newRev;
      newState.meta.updatedAt = new Date().toISOString();

      const { ok, errors } = validateProject(newState);
      if (!ok) return { ok: false, status: 400, message: errors.join("; ") };

      const delta = computeDelta(current.data, newState);
      const persisted = this._persistProject(
        slug,
        file,
        current.base || current.data,
        newState,
        current.overlayEnabled === true
      );
      const entry = this._entry(slug, file, newState, persisted.base, newRev, defaultNotes());
      entry.overlayEnabled = persisted.overlayEnabled;
      this.projects.set(slug, entry);

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      return { ok: true, newRev };
    });
  }
}
