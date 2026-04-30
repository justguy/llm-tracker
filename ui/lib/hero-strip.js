const SCORE = { not_started: 0, in_progress: 0.5, complete: 1, deferred: 0 };

export function pctForTasks(tasks = []) {
  if (tasks.length === 0) return 0;
  let score = 0;
  let denom = 0;
  for (const task of tasks) {
    if (task.status === "deferred") continue;
    denom += 1;
    score += SCORE[task.status] ?? 0;
  }
  return denom === 0 ? 0 : Math.round((score / denom) * 100);
}

function compactHomePath(value) {
  return typeof value === "string"
    ? value.replace(/^\/Users\/[^/]+/, "~")
    : "";
}

export function formatHeroPath(project, slug) {
  const file = typeof project?.file === "string"
    ? project.file
    : typeof project?.data?.meta?.workspace === "string"
      ? project.data.meta.workspace
      : "";
  if (!file) return slug ? `~/${slug}` : "";

  let basePath = file;
  if (/^\/Users\/[^/]+\/\.llm-tracker\/trackers\/[^/]+\.json$/.test(file)) {
    basePath = file.replace(/\/trackers\/[^/]+\.json$/, "");
  } else {
    basePath = file
      .replace(/\/\.llm-tracker\/trackers\/[^/]+\.json$/, "")
      .replace(/\/\.phalanx\/[^/]+\.json$/, "")
      .replace(/\/trackers\/[^/]+\.json$/, "");
  }

  return compactHomePath(basePath);
}

export function buildHeroReason(task) {
  if (!task) return "";
  const parts = [];
  if (task.actionability === "executable" || task.ready) parts.push("highest-ranked executable task");
  if (task.priorityId) parts.push(task.priorityId);
  if (task.dependenciesResolved || (Array.isArray(task.blocking_on) && task.blocking_on.length === 0)) {
    parts.push("dependencies satisfied");
  }
  if (task.status === "in_progress") parts.push("already in progress");
  if (Array.isArray(task.decision_required) && task.decision_required.length > 0) {
    parts.push(`decision needed: ${task.decision_required.join(", ")}`);
  }
  return parts.join(" · ") || "executable work";
}

export function buildHeroSummary(project, slug) {
  const data = project?.data || {};
  const meta = data.meta || {};
  const tasks = data.tasks || [];
  const derived = project?.derived || {};
  const total = derived.total ?? tasks.length;
  const counts = derived.counts || {};
  const complete = counts.complete || 0;
  const inProgress = counts.in_progress || 0;
  const notStarted = counts.not_started || 0;
  const deferred = counts.deferred || 0;
  const blockedCount = Object.keys(derived.blocked || {}).length;
  const openCount = Math.max(0, total - blockedCount);
  const pct = typeof derived.pct === "number" ? derived.pct : pctForTasks(tasks);
  const completeW = total == 0 ? 0 : (complete / total) * 100;
  const warnW = total == 0 ? 0 : (inProgress / total) * 100;

  return {
    total,
    complete,
    inProgress,
    notStarted,
    deferred,
    blockedCount,
    openCount,
    pct,
    completeW,
    warnW,
    projectName: meta.name || slug,
    trackerPath: formatHeroPath(project, slug),
    swimlaneCount: (meta.swimlanes || []).length,
    updatedAt: meta.updatedAt ? new Date(meta.updatedAt).toLocaleTimeString() : "—",
    statusTiles: [
      { label: "Complete", key: "complete", count: complete, color: "var(--ok)", strong: true },
      { label: "In progress", key: "in_progress", count: inProgress, color: "var(--warn)", strong: false },
      { label: "Not started", key: "not_started", count: notStarted, color: "var(--ink-3)", strong: false },
      { label: "Deferred", key: "deferred", count: deferred, color: "var(--ink-3)", strong: false },
      { label: "Blocked", key: "blocked", count: blockedCount, color: "var(--block)", strong: false },
      { label: "Open", key: "open", count: openCount, color: "var(--ink-2)", strong: true },
    ],
  };
}
