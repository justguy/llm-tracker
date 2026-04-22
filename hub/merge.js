// Hub-authoritative merge: takes existing (may be null) + incoming patch/full,
// returns a new full project state. Preserves array order, preserves
// human-owned fields (meta.swimlanes[i].collapsed), refuses deletions.

export function mergeProject(existing, incoming) {
  const notes = { ignored: [], warnings: [], appended: [], updated: [] };

  if (!existing) {
    return { merged: incoming, notes };
  }

  const merged = JSON.parse(JSON.stringify(existing));

  // Tombstone list of task ids the human has explicitly deleted. Hub-owned —
  // incoming writes cannot set or clear it, and incoming task updates that
  // target a tombstoned id are dropped with a warning.
  const tombstones = new Set(
    Array.isArray(existing?.meta?.deleted_tasks) ? existing.meta.deleted_tasks : []
  );

  // ── meta ─────────────────────────────────────────────────────────
  if (incoming && incoming.meta) {
    for (const [k, v] of Object.entries(incoming.meta)) {
      if (k === "updatedAt" || k === "rev" || k === "deleted_tasks") {
        notes.ignored.push(`meta.${k} is hub-owned`);
        continue;
      }
      if (k === "swimlanes") continue;
      merged.meta[k] = v;
    }
    if (incoming.meta.swimlanes) {
      const existingLanes = existing.meta.swimlanes || [];
      const incomingById = new Map((incoming.meta.swimlanes || []).map((lane) => [lane.id, lane]));
      const existingIds = new Set(existingLanes.map((lane) => lane.id));
      const nextLanes = [];

      for (const prevLane of existingLanes) {
        const lane = incomingById.get(prevLane.id);
        if (!lane) {
          nextLanes.push(prevLane);
          continue;
        }
        const out = { ...lane };
        if ("collapsed" in prevLane) {
          if ("collapsed" in lane && lane.collapsed !== prevLane.collapsed) {
            notes.ignored.push(
              `meta.swimlanes[${lane.id}].collapsed is human-owned (kept existing)`
            );
          }
          out.collapsed = prevLane.collapsed;
        } else if ("collapsed" in lane) {
          notes.ignored.push(
            `meta.swimlanes[${lane.id}].collapsed is human-owned (dropped)`
          );
          delete out.collapsed;
        }
        nextLanes.push(out);
      }

      for (const lane of incoming.meta.swimlanes) {
        if (existingIds.has(lane.id)) continue;
        const out = { ...lane };
        if ("collapsed" in lane) {
          notes.ignored.push(
            `meta.swimlanes[${lane.id}].collapsed is human-owned (dropped)`
          );
          delete out.collapsed;
        }
        nextLanes.push(out);
      }

      merged.meta.swimlanes = nextLanes;
    }
  }

  // ── tasks ────────────────────────────────────────────────────────
  if (incoming && incoming.tasks) {
    const incomingArr = Array.isArray(incoming.tasks)
      ? incoming.tasks
      : Object.entries(incoming.tasks).map(([id, t]) => ({ id, ...t }));

    const incomingById = new Map(incomingArr.map((t) => [t.id, t]));
    const existingArr = existing.tasks || [];
    const existingIds = new Set(existingArr.map((t) => t.id));
    const isFullWrite = Array.isArray(incoming.tasks);

    const next = [];
    for (const e of existingArr) {
      const patch = incomingById.get(e.id);
      if (patch) {
        next.push(mergeTask(e, patch, notes));
      } else {
        if (isFullWrite) {
          notes.warnings.push(
            `task ${e.id} missing from full-write incoming; kept existing (use UI to delete)`
          );
        }
        next.push(e);
      }
    }
    for (const inc of incomingArr) {
      if (existingIds.has(inc.id)) continue;
      if (tombstones.has(inc.id)) {
        notes.ignored.push(
          `task ${inc.id} was deleted by a human; refusing to resurrect (pick a new id if you need to reopen the work)`
        );
        continue;
      }
      const defaulted = { dependencies: [], ...inc };
      next.push(defaulted);
      notes.appended.push(inc.id);
    }
    merged.tasks = next;
  }

  return { merged, notes };
}

// Shallow-merge with null-as-delete for freeform per-key maps like `context`.
// Callers that need structural cleanup of existing keys can now pass
// `{ key: null }` in the patch to drop that key rather than having to reach for
// a full-replace path.
function mergeContextWithDeletes(existing, patch, notes, taskId) {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) {
      if (k in out) {
        delete out[k];
        notes.warnings.push(`tasks[${taskId}].context.${k} deleted by patch`);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mergeTask(existing, patch, notes) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    if (k === "updatedAt" || k === "rev") {
      notes.ignored.push(`tasks[${existing.id}].${k} is hub-owned`);
      continue;
    }
    if (k === "context") {
      out.context = mergeContextWithDeletes(existing.context, patch.context, notes, existing.id);
    } else if (k === "placement") {
      out.placement = { ...(existing.placement || {}), ...(patch.placement || {}) };
    } else {
      out[k] = v;
    }
  }
  notes.updated.push(existing.id);
  return out;
}

// Stable serialization compare — helpful to decide "did the merge change
// anything?" without triggering redundant rewrites.
export function stableEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
