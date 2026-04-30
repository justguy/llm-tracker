import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { html } from "htm/preact";
import { Header } from "./header.js";
import { HistoryModal } from "./modals/history.js";
import { HelpModal } from "./modals/help.js";
import { ProjectIntelligenceModal, TaskIntelligenceModal } from "./modals/intelligence.js";
import { SettingsModal } from "./modals/settings.js";
import { CommandPalette } from "./palette.js";
import { ErrorBanner, ProjectPane } from "./project-pane.js";
import { ScratchpadRow } from "./scratchpad-row.js";
import { ConnectionPip, Drawer, EmptyState } from "./shell-chrome.js";
import {
  deleteProject,
  deleteTask,
  fetchFuzzySearch,
  fetchWorkspace,
  patchProject,
  postProjectJson
} from "./api-client.js";
import { FilterToggles } from "./primitives.js";
import { loadSettings, saveSettings } from "./settings-storage.js";
import {
  fuzzyMatchMapForPane,
  nextTaskDrawerState,
  parsePortDraft,
  selectActiveSlugAfterProjectsChange,
  shouldSuspendGlobalShortcuts,
  taskDeleteUrl
} from "./app-logic.js";
import {
  buildTreeModel,
  collectTreeCollapseIds,
  buildDependencyGraphModel,
  layoutDependencyGraph
} from "./board-models.js";
import {
  HeroStrip,
  HeroStripView,
  loadNextRecommendation
} from "./hero-strip.js";

export {
  fuzzyMatchMapForPane,
  nextTaskDrawerState,
  parsePortDraft,
  selectActiveSlugAfterProjectsChange,
  shouldSuspendGlobalShortcuts,
  taskDeleteUrl,
  buildTreeModel,
  collectTreeCollapseIds,
  buildDependencyGraphModel,
  layoutDependencyGraph,
  HeroStripView,
  loadNextRecommendation
};

// ─────── App ───────
function App() {
  const initialSettings = useMemo(() => loadSettings(), []);
  const [workspace, setWorkspace] = useState(null);
  const [projects, setProjects] = useState({});
  const [activeSlug, setActiveSlug] = useState(initialSettings.activeSlug || null);
  const [filter, setFilter] = useState("");
  const [searchMode, setSearchMode] = useState("filter");
  const [boardView, setBoardView] = useState(["tree", "graph"].includes(initialSettings.boardView) ? initialSettings.boardView : "swimlane");
  const [fuzzyState, setFuzzyState] = useState({
    slug: null,
    query: "",
    matches: [],
    loading: false,
    error: null
  });
  const [wsUp, setWsUp] = useState(false);
  const [theme, setTheme] = useState(initialSettings.theme || "dark");
  const [headerCollapsed, setHeaderCollapsed] = useState(!!initialSettings.headerCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(!!initialSettings.drawerPinned);
  const [drawerPinned, setDrawerPinned] = useState(!!initialSettings.drawerPinned);
  const [pinnedSlugs, setPinnedSlugs] = useState(() =>
    Array.isArray(initialSettings.pinnedSlugs) ? initialSettings.pinnedSlugs : []
  );
  const [scratchpadExpanded, setScratchpadExpanded] = useState(() =>
    initialSettings.scratchpadExpanded && typeof initialSettings.scratchpadExpanded === "object"
      ? initialSettings.scratchpadExpanded
      : {}
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [projectIntel, setProjectIntel] = useState(null);
  const [taskDrawer, setTaskDrawer] = useState(null);
  const [taskModal, setTaskModal] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [statusFilters, setStatusFilters] = useState(() => new Set());
  const [blockFilters, setBlockFilters] = useState(() => new Set());

  const toggleStatus = (s) =>
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const toggleBlock = (b) =>
    setBlockFilters((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  const shortcutsSuspended = shouldSuspendGlobalShortcuts({
    helpOpen,
    settingsOpen,
    historyOpen,
    projectIntel,
    taskModal,
    drawerOpen,
    drawerPinned
  });

  // Persist settings
  useEffect(() => {
    saveSettings({ theme, headerCollapsed, drawerPinned, pinnedSlugs, scratchpadExpanded, activeSlug, boardView });
  }, [theme, headerCollapsed, drawerPinned, pinnedSlugs, scratchpadExpanded, activeSlug, boardView]);

  // Apply theme class on root
  useEffect(() => {
    document.documentElement.classList.toggle("theme-light", theme === "light");
  }, [theme]);

  // Global ⌘K / Ctrl+K toggle
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Global shortcut keys: / n p
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (shortcutsSuspended) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" ) { e.preventDefault(); setPaletteOpen(true); }
      if (e.key === "n") { e.preventDefault(); onOpenProjectIntel("next"); }
      if (e.key === "p") { e.preventDefault(); activeSlug && onPickTask(activeSlug); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeSlug, shortcutsSuspended]);

  useEffect(() => {
    fetchWorkspace().then(setWorkspace).catch(() => {});
  }, []);

  useEffect(() => {
    if (searchMode !== "fuzzy" || !activeSlug || !filter.trim()) {
      setFuzzyState((prev) => ({
        ...prev,
        slug: activeSlug,
        query: filter,
        matches: [],
        loading: false,
        error: null
      }));
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setFuzzyState((prev) => ({
        ...prev,
        slug: activeSlug,
        query: filter,
        loading: true,
        error: null
      }));

      fetchFuzzySearch(activeSlug, filter, { signal: controller.signal })
        .then((payload) => {
          setFuzzyState({
            slug: activeSlug,
            query: filter,
            matches: payload.matches || [],
            model: payload.model || null,
            loading: false,
            error: null
          });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setFuzzyState({
            slug: activeSlug,
            query: filter,
            matches: [],
            model: null,
            loading: false,
            error: error.message
          });
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchMode, activeSlug, filter]);

  useEffect(() => {
    let ws;
    let retryTimer;
    let closing = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setWsUp(true);
      ws.onclose = () => {
        if (closing) return;
        setWsUp(false);
        retryTimer = setTimeout(connect, 1000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "SNAPSHOT") {
          setProjects(msg.projects || {});
          setActiveSlug((prev) => {
            if (prev && msg.projects[prev]) return prev;
            const slugs = Object.keys(msg.projects || {});
            return slugs.length > 0 ? slugs[0] : null;
          });
        } else if (msg.type === "UPDATE" || msg.type === "ERROR") {
          setProjects((prev) => ({ ...prev, [msg.slug]: msg.project }));
          setActiveSlug((prev) => prev || msg.slug);
        } else if (msg.type === "REMOVE") {
          setProjects((prev) => {
            const next = { ...prev };
            delete next[msg.slug];
            return next;
          });
        }
      };
    };
    connect();
    return () => {
      closing = true;
      clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
    };
  }, []);

  const onMove = async (slug, { taskId, swimlaneId, priorityId, targetIndex }) => {
    if (!slug) return;
    try {
      const { response, body } = await postProjectJson(slug, "move", { taskId, swimlaneId, priorityId, targetIndex });
      if (!response.ok) {
        alert(`Move failed: ${body.error || response.statusText}`);
      }
    } catch (e) {
      alert(`Move failed: ${e.message}`);
    }
  };

  const onSaveComment = async (slug, taskId, value) => {
    if (!slug || !taskId) return false;
    try {
      const { response, body } = await patchProject(slug, { tasks: { [taskId]: { comment: value } } });
      if (!response.ok) {
        alert(`Save comment failed: ${body.error || response.statusText}`);
        return false;
      }
      return true;
    } catch (e) {
      alert(`Save comment failed: ${e.message}`);
      return false;
    }
  };

  const onToggleCollapse = async (slug, swimlaneId, collapsed) => {
    if (!slug) return;
    try {
      const { response, body } = await postProjectJson(slug, "swimlane-collapse", { swimlaneId, collapsed });
      if (!response.ok) {
        alert(`Swimlane update failed: ${body.error || response.statusText}`);
      }
    } catch (e) {
      alert(`Swimlane update failed: ${e.message}`);
    }
  };

  const onMoveLane = async (slug, swimlaneId, direction) => {
    if (!slug || !swimlaneId) return;
    try {
      const { response, body } = await postProjectJson(slug, "swimlane-move", { swimlaneId, direction });
      if (!response.ok) {
        alert(`Swimlane move failed: ${body.error || response.statusText}`);
      }
    } catch (e) {
      alert(`Swimlane move failed: ${e.message}`);
    }
  };

  const onCollapseAll = () => {
    const slug = activeSlug;
    const lanes = projects[slug]?.data?.meta?.swimlanes;
    if (!slug || !lanes) return;
    for (const lane of lanes) onToggleCollapse(slug, lane.id, true);
  };

  const onExpandAll = () => {
    const slug = activeSlug;
    const lanes = projects[slug]?.data?.meta?.swimlanes;
    if (!slug || !lanes) return;
    for (const lane of lanes) onToggleCollapse(slug, lane.id, false);
  };

  const onSelectProject = (slug) => {
    setActiveSlug(slug);
    if (!drawerPinned) setDrawerOpen(false);
  };

  const onOpenTaskDrawer = (slug, taskOrId, initialMode = "brief") => {
    if (!slug || !taskOrId) return;
    const projectTasks = projects[slug]?.data?.tasks || [];
    const task = typeof taskOrId === "string"
      ? projectTasks.find((item) => item.id === taskOrId) || { id: taskOrId, title: taskOrId }
      : taskOrId;
    if (!task?.id) return;
    setActiveSlug(slug);
    setTaskDrawer((current) => nextTaskDrawerState(current, slug, task.id, initialMode));
  };

  const onOpenTaskModalHandler = (slug, taskOrId, mode = "brief") => {
    if (!slug || !taskOrId) return;
    const projectTasks = projects[slug]?.data?.tasks || [];
    const task = typeof taskOrId === "string"
      ? projectTasks.find((item) => item.id === taskOrId) || { id: taskOrId, title: taskOrId }
      : taskOrId;
    if (!task?.id) return;
    setTaskModal({ slug, task, mode });
  };

  const onOpenProjectIntel = (initialMode = "next") => {
    if (!activeSlug) return;
    setProjectIntel({ slug: activeSlug, initialMode });
  };

  const onPickTask = async (slug, taskId = null) => {
    if (!slug) return;
    try {
      const { response, body } = await postProjectJson(slug, "pick", taskId ? { taskId } : {});
      if (!response.ok) {
        alert(`Pick failed: ${body.error || response.statusText}`);
        return;
      }
      const pickedId = body.task?.id || body.pickedTaskId || taskId;
      if (pickedId) {
        setProjectIntel(null);
        onOpenTaskDrawer(slug, pickedId, "execute");
      }
    } catch (e) {
      alert(`Pick failed: ${e.message}`);
    }
  };

  const onToggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const paletteActions = [
    { label: "Collapse all lanes",        icon: "⊟", run: () => onCollapseAll() },
    { label: "Expand all lanes",          icon: "⊠", run: () => onExpandAll() },
    { label: "Jump to Recommended Next",  icon: "→", run: () => onOpenProjectIntel("next") },
    { label: "Show blockers",             icon: "⚠", run: () => onOpenProjectIntel("blockers") },
    { label: "Show changed since rev",    icon: "Δ", run: () => onOpenProjectIntel("changed") },
    { label: "Show decisions",            icon: "◈", run: () => onOpenProjectIntel("decisions") },
    { label: "Undo",                      icon: "↩", hint: "U", run: () => onUndo() },
    { label: "Redo",                      icon: "↪", hint: "R", run: () => onRedo() },
    { label: "Open history",              icon: "⎌", run: () => setHistoryOpen(true) },
    { label: "Open overview drawer",      icon: "◧", run: () => setDrawerOpen(true) },
    { label: "Open settings",             icon: "⚙", run: () => setSettingsOpen(true) },
    { label: "Open help",                 icon: "?", run: () => setHelpOpen(true) },
    { label: "Toggle theme",              icon: "☼", hint: theme, run: () => onToggleTheme() },
    ...Object.keys(projects).sort().map((s) => ({
      label: `Switch project: ${projects[s]?.data?.meta?.name || s}`,
      icon: "◧",
      run: () => { setActiveSlug(s); if (!drawerPinned) setDrawerOpen(false); }
    }))
  ];

  const onTogglePin = () => setDrawerPinned((p) => !p);

  const onTogglePinProject = (slug) => {
    setPinnedSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const onToggleScratchpad = (slug) => {
    setScratchpadExpanded((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  const onSaveScratchpad = async (slug, text) => {
    if (!slug) return false;
    try {
      const { response, body } = await patchProject(slug, { meta: { scratchpad: text } });
      if (!response.ok) {
        alert(`Save scratchpad failed: ${body.error || response.statusText}`);
        return false;
      }
      return true;
    } catch (e) {
      alert(`Save scratchpad failed: ${e.message}`);
      return false;
    }
  };

  const slugs = Object.keys(projects).sort();
  const active = activeSlug ? projects[activeSlug] : null;
  const fuzzyMatchMap = useMemo(
    () => new Map((fuzzyState.matches || []).map((match) => [match.id, match])),
    [fuzzyState.matches]
  );
  const searchMeta = useMemo(() => {
    if (searchMode !== "fuzzy") return null;
    if (!filter.trim()) {
      return { kind: "muted", text: "FUZZY · deterministic lexical highlight mode keeps the board intact and marks near matches in context." };
    }
    if (fuzzyState.loading) return { kind: "muted", text: `FUZZY · searching "${filter}"…` };
    if (fuzzyState.error) return { kind: "error", text: `FUZZY · ${fuzzyState.error}` };
    return {
      kind: fuzzyState.matches.length > 0 ? "ok" : "muted",
      text: `FUZZY · ${fuzzyState.matches.length} hit${fuzzyState.matches.length === 1 ? "" : "s"} for "${filter}"`
    };
  }, [searchMode, filter, fuzzyState]);

  useEffect(() => {
    const nextSlug = selectActiveSlugAfterProjectsChange(activeSlug, projects);
    if (nextSlug === activeSlug) return;
    setActiveSlug(nextSlug);
  }, [activeSlug, projects]);

  useEffect(() => {
    if (projectIntel && !projects[projectIntel.slug]) {
      setProjectIntel(null);
    }
  }, [projectIntel, projects]);

  useEffect(() => {
    if (!taskDrawer) return;
    const project = projects[taskDrawer.slug];
    if (!project?.data) {
      setTaskDrawer(null);
      return;
    }
    if (!project.data.tasks.some((task) => task.id === taskDrawer.taskId)) {
      setTaskDrawer(null);
    }
  }, [taskDrawer, projects]);

  useEffect(() => {
    if (!taskModal) return;
    const project = projects[taskModal.slug];
    if (!project?.data) {
      setTaskModal(null);
      return;
    }
    if (!project.data.tasks.some((t) => t.id === taskModal.task?.id)) {
      setTaskModal(null);
    }
  }, [taskModal, projects]);

  const onDeleteTask = async (slug, task) => {
    if (!slug) return;
    const ok = window.confirm(
      `Delete task "${task.title}" (${task.id})?\n\nThis bumps the project rev. Use [UNDO] to revert.`
    );
    if (!ok) return;
    try {
      const { response, body } = await deleteTask(taskDeleteUrl(slug, task.id));
      if (!response.ok) {
        alert(`Delete failed: ${body.error || response.statusText}`);
      }
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const onDeleteProject = async (slug) => {
    if (!slug) return;
    const entry = projects[slug];
    const name = entry?.data?.meta?.name || slug;
    const ok = window.confirm(
      `Delete project "${name}" (${slug})?\n\nThe tracker file will be removed. Snapshots and history are preserved in .snapshots/ and .history/.`
    );
    if (!ok) return;
    try {
      const { response, body } = await deleteProject(slug);
      if (!response.ok) {
        alert(`Delete failed: ${body.error || response.statusText}`);
      }
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const onUndo = async () => {
    if (!activeSlug || !active || !active.rev || active.rev < 2) return;
    const ok = window.confirm(
      `Undo the most recent effective change for ${activeSlug}?`
    );
    if (!ok) return;
    try {
      const { response, body } = await postProjectJson(activeSlug, "undo");
      if (!response.ok) {
        alert(`Undo failed: ${body.error || response.statusText}`);
      }
    } catch (e) {
      alert(`Undo failed: ${e.message}`);
    }
  };

  const onRedo = async () => {
    if (!activeSlug) return;
    try {
      const { response, body } = await postProjectJson(activeSlug, "redo");
      if (!response.ok) {
        alert(`Redo failed: ${body.error || response.statusText}`);
      }
    } catch (e) {
      alert(`Redo failed: ${e.message}`);
    }
  };

  const drawerEl = html`
    <${Drawer}
      open=${drawerOpen}
      pinned=${drawerPinned}
      onTogglePin=${onTogglePin}
      onClose=${() => setDrawerOpen(false)}
      projects=${projects}
      activeSlug=${activeSlug}
      onSelect=${onSelectProject}
      onDelete=${onDeleteProject}
      pinnedSlugs=${pinnedSlugs}
      onTogglePinProject=${onTogglePinProject}
    />
  `;
  const helpEl = helpOpen ? html`<${HelpModal} workspace=${workspace} onClose=${() => setHelpOpen(false)} />` : null;
  const historyEl = historyOpen && activeSlug
    ? html`<${HistoryModal} slug=${activeSlug} onClose=${() => setHistoryOpen(false)} />`
    : null;
  const projectIntelEl = projectIntel
    ? html`<${ProjectIntelligenceModal}
        slug=${projectIntel.slug}
        project=${projects[projectIntel.slug]}
        initialMode=${projectIntel.initialMode}
        onOpenTask=${(taskId, mode) => onOpenTaskDrawer(projectIntel.slug, taskId, mode)}
        onPickTask=${(taskId) => onPickTask(projectIntel.slug, taskId)}
        onClose=${() => setProjectIntel(null)}
      />`
    : null;
  const taskModalEl = taskModal
    ? html`<${TaskIntelligenceModal}
        slug=${taskModal.slug}
        task=${taskModal.task}
        initialMode=${taskModal.mode}
        onOpenTask=${(taskId, mode) => onOpenTaskDrawer(taskModal.slug, taskId, mode)}
        onClose=${() => setTaskModal(null)}
      />`
    : null;

  const shellPinned = drawerOpen && drawerPinned;
  const shellClass = `app-shell ${shellPinned ? "drawer-pinned" : ""}`;
  const settingsEl = settingsOpen
    ? html`<${SettingsModal}
        onClose=${() => setSettingsOpen(false)}
        theme=${theme}
        onToggleTheme=${onToggleTheme}
        drawerPinned=${drawerPinned}
        onToggleDrawerPin=${onTogglePin}
      />`
    : null;
  const paletteEl = html`
    <${CommandPalette}
      open=${paletteOpen}
      onClose=${() => setPaletteOpen(false)}
      projects=${projects}
      activeSlug=${activeSlug}
      actions=${paletteActions}
      onOpenTaskDrawer=${onOpenTaskDrawer}
      setActive=${setActiveSlug}
      onToggleCollapse=${onToggleCollapse}
    />
  `;
  const validPinned = pinnedSlugs.filter((s) => projects[s]);
  const paneSlugs = validPinned.length > 0 ? validPinned : [activeSlug];
  const pinnedProjectNames = paneSlugs
    .map((slug) => projects[slug]?.data?.meta?.name || slug)
    .filter(Boolean);

  if (slugs.length === 0) {
    return html`
      <div class=${shellClass}>
        <${Header}
          slugs=${slugs}
          projects=${projects}
          activeSlug=${activeSlug}
          setActive=${setActiveSlug}
          project=${null}
          pinnedProjectNames=${[]}
          workspace=${workspace}
          filter=${filter}
          setFilter=${setFilter}
          searchMode=${searchMode}
          onSearchModeChange=${setSearchMode}
          searchMeta=${null}
          headerCollapsed=${headerCollapsed}
          onToggleHeaderCollapse=${() => setHeaderCollapsed((v) => !v)}
          theme=${theme}
          onToggleTheme=${onToggleTheme}
          onOpenHelp=${() => setHelpOpen(true)}
          onOpenDrawer=${() => setDrawerOpen(true)}
          onOpenSettings=${() => setSettingsOpen(true)}
          onOpenHistory=${() => setHistoryOpen(true)}
          onOpenIntel=${onOpenProjectIntel}
          onUndo=${onUndo}
          onRedo=${onRedo}
          onDeleteProject=${onDeleteProject}
          onCollapseAll=${onCollapseAll}
          onExpandAll=${onExpandAll}
          onOpenPalette=${() => setPaletteOpen(true)}
          pinnedSlugs=${pinnedSlugs}
          onTogglePinProject=${onTogglePinProject}
        />
        <${EmptyState} workspace=${workspace} onOpenHelp=${() => setHelpOpen(true)} />
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
        ${taskModalEl}
        ${paletteEl}
      </div>
    `;
  }

  if (!active || !active.data) {
    const err = active?.error;
    return html`
      <div class=${shellClass}>
        <${Header}
          slugs=${slugs}
          projects=${projects}
          activeSlug=${activeSlug}
          setActive=${setActiveSlug}
          project=${active}
          pinnedProjectNames=${pinnedProjectNames}
          workspace=${workspace}
          filter=${filter}
          setFilter=${setFilter}
          searchMode=${searchMode}
          onSearchModeChange=${setSearchMode}
          searchMeta=${searchMeta}
          headerCollapsed=${headerCollapsed}
          onToggleHeaderCollapse=${() => setHeaderCollapsed((v) => !v)}
          theme=${theme}
          onToggleTheme=${onToggleTheme}
          onOpenHelp=${() => setHelpOpen(true)}
          onOpenDrawer=${() => setDrawerOpen(true)}
          onOpenSettings=${() => setSettingsOpen(true)}
          onOpenHistory=${() => setHistoryOpen(true)}
          onOpenIntel=${onOpenProjectIntel}
          onUndo=${onUndo}
          onRedo=${onRedo}
          onDeleteProject=${onDeleteProject}
          onCollapseAll=${onCollapseAll}
          onExpandAll=${onExpandAll}
          onOpenPalette=${() => setPaletteOpen(true)}
          pinnedSlugs=${pinnedSlugs}
          onTogglePinProject=${onTogglePinProject}
        />
        <${ErrorBanner} error=${err} />
        <div class="empty-state"><p>Project file is not yet valid. Fix it and save.</p></div>
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
        ${projectIntelEl}
        ${taskModalEl}
        ${paletteEl}
      </div>
    `;
  }

  const derived = active.derived;
  const solo = paneSlugs.length === 1 && validPinned.length === 1;

  return html`
    <div class=${shellClass}>
      <${Header}
        slugs=${slugs}
        projects=${projects}
        activeSlug=${activeSlug}
        setActive=${setActiveSlug}
        project=${active}
        pinnedProjectNames=${pinnedProjectNames}
        workspace=${workspace}
        filter=${filter}
        setFilter=${setFilter}
        searchMode=${searchMode}
        onSearchModeChange=${setSearchMode}
        searchMeta=${searchMeta}
        headerCollapsed=${headerCollapsed}
        onToggleHeaderCollapse=${() => setHeaderCollapsed((v) => !v)}
        theme=${theme}
        onToggleTheme=${onToggleTheme}
        onOpenHelp=${() => setHelpOpen(true)}
        onOpenDrawer=${() => setDrawerOpen(true)}
        onOpenSettings=${() => setSettingsOpen(true)}
        onOpenHistory=${() => setHistoryOpen(true)}
        onOpenIntel=${onOpenProjectIntel}
        onUndo=${onUndo}
        onRedo=${onRedo}
        onDeleteProject=${onDeleteProject}
        onCollapseAll=${onCollapseAll}
        onExpandAll=${onExpandAll}
        onOpenPalette=${() => setPaletteOpen(true)}
          pinnedSlugs=${pinnedSlugs}
          onTogglePinProject=${onTogglePinProject}
      />
      ${!headerCollapsed ? html`
        <${HeroStrip}
          project=${active}
          slug=${activeSlug}
          onPickTask=${onPickTask}
          onOpenTaskModal=${onOpenTaskModalHandler}
        />
      ` : null}
      ${active?.data
        ? html`<${ScratchpadRow}
            slug=${activeSlug}
            text=${active?.data?.meta?.scratchpad || ""}
            updatedAt=${active?.data?.meta?.updatedAt || null}
            expanded=${!!scratchpadExpanded[activeSlug]}
            onToggleExpand=${onToggleScratchpad}
            onSave=${onSaveScratchpad}
          />`
        : null}
      <div class="banner-row">
        <${FilterToggles}
          counts=${derived.counts}
          statusFilters=${statusFilters}
          toggleStatus=${toggleStatus}
          blockedCount=${Object.keys(derived.blocked || {}).length}
          openCount=${derived.total - Object.keys(derived.blocked || {}).length}
          blockFilters=${blockFilters}
          toggleBlock=${toggleBlock}
          boardView=${boardView}
          setBoardView=${setBoardView}
        />
      </div>
      <div class=${`workspace-split ${solo ? "has-solo" : ""}`}>
        ${paneSlugs.map((s) => {
          const paneFuzzyMatchMap = fuzzyMatchMapForPane({
            searchMode,
            fuzzyState,
            filter,
            slug: s,
            fuzzyMatchMap
          });
          return html`
            <${ProjectPane}
              key=${s}
              slug=${s}
              project=${projects[s]}
              isActive=${s === activeSlug}
              solo=${solo}
              pinned=${pinnedSlugs.includes(s)}
              onFocus=${setActiveSlug}
              onTogglePin=${onTogglePinProject}
              filter=${filter}
              searchMode=${searchMode}
              boardView=${boardView}
              fuzzyMatchMap=${paneFuzzyMatchMap}
              statusFilters=${statusFilters}
              blockFilters=${blockFilters}
              onMove=${onMove}
              onToggleCollapse=${onToggleCollapse}
              onMoveLane=${onMoveLane}
              onDeleteTask=${onDeleteTask}
              onSaveComment=${onSaveComment}
              onOpenTask=${onOpenTaskDrawer}
              openTaskId=${taskDrawer?.slug === s ? taskDrawer.taskId : null}
              openTaskMode=${taskDrawer?.slug === s ? taskDrawer.mode : "brief"}
              onCloseTask=${() =>
                setTaskDrawer((current) => (current?.slug === s ? null : current))
              }
              onOpenTaskModal=${(task, mode) => onOpenTaskModalHandler(s, task, mode)}
              scratchpadExpanded=${!!scratchpadExpanded[s]}
              onToggleScratchpad=${onToggleScratchpad}
              onSaveScratchpad=${onSaveScratchpad}
            />
          `;
        })}
      </div>
      <${ConnectionPip} up=${wsUp} />
      ${drawerEl}
      ${helpEl}
      ${settingsEl}
      ${historyEl}
      ${projectIntelEl}
      ${taskModalEl}
      ${paletteEl}
    </div>
  `;
}

if (typeof document !== "undefined") {
  render(html`<${App} />`, document.getElementById("app"));
}
