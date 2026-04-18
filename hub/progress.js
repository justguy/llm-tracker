import { STATUS_VALUES } from "./validator.js";

const SCORE = { not_started: 0, in_progress: 0.5, complete: 1, deferred: 0 };

export function zeroCounts() {
  const c = {};
  for (const s of STATUS_VALUES) c[s] = 0;
  return c;
}

export function countsFor(tasks) {
  const counts = zeroCounts();
  for (const t of tasks) {
    if (counts[t.status] !== undefined) counts[t.status] += 1;
  }
  return counts;
}

export function pctFor(tasks) {
  if (tasks.length === 0) return 0;
  let score = 0;
  let denom = 0;
  for (const t of tasks) {
    if (t.status === "deferred") continue;
    denom += 1;
    score += SCORE[t.status] ?? 0;
  }
  return denom === 0 ? 0 : Math.round((score / denom) * 100);
}

export function deriveBlocked(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blocked = {};
  for (const t of tasks) {
    const open = [];
    for (const dep of t.dependencies || []) {
      const d = byId.get(dep);
      if (d && d.status !== "complete") open.push(dep);
    }
    if (open.length > 0) blocked[t.id] = open;
  }
  return blocked;
}

export function deriveProject(data) {
  const perSwimlane = {};
  for (const lane of data.meta.swimlanes) {
    const laneTasks = data.tasks.filter((t) => t.placement.swimlaneId === lane.id);
    perSwimlane[lane.id] = {
      counts: countsFor(laneTasks),
      pct: pctFor(laneTasks),
      total: laneTasks.length
    };
  }
  return {
    counts: countsFor(data.tasks),
    pct: pctFor(data.tasks),
    total: data.tasks.length,
    perSwimlane,
    blocked: deriveBlocked(data.tasks)
  };
}
