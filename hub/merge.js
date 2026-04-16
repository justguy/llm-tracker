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
      const prev = new Map((existing.meta.swimlanes || []).map((l) => [l.id, l]));
      merged.meta.swimlanes = incoming.meta.swimlanes.map((lane) => {
        const p = prev.get(lane.id);
        const out = { ...lane };
        if (p && "collapsed" in p) {
          if ("collapsed" in lane && lane.collapsed !== p.collapsed) {
            notes.ignored.push(
              `meta.swimlanes[${lane.id}].collapsed is human-owned (kept existing)`
            );
          }
          out.collapsed = p.collapsed;
        } else if ("collapsed" in lane) {
          notes.ignored.push(
            `meta.swimlanes[${lane.id}].collapsed is human-owned (dropped)`
          );
          delete out.collapsed;
        }
        return out;
      });
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

function mergeTask(existing, patch, notes) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    if (k === "updatedAt" || k === "rev") {
      notes.ignored.push(`tasks[${existing.id}].${k} is hub-owned`);
      continue;
    }
    if (k === "context") {
      out.context = { ...(existing.context || {}), ...(patch.context || {}) };
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
