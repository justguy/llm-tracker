// Compute a structured delta between two project states. Suitable for
// streaming "changes since rev N" to an LLM without resending the whole file.

function diffObj(a, b, skip = new Set()) {
  const out = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) {
      out[k] = b?.[k];
    }
  }
  return out;
}

export function computeDelta(prev, current) {
  const delta = {};
  const prevTasks = prev?.tasks || [];
  const currTasks = current?.tasks || [];

  const metaSkip = new Set(["updatedAt", "rev"]);
  const metaDelta = diffObj(prev?.meta || {}, current?.meta || {}, metaSkip);
  if (Object.keys(metaDelta).length > 0) delta.meta = metaDelta;

  const prevById = new Map(prevTasks.map((t) => [t.id, t]));
  const currById = new Map(currTasks.map((t) => [t.id, t]));
  const taskDelta = {};
  for (const [id, t] of currById) {
    const p = prevById.get(id);
    if (!p) {
      taskDelta[id] = { __added__: t };
      continue;
    }
    const td = diffObj(p, t, new Set(["id", "updatedAt", "rev"]));
    if (Object.keys(td).length > 0) taskDelta[id] = td;
  }
  for (const id of prevById.keys()) {
    if (!currById.has(id)) {
      taskDelta[id] = { __removed__: true };
    }
  }
  if (Object.keys(taskDelta).length > 0) delta.tasks = taskDelta;

  const prevOrder = prevTasks.map((t) => t.id);
  const currOrder = currTasks.map((t) => t.id);
  if (JSON.stringify(prevOrder) !== JSON.stringify(currOrder)) {
    delta.order = currOrder;
  }

  return delta;
}

export function hasChanges(delta) {
  return !!(delta.meta || delta.tasks || delta.order);
}

// Human-readable summary derived from a structured delta. Used for history /
// recent-activity logs.
export function summarize(delta) {
  const out = [];
  if (delta.meta) {
    for (const k of Object.keys(delta.meta)) {
      out.push({ kind: "meta", key: k, to: delta.meta[k] });
    }
  }
  if (delta.tasks) {
    for (const [id, td] of Object.entries(delta.tasks)) {
      if (td.__added__) {
        out.push({ kind: "added", id, title: td.__added__.title, status: td.__added__.status });
      } else if (td.__removed__) {
        out.push({ kind: "removed", id });
      } else {
        if (td.status !== undefined) out.push({ kind: "status", id, to: td.status });
        if (td.placement !== undefined) out.push({ kind: "placement", id, to: td.placement });
        if (td.assignee !== undefined) out.push({ kind: "assignee", id, to: td.assignee });
        const otherKeys = Object.keys(td).filter(
          (k) => !["status", "placement", "assignee"].includes(k)
        );
        if (otherKeys.length > 0) out.push({ kind: "edit", id, keys: otherKeys });
      }
    }
  }
  if (delta.order) out.push({ kind: "reorder", total: delta.order.length });
  return out;
}
