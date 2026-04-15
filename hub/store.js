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
import { validateProject } from "./validator.js";
import { deriveProject } from "./progress.js";
import { mergeProject, stableEq } from "./merge.js";
import { computeDelta, hasChanges, summarize } from "./versioning.js";
import {
  writeSnapshot,
  readSnapshot,
  maxRev,
  appendHistoryEntry,
  historySince,
  readHistory
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
  const body = {
    timestamp: new Date().toISOString(),
    kind: err.kind,
    message: err.message,
    path: trackerPath(workspace, slug)
  };
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

export class Store {
  constructor(workspace) {
    this.workspace = workspace;
    this.projects = new Map();
    this.locks = new Map();
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

  ingest(filePath, rawContents) {
    const slug = slugFromFile(filePath);
    if (!slug) return { ok: false, reason: "not-a-tracker" };

    let incoming;
    try {
      incoming = JSON.parse(rawContents);
    } catch (e) {
      return this._recordError(slug, filePath, { kind: "parse", message: e.message });
    }

    let prev = this.projects.get(slug);

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
            const derived = deriveProject(incoming);
            const entry = {
              data: incoming,
              derived,
              path: filePath,
              rev: incomingRev,
              error: null,
              notes: { ignored: [], warnings: [], appended: [], updated: [] }
            };
            this.projects.set(slug, entry);
            clearErrorFile(this.workspace, slug);
            return { ok: true, slug, event: "UPDATE", project: entry, resumed: true };
          }
          // Snapshot differs from incoming — treat snapshot as the prev baseline.
          prev = { data: snap, rev: incomingRev };
        }
      }
    }

    const prevData = prev?.data || null;
    const { merged, notes } = mergeProject(prevData, incoming);

    const { ok, errors } = validateProject(merged);
    if (!ok) {
      return this._recordError(slug, filePath, { kind: "schema", message: errors.join("; ") });
    }

    const delta = computeDelta(prevData, merged);
    if (!hasChanges(delta) && prev?.data) {
      // In-memory state is unchanged. If the file on disk differs from what we
      // want (e.g., LLM tried to reorder or flip collapsed), correct it without
      // bumping rev.
      if (!stableEq(normalizeForCompare(merged), normalizeForCompare(incoming))) {
        merged.meta.rev = prev.rev;
        merged.meta.updatedAt = prev.data.meta.updatedAt;
        try {
          atomicWriteJson(filePath, merged);
        } catch {}
      }
      return { ok: true, slug, event: "UPDATE", project: prev, noop: true };
    }

    const baseRev = prev?.rev ?? incoming?.meta?.rev ?? 0;
    const newRev = baseRev + 1;

    merged.meta.rev = newRev;
    merged.meta.updatedAt = new Date().toISOString();

    try {
      atomicWriteJson(filePath, merged);
    } catch {}

    writeSnapshot(this.workspace, slug, newRev, merged);
    appendHistoryEntry(this.workspace, slug, {
      rev: newRev,
      ts: merged.meta.updatedAt,
      delta,
      summary: summarize(delta)
    });

    const derived = deriveProject(merged);
    const entry = {
      data: merged,
      derived,
      path: filePath,
      rev: newRev,
      error: null,
      notes
    };
    this.projects.set(slug, entry);
    clearErrorFile(this.workspace, slug);

    return { ok: true, slug, event: "UPDATE", project: entry, delta, notes };
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

      const baseRev = current.rev;
      const newRev = baseRev + 1;
      newState.meta.rev = newRev;
      newState.meta.updatedAt = new Date().toISOString();

      const { ok, errors } = validateProject(newState);
      if (!ok) return { ok: false, status: 400, message: errors.join("; ") };

      const delta = computeDelta(current.data, newState);
      const derived = deriveProject(newState);

      this.projects.set(slug, {
        data: newState,
        derived,
        path: file,
        rev: newRev,
        error: null,
        notes: { ignored: [], warnings: [], appended: [], updated: [] }
      });

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      atomicWriteJson(file, newState);
      return { ok: true, newRev };
    });
  }

  async deleteProject(slug) {
    return this.withLock(slug, async () => {
      const file = trackerPath(this.workspace, slug);
      if (!existsSync(file)) {
        return { ok: false, status: 404, message: "project not found" };
      }
      try {
        unlinkSync(file);
      } catch (e) {
        return { ok: false, status: 500, message: `delete failed: ${e.message}` };
      }
      clearErrorFile(this.workspace, slug);
      // chokidar fires unlink → store.remove() → broadcast REMOVE.
      // Snapshots and history are preserved for audit.
      return { ok: true };
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
      let existing;
      try {
        existing = JSON.parse(readFileSync(file, "utf-8"));
      } catch (e) {
        return { ok: false, status: 500, message: `tracker file not parseable: ${e.message}` };
      }

      const { merged, notes } = mergeProject(existing, patch);
      const { ok, errors } = validateProject(merged);
      if (!ok) return { ok: false, status: 400, message: errors.join("; "), notes };

      atomicWriteJson(file, merged);
      return { ok: true, notes };
    });
  }

  async pickTask(slug, { taskId, assignee = null, force = false, comment } = {}) {
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

      const derived = deriveProject(newState);
      this.projects.set(slug, {
        data: newState,
        derived,
        path: file,
        rev: newRev,
        error: null,
        notes: { ignored: [], warnings: [], appended: [], updated: [] }
      });

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      atomicWriteJson(file, newState);

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

  async rollback(slug, toRev) {
    return this.withLock(slug, async () => {
      const snap = readSnapshot(this.workspace, slug, toRev);
      if (!snap) {
        return { ok: false, status: 404, message: `no snapshot for rev ${toRev}` };
      }
      const current = this.projects.get(slug);
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
      const derived = deriveProject(newState);

      // In-memory first so the chokidar event from the file write is a no-op.
      this.projects.set(slug, {
        data: newState,
        derived,
        path: current.path,
        rev: newRev,
        error: null,
        notes: { ignored: [], warnings: [], appended: [], updated: [] }
      });

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta),
        rolledBackFrom: baseRev,
        rolledBackTo: toRev
      });

      atomicWriteJson(current.path, newState);

      return { ok: true, from: baseRev, to: toRev, newRev };
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
      rolledBackFrom: e.rolledBackFrom,
      rolledBackTo: e.rolledBackTo
    }));
  }

  remove(filePath) {
    const slug = slugFromFile(filePath);
    if (!slug) return null;
    if (!this.projects.has(slug)) return null;
    this.projects.delete(slug);
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
      const derived = deriveProject(newState);

      this.projects.set(slug, {
        data: newState,
        derived,
        path: file,
        rev: newRev,
        error: null,
        notes: { ignored: [], warnings: [], appended: [], updated: [] }
      });

      writeSnapshot(this.workspace, slug, newRev, newState);
      appendHistoryEntry(this.workspace, slug, {
        rev: newRev,
        ts: newState.meta.updatedAt,
        delta,
        summary: summarize(delta)
      });

      atomicWriteJson(file, newState);
      return { ok: true, newRev };
    });
  }
}
