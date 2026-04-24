export function parsePortDraft(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const port = Number(normalized);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function shouldSuspendGlobalShortcuts({
  helpOpen = false,
  settingsOpen = false,
  historyOpen = false,
  projectIntel = null,
  taskModal = null,
  drawerOpen = false,
  drawerPinned = false
} = {}) {
  return (
    helpOpen ||
    settingsOpen ||
    historyOpen ||
    !!projectIntel ||
    !!taskModal ||
    (drawerOpen && !drawerPinned)
  );
}

export function selectActiveSlugAfterProjectsChange(activeSlug, projects = {}) {
  if (!activeSlug || projects[activeSlug]) return activeSlug || null;
  return Object.keys(projects).sort()[0] || null;
}

export function fuzzyMatchMapForPane({ searchMode, fuzzyState, filter, slug, fuzzyMatchMap }) {
  if (searchMode !== "fuzzy") return null;
  if (fuzzyState?.slug !== slug || fuzzyState?.query !== filter) return null;
  return fuzzyMatchMap;
}

export function taskDeleteUrl(slug, taskId) {
  return `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`;
}

export function nextTaskDrawerState(current, slug, taskId, mode = "brief") {
  if (current?.slug === slug && current?.taskId === taskId && current?.mode === mode) {
    return null;
  }
  return { slug, taskId, mode };
}
