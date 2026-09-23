import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { html } from "htm/preact";
import { Header } from "./header.js";
import { HistoryModal } from "./modals/history.js";
import { HelpModal } from "./modals/help.js";
import { ProjectIntelligenceModal, TaskIntelligenceModal } from "./modals/intelligence.js";
import { SettingsModal } from "./modals/settings.js";
import { CommandPalette } from "./palette.js";
import { ProjectPane } from "./project-pane.js";
import { ScratchpadRow } from "./scratchpad-row.js";
import { ConnectionPip, Drawer, EmptyState } from "./shell-chrome.js";
import { AttentionStrip } from "./attention/AttentionStrip.js";
import { TriagePage } from "./triage/TriagePage.js";
import { AttachDialog } from "./session-hub/AttachDialog.js";
import { messageCapability } from "./session-hub/ChatComposer.js";
import { HubTopBar } from "./session-hub/HubTopBar.js";
import { SessionDetailDockView } from "./session-hub/SessionDetailDock.js";
import {
  SessionGroupView,
  applyRuntimeSessionsMessage,
  previewSessionTaskDrop,
  requestJobComplete,
  requestOverrideJobComplete,
  requestResolveHumanApproval,
  requestRunMissingGates,
  requestSessionRepoWorktreeUpdate,
  requestSpawnReviewerDraft,
} from "./session-hub/SessionGroup.js";
import { ToolShelf } from "./session-hub/ToolShelf.js";
import { RunSessionWizard } from "./run-session/RunSessionWizard.js";
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

const TERMINAL_RUNTIME_JOB_STATUSES = new Set(["completed", "cancelled", "rolled_over"]);

function isRuntimeRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function initialWorkspaceMode(settings) {
  const queryMode = typeof location !== "undefined"
    ? new URLSearchParams(location.search).get("mode")
    : null;
  if (queryMode === "sessionHub") return "sessionHub";
  if (queryMode === "tracker") return "tracker";
  return settings?.workspaceMode === "sessionHub" ? "sessionHub" : "tracker";
}

function clampToolShelfWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) return 360;
  return Math.max(280, Math.min(520, Math.round(width)));
}

function runtimeSessionId(session) {
  return nonEmptyString(session?.id);
}

function runtimeJobId(job) {
  return nonEmptyString(job?.id) || nonEmptyString(job?.jobId);
}

function taskList(projectEntry) {
  return Array.isArray(projectEntry?.data?.tasks) ? projectEntry.data.tasks : [];
}

function taskForSession(session, projects, activeSlug) {
  const taskId = nonEmptyString(session?.taskId);
  if (!taskId) return null;
  const slug = nonEmptyString(session?.projectSlug) || activeSlug;
  const task = taskList(projects[slug]).find((item) => item?.id === taskId);
  return task || { id: taskId, title: session?.taskTitle || taskId };
}

function jobForSession(session, jobs) {
  const activeJobId = nonEmptyString(session?.activeJobId);
  return normalizeRuntimeJobList(jobs).find((job) => {
    const id = runtimeJobId(job);
    if (activeJobId && id === activeJobId) return true;
    return nonEmptyString(job?.sessionId) === runtimeSessionId(session);
  }) || (activeJobId ? { id: activeJobId, sessionId: runtimeSessionId(session) } : null);
}

function repoForSession(session) {
  const root = nonEmptyString(session?.repoRoot);
  const worktreePath = nonEmptyString(session?.worktreePath);
  return root || worktreePath ? { root, worktreePath } : null;
}

function timelineItemsForSession(session) {
  if (Array.isArray(session?.timelineItems)) return session.timelineItems;
  if (Array.isArray(session?.timelinePreview)) return session.timelinePreview;
  if (Array.isArray(session?.timeline)) return session.timeline;
  if (Array.isArray(session?.events)) return session.events;
  return [];
}

function stdioEntriesForSession(session) {
  return session?.stdioEntries || session?.stdioBuffer || session?.output || session?.outputs || session?.runtimeEvents || [];
}

function capabilitiesForSession(session) {
  const provider = isRuntimeRecord(session?.providerCapabilities) ? session.providerCapabilities : {};
  const caps = isRuntimeRecord(session?.capabilities) ? session.capabilities : {};
  const tier = nonEmptyString(session?.tier);
  return {
    ...provider,
    ...caps,
    structured: provider.structured !== false && caps.structured !== false,
    structuredChat:
      provider.structuredChat === true ||
      caps.structuredChat === true ||
      provider.turnSteer === true ||
      caps.turnSteer === true ||
      provider.stdinWrite === true ||
      caps.stdinWrite === true,
    worktree: provider.worktree !== false && caps.worktree !== false,
    review: provider.review === true || caps.review === true || !!nonEmptyString(session?.activeJobId),
  };
}

function sessionCanReceiveOperatorMessage(session) {
  return messageCapability(session || {}, capabilitiesForSession(session)).enabled;
}

export function preferredSessionForWorkspace(sessions, selectedSessionId = null) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const selected = list.find((session) => runtimeSessionId(session) === selectedSessionId);
  if (selected) return selected;
  return (
    list.find(sessionCanReceiveOperatorMessage) ||
    list.find((session) => session?.status === "active" || session?.status === "waiting_for_human") ||
    list[0] ||
    null
  );
}

function normalizeRuntimeJobList(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter((job) => isRuntimeRecord(job) && typeof job.id === "string" && job.id.length > 0);
}

function upsertRuntimeJob(jobs, id, updater) {
  if (typeof id !== "string" || id.length === 0) return normalizeRuntimeJobList(jobs);
  const list = normalizeRuntimeJobList(jobs);
  const index = list.findIndex((job) => job.id === id);
  const base = index >= 0 ? list[index] : { id };
  const nextJob = updater(base);
  if (!isRuntimeRecord(nextJob)) return list;
  if (index === -1) return list.concat(nextJob);
  const next = list.slice();
  next[index] = nextJob;
  return next;
}

export function applyRuntimeJobEvent(jobs, event) {
  if (!isRuntimeRecord(event)) return normalizeRuntimeJobList(jobs);
  const jobId = event.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) return normalizeRuntimeJobList(jobs);

  switch (event.type) {
    case "job.started":
      return upsertRuntimeJob(jobs, jobId, (job) => ({
        ...job,
        id: jobId,
        ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
        ...(event.projectSlug !== undefined ? { projectSlug: event.projectSlug } : {}),
        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
        ...(event.profileId !== undefined ? { profileId: event.profileId } : {}),
        ...(event.kind !== undefined ? { kind: event.kind } : {}),
        status: "running",
        startedAt: event.ts,
      }));
    case "job.queued":
      return upsertRuntimeJob(jobs, jobId, (job) => ({
        ...job,
        id: jobId,
        ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
        ...(event.projectSlug !== undefined ? { projectSlug: event.projectSlug } : {}),
        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
        ...(event.profileId !== undefined ? { profileId: event.profileId } : {}),
        ...(event.kind !== undefined ? { kind: event.kind } : {}),
        ...(event.predecessorJobId !== undefined ? { predecessorJobId: event.predecessorJobId } : {}),
        status: "queued",
        queuedAt: event.ts,
      }));
    case "job.checkpoint":
      return upsertRuntimeJob(jobs, jobId, (job) => ({
        ...job,
        lastActivityAt: event.ts,
        ...(typeof event.status === "string" ? { status: event.status } : {}),
        ...(typeof event.summary === "string" ? { lastCheckpointSummary: event.summary } : {}),
      }));
    case "job.unblocked":
      return upsertRuntimeJob(jobs, jobId, (job) => ({
        ...job,
        status: "running",
        lastActivityAt: event.ts,
      }));
    case "job.completed":
      return upsertRuntimeJob(jobs, jobId, (job) => ({
        ...job,
        status: TERMINAL_RUNTIME_JOB_STATUSES.has(event.status) ? event.status : "completed",
        completedAt: event.ts,
        ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
      }));
    default:
      return normalizeRuntimeJobList(jobs);
  }
}

// ─────── App ───────
function App() {
  const initialSettings = useMemo(() => loadSettings(), []);
  const [workspace, setWorkspace] = useState(null);
  const [projects, setProjects] = useState({});
  const [activeSlug, setActiveSlug] = useState(initialSettings.activeSlug || null);
  const [filter, setFilter] = useState("");
  const [searchMode, setSearchMode] = useState("filter");
  const [boardView, setBoardView] = useState(["tree", "graph"].includes(initialSettings.boardView) ? initialSettings.boardView : "swimlane");
  const [workspaceMode, setWorkspaceMode] = useState(() => initialWorkspaceMode(initialSettings));
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
  const [attachOpen, setAttachOpen] = useState(false);
  const [dropRunSession, setDropRunSession] = useState(null);
  const [sessionDropPreflight, setSessionDropPreflight] = useState(null);
  const [completionPanels, setCompletionPanels] = useState({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [attentionItems, setAttentionItems] = useState([]);
  const [runtimeSessions, setRuntimeSessions] = useState([]);
  const [runtimeJobs, setRuntimeJobs] = useState([]);
  const [runtimeWsUp, setRuntimeWsUp] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [selectedSessionTab, setSelectedSessionTab] = useState("summary");
  const [stdioPaused, setStdioPaused] = useState(false);
  const [stdioFollow, setStdioFollow] = useState(true);
  const [stdioQuery, setStdioQuery] = useState("");
  const [stdioCopied, setStdioCopied] = useState(false);
  const [sessionChatDrafts, setSessionChatDrafts] = useState({});
  const [sessionQueuedDrafts, setSessionQueuedDrafts] = useState({});
  const [sessionChatErrors, setSessionChatErrors] = useState({});
  const [toolShelfWidth, setToolShelfWidth] = useState(
    clampToolShelfWidth(initialSettings.toolShelfWidth)
  );
  const [sessionCardSize, setSessionCardSize] = useState(
    ["compact", "normal", "large"].includes(initialSettings.sessionCardSize)
      ? initialSettings.sessionCardSize
      : "normal"
  );
  const [triageOpen, setTriageOpen] = useState(false);
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
  const setCompletionPanel = (jobId, patch) => {
    const targetJobId = nonEmptyString(jobId);
    if (!targetJobId) return;
    setCompletionPanels((prev) => {
      const current = prev[targetJobId] || {};
      const nextPanel = typeof patch === "function" ? patch(current) : { ...current, ...patch };
      return { ...prev, [targetJobId]: nextPanel };
    });
  };
  const shortcutsSuspended = shouldSuspendGlobalShortcuts({
    helpOpen,
    settingsOpen,
    historyOpen,
    projectIntel,
    taskModal,
    attachOpen,
    drawerOpen,
    drawerPinned
  });

  // Persist settings
  useEffect(() => {
    saveSettings({ theme, headerCollapsed, drawerPinned, pinnedSlugs, scratchpadExpanded, activeSlug, boardView, workspaceMode, sessionCardSize, toolShelfWidth });
  }, [theme, headerCollapsed, drawerPinned, pinnedSlugs, scratchpadExpanded, activeSlug, boardView, workspaceMode, sessionCardSize, toolShelfWidth]);

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
    let cancelled = false;
    fetch("/api/attention?scope=global")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
        setAttentionItems(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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

  useEffect(() => {
    let ws;
    let retryTimer;
    let closing = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/runtime/ws`);
      ws.onopen = () => setRuntimeWsUp(true);
      ws.onclose = () => {
        if (closing) return;
        setRuntimeWsUp(false);
        retryTimer = setTimeout(connect, 1000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "runtime.snapshot") {
          setAttentionItems(Array.isArray(msg.snapshot?.attention) ? msg.snapshot.attention : []);
          setRuntimeSessions(Array.isArray(msg.snapshot?.sessions) ? msg.snapshot.sessions : []);
          setRuntimeJobs(normalizeRuntimeJobList(msg.snapshot?.jobs));
        } else if (msg.type === "runtime.event") {
          setRuntimeSessions((prev) => applyRuntimeSessionsMessage(prev, msg));
          setRuntimeJobs((prev) => applyRuntimeJobEvent(prev, msg.event));
        } else if (msg.type === "attention.updated") {
          setAttentionItems(Array.isArray(msg.items) ? msg.items : []);
        }
      };
    };
    connect();
    return () => {
      closing = true;
      clearTimeout(retryTimer);
      setRuntimeWsUp(false);
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

  const onTaskDropPreflight = async (intent) => {
    if (!intent?.taskId) return;
    const projectSlug = intent.projectSlug || activeSlug || "";
    if (intent.kind === "new_session") {
      setSessionDropPreflight(null);
      setDropRunSession({ ...intent, projectSlug });
      return;
    }

    const pending = { ...intent, projectSlug, status: "loading" };
    setDropRunSession(null);
    setSessionDropPreflight(pending);
    try {
      const preview = await previewSessionTaskDrop({
        sessionId: intent.sessionId,
        taskId: intent.taskId,
        projectSlug,
      });
      setSessionDropPreflight({ ...pending, status: "ready", preview });
    } catch (err) {
      setSessionDropPreflight({ ...pending, status: "error", error: err?.message || "attach preflight failed" });
    }
  };

  const onOpenHubRunSession = (intent = {}) => {
    setWorkspaceMode("sessionHub");
    if (intent.mode === "attach_existing") {
      setAttachOpen(true);
      return;
    }
    setDropRunSession({
      source: intent.source || "global_new_session",
      mode: intent.mode || "task_backed",
      projectSlug: intent.projectSlug || activeSlug || "",
      taskId: "",
    });
  };

  const onOpenSelectedSession = (sessionId, slug = activeSlug) => {
    const id = nonEmptyString(sessionId);
    if (!id) return;
    if (slug) setActiveSlug(slug);
    setSelectedSessionId(id);
    setSelectedSessionTab("summary");
    setWorkspaceMode("sessionHub");
  };

  const onProjectSessionRun = (intent = {}) => {
    setWorkspaceMode("sessionHub");
    setDropRunSession({
      source: intent.source || "project_session_strip",
      mode: intent.mode || "task_backed",
      projectSlug: intent.projectSlug || activeSlug || "",
      taskId: "",
      taskLocked: false,
    });
  };

  const onBoardRunSession = (slug, task, action = {}) => {
    const sessionId = nonEmptyString(action.sessionId);
    if (sessionId) {
      onOpenSelectedSession(sessionId, slug);
      return;
    }
    const taskId = nonEmptyString(task?.id);
    if (!taskId) return;
    setWorkspaceMode("sessionHub");
    setDropRunSession({
      source: "task_card",
      mode: "task_backed",
      projectSlug: slug || activeSlug || "",
      taskId,
      taskLocked: true,
    });
  };

  const onStartToolShelfResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = toolShelfWidth;
    const onPointerMove = (moveEvent) => {
      setToolShelfWidth(clampToolShelfWidth(startWidth + startX - moveEvent.clientX));
    };
    const onPointerUp = () => {
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerup", onPointerUp);
    };
    globalThis.addEventListener("pointermove", onPointerMove);
    globalThis.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const onCompleteJob = async ({ jobId }) => {
    const targetJobId = nonEmptyString(jobId);
    if (!targetJobId) return;
    setCompletionPanel(targetJobId, { busyAction: "complete", error: null, message: null });
    try {
      const result = await requestJobComplete({ jobId: targetJobId });
      if (result?.mode === "gates_pending") {
        setCompletionPanel(targetJobId, { result, busyAction: null, error: null, message: null });
        return;
      }
      setCompletionPanels((prev) => {
        const next = { ...prev };
        delete next[targetJobId];
        return next;
      });
    } catch (err) {
      setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "complete failed" });
    }
  };

  const onSetRepoWorktree = async ({ sessionId, repoRoot, worktreePath }) => {
    const targetSessionId = nonEmptyString(sessionId);
    if (!targetSessionId || typeof globalThis.prompt !== "function") return;
    const nextRepoRoot = nonEmptyString(globalThis.prompt("Repo root", repoRoot || worktreePath || ""));
    if (!nextRepoRoot) return;
    const nextWorktreePath = nonEmptyString(globalThis.prompt("Worktree path", worktreePath || nextRepoRoot));
    if (!nextWorktreePath) return;
    try {
      const result = await requestSessionRepoWorktreeUpdate({
        sessionId: targetSessionId,
        repoRoot: nextRepoRoot,
        worktreePath: nextWorktreePath,
      });
      if (result?.session) {
        setRuntimeSessions((prev) => prev.map((session) =>
          session?.id === targetSessionId ? { ...session, ...result.session } : session
        ));
      }
    } catch (err) {
      alert(`Set repo/worktree failed: ${err?.message || "request failed"}`);
    }
  };

  const onCloseCompletionGates = ({ jobId }) => {
    const targetJobId = nonEmptyString(jobId);
    if (!targetJobId) return;
    setCompletionPanels((prev) => {
      const next = { ...prev };
      delete next[targetJobId];
      return next;
    });
  };

  const onRunMissingGates = async ({ jobId, missing }) => {
    const targetJobId = nonEmptyString(jobId);
    if (!targetJobId) return;
    setCompletionPanel(targetJobId, { busyAction: "run_missing", error: null, message: null });
    try {
      const result = await requestRunMissingGates({ jobId: targetJobId, missing });
      setCompletionPanel(targetJobId, {
        busyAction: null,
        error: null,
        message: `${result.results.length} verify item${result.results.length === 1 ? "" : "s"} run`,
      });
    } catch (err) {
      setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "verify run failed" });
    }
  };

  const onResolveHumanApproval = async ({ jobId, gate, reason }) => {
    const targetJobId = nonEmptyString(jobId);
    if (!targetJobId) return;
    setCompletionPanel(targetJobId, { busyAction: "resolve_human_approval", error: null, message: null });
    try {
      await requestResolveHumanApproval({ jobId: targetJobId, gate, reason });
      setCompletionPanel(targetJobId, { busyAction: null, error: null, message: "Human approval resolved" });
    } catch (err) {
      setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "approval resolve failed" });
    }
  };

  const onSpawnReviewer = async ({ jobId, session }) => {
    const targetJobId = nonEmptyString(jobId);
    if (!targetJobId) return;
    setCompletionPanel(targetJobId, { busyAction: "spawn_reviewer", error: null, message: null });
    try {
      const result = await requestSpawnReviewerDraft({ session, jobId: targetJobId });
      const draftId = result?.draft?.id || "draft";
      setCompletionPanel(targetJobId, { busyAction: null, error: null, message: `Reviewer ${draftId} created` });
    } catch (err) {
      setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "reviewer draft failed" });
    }
  };

  const onOverrideComplete = async ({ jobId, reason }) => {
    const targetJobId = nonEmptyString(jobId);
    if (!targetJobId) return;
    setCompletionPanel(targetJobId, { busyAction: "override_complete", error: null, message: null });
    try {
      await requestOverrideJobComplete({ jobId: targetJobId, reason });
      setCompletionPanels((prev) => {
        const next = { ...prev };
        delete next[targetJobId];
        return next;
      });
    } catch (err) {
      setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "override complete failed" });
    }
  };

  const onCompletionPanelValidationError = (message, payload = {}) => {
    const targetJobId = nonEmptyString(payload.jobId);
    if (targetJobId) setCompletionPanel(targetJobId, { busyAction: null, error: message });
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
  const visibleRuntimeSessions = useMemo(
    () => runtimeSessions,
    [runtimeSessions]
  );
  const selectedSession = useMemo(() => {
    return preferredSessionForWorkspace(visibleRuntimeSessions, selectedSessionId);
  }, [visibleRuntimeSessions, selectedSessionId]);
  const selectedTask = useMemo(
    () => taskForSession(selectedSession, projects, activeSlug),
    [selectedSession, projects, activeSlug]
  );
  const selectedJob = useMemo(
    () => jobForSession(selectedSession, runtimeJobs),
    [selectedSession, runtimeJobs]
  );
  const selectedRepo = useMemo(() => repoForSession(selectedSession), [selectedSession]);
  const selectedCapabilities = useMemo(
    () => capabilitiesForSession(selectedSession),
    [selectedSession]
  );
  const onSessionHubToolAction = ({ groupId, actionId, task, session, job, repo }) => {
    if (groupId === "task" && task?.id) {
      const slug = session?.projectSlug || activeSlug;
      if (actionId === "run") {
        setWorkspaceMode("sessionHub");
        setDropRunSession({ source: "tool_shelf", mode: "task_backed", projectSlug: slug || "", taskId: task.id });
        return;
      }
      const mode = actionId === "exec" ? "execute" : actionId === "verify" ? "verify" : actionId === "why" ? "why" : "brief";
      onOpenTaskDrawer(slug, task.id, mode);
      return;
    }
    if (groupId === "session") {
      if (actionId === "chat") setSelectedSessionTab("chat");
      else if (actionId === "stdio") setSelectedSessionTab("stdio");
      else if (actionId === "rollover") setSelectedSessionTab("context");
      else if (actionId === "mcp_contract") setSelectedSessionTab("context");
      else if (actionId === "stop" && session?.id) alert(`Stop session ${session.id} from its session card or CLI.`);
      else if (session?.id) setSelectedSessionId(session.id);
      return;
    }
    if (groupId === "job") {
      if (actionId === "skills") setSelectedSessionTab("skills");
      else if (actionId === "context" || actionId === "verify" || actionId === "blocked") setSelectedSessionTab("context");
      else if (actionId === "complete" && runtimeJobId(job)) onCompleteJob({ jobId: runtimeJobId(job) });
      return;
    }
    if (groupId === "repo") {
      if (actionId === "diff" || actionId === "conflicts" || actionId === "status" || actionId === "files") {
        setSelectedSessionTab("diff");
        return;
      }
      if (actionId === "worktree" && session?.id) {
        onSetRepoWorktree({ sessionId: session.id, repoRoot: repo?.root || session.repoRoot, worktreePath: repo?.worktreePath || session.worktreePath });
      }
      return;
    }
    if (groupId === "review") {
      if (actionId === "spawn_reviewer" && runtimeJobId(job)) onSpawnReviewer({ jobId: runtimeJobId(job), session });
      else setSelectedSessionTab("diff");
    }
  };
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
    const ids = visibleRuntimeSessions.map(runtimeSessionId).filter(Boolean);
    if (selectedSessionId && ids.includes(selectedSessionId)) return;
    setSelectedSessionId(runtimeSessionId(preferredSessionForWorkspace(visibleRuntimeSessions)) || null);
  }, [visibleRuntimeSessions, selectedSessionId]);

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
  const dropRunProject = dropRunSession?.projectSlug ? projects[dropRunSession.projectSlug] : null;
  const runSessionDropEl = dropRunSession
    ? html`
        <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Run session preflight" onClick=${() => setDropRunSession(null)}>
          <div class="modal" onClick=${(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="brand">[RUN SESSION PREFLIGHT]</span>
              <button class="icon-btn" type="button" aria-label="Close run session preflight" onClick=${() => setDropRunSession(null)} title="Close">×</button>
            </div>
            <div class="modal-body">
              <${RunSessionWizard}
                projectSlug=${dropRunSession.projectSlug || ""}
                taskId=${dropRunSession.taskId || ""}
                source=${dropRunSession.source || "hub_run"}
                mode=${dropRunSession.mode || (dropRunSession.taskId ? "task_backed" : "untasked")}
                taskLocked=${dropRunSession.taskLocked === true}
                initialDraft=${Number.isInteger(dropRunProject?.rev) ? { expectedTrackerRev: dropRunProject.rev } : null}
                onLaunch=${(result) => {
                  const launchedSessionId = nonEmptyString(result?.sessionId);
                  if (launchedSessionId) {
                    setSelectedSessionId(launchedSessionId);
                    setSelectedSessionTab("chat");
                    setWorkspaceMode("sessionHub");
                  }
                  setDropRunSession(null);
                }}
              />
            </div>
          </div>
        </div>
      `
    : null;
  const attachDialogEl = html`
    <${AttachDialog}
      open=${attachOpen}
      projectSlug=${activeSlug || ""}
      taskId=${taskDrawer?.slug === activeSlug ? taskDrawer.taskId : taskModal?.slug === activeSlug ? taskModal.task?.id : ""}
      projectFile=${active?.file || ""}
      workspacePath=${workspace?.workspace || ""}
      onClose=${() => setAttachOpen(false)}
      onAttached=${(body) => {
        if (body?.session) setRuntimeSessions((prev) => applyRuntimeSessionsMessage(prev, {
          type: "runtime.event",
          event: {
            id: body.eventId || "evt_attach_ui",
            type: "session.started",
            source: "http",
            ts: new Date().toISOString(),
            session: body.session,
          },
        }));
      }}
    />
  `;

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
  const attentionStripEl = html`
    <div class="attention-strip-row">
      <${AttentionStrip}
        items=${attentionItems.slice(0, 5)}
        onItemClick=${() => setTriageOpen(true)}
      />
    </div>
  `;
  const workspaceModeTabsEl = html`
    <div class="workspace-mode-tabs" role="tablist" aria-label="Primary workspace mode">
      <button
        class=${`workspace-mode-tab ${workspaceMode === "tracker" ? "workspace-mode-tab--active" : ""}`}
        type="button"
        role="tab"
        aria-selected=${workspaceMode === "tracker"}
        onClick=${() => setWorkspaceMode("tracker")}
      >
        Tracker
      </button>
      <button
        class=${`workspace-mode-tab ${workspaceMode === "sessionHub" ? "workspace-mode-tab--active" : ""}`}
        type="button"
        role="tab"
        aria-selected=${workspaceMode === "sessionHub"}
        onClick=${() => setWorkspaceMode("sessionHub")}
      >
        Session Hub
        <span>${visibleRuntimeSessions.length}</span>
      </button>
    </div>
  `;
  const sessionGroupEl = html`
    <section
      class="session-hub-operator-shell"
      aria-label="Session Hub operator workspace"
      data-browser-acceptance="desktop-operator-workspace narrow-operator-workspace"
    >
      <${HubTopBar}
        sessionCount=${visibleRuntimeSessions.length}
        activeProjectName=${active?.data?.meta?.name || activeSlug || "workspace"}
        connected=${runtimeWsUp}
        onOpenWizard=${onOpenHubRunSession}
        onAttach=${() => setAttachOpen(true)}
      />
      <${SessionGroupView}
        sessions=${visibleRuntimeSessions}
        size=${sessionCardSize}
        connected=${runtimeWsUp}
        projectSlug=${activeSlug || ""}
        selectedSessionId=${runtimeSessionId(selectedSession)}
        dropPreflight=${sessionDropPreflight}
        completionPanels=${completionPanels}
        onSelectSession=${(session) => {
          const id = runtimeSessionId(session);
          if (id) setSelectedSessionId(id);
        }}
        onSizeChange=${setSessionCardSize}
        onAttach=${() => setAttachOpen(true)}
        onCompleteJob=${onCompleteJob}
        onCloseCompletionGates=${onCloseCompletionGates}
        onRunMissingGates=${onRunMissingGates}
        onResolveHumanApproval=${onResolveHumanApproval}
        onSpawnReviewer=${onSpawnReviewer}
        onOverrideComplete=${onOverrideComplete}
        onCompletionPanelValidationError=${onCompletionPanelValidationError}
        onSetRepoWorktree=${onSetRepoWorktree}
        onTaskDropPreflight=${onTaskDropPreflight}
        onDismissDropPreflight=${() => setSessionDropPreflight(null)}
      />
      <div
        class="session-hub-workspace"
        style=${`--session-tools-width: ${toolShelfWidth}px`}
      >
        <main class="session-hub-workspace__main">
          ${selectedSession
            ? html`
                <${SessionDetailDockView}
                  session=${selectedSession}
                  task=${selectedTask}
                  job=${selectedJob}
                  stdioEntries=${stdioEntriesForSession(selectedSession)}
                  timelineItems=${timelineItemsForSession(selectedSession)}
                  activeTab=${selectedSessionTab}
                  visible=${true}
                  paused=${stdioPaused}
                  follow=${stdioFollow}
                  query=${stdioQuery}
                  copied=${stdioCopied}
                  chatDraft=${sessionChatDrafts[runtimeSessionId(selectedSession)] || ""}
                  queuedChatDrafts=${sessionQueuedDrafts[runtimeSessionId(selectedSession)] || []}
                  chatError=${sessionChatErrors[runtimeSessionId(selectedSession)] || ""}
                  capabilities=${selectedCapabilities}
                  onSelectTab=${setSelectedSessionTab}
                  onTogglePause=${setStdioPaused}
                  onToggleFollow=${setStdioFollow}
                  onSearch=${setStdioQuery}
                  onCopy=${async (text) => {
                    if (globalThis.navigator?.clipboard?.writeText) {
                      await globalThis.navigator.clipboard.writeText(text);
                    }
                    setStdioCopied(true);
                    setTimeout(() => setStdioCopied(false), 1200);
                  }}
                  onDraftChange=${(value) => {
                    const id = runtimeSessionId(selectedSession);
                    if (!id) return;
                    setSessionChatDrafts((prev) => ({ ...prev, [id]: value }));
                    if (sessionChatErrors[id]) {
                      setSessionChatErrors((prev) => ({ ...prev, [id]: "" }));
                    }
                  }}
                  onQueuedDraftsChange=${(value) => {
                    const id = runtimeSessionId(selectedSession);
                    if (!id) return;
                    setSessionQueuedDrafts((prev) => ({ ...prev, [id]: Array.isArray(value) ? value : [] }));
                  }}
                  onSend=${(result) => {
                    const id = runtimeSessionId(selectedSession);
                    const message = result?.body?.message;
                    if (!id) return;
                    if (!result?.ok) {
                      setSessionChatErrors((prev) => ({
                        ...prev,
                        [id]: result?.disabledReason || result?.body?.error?.message || "message send failed",
                      }));
                      return;
                    }
                    setSessionChatErrors((prev) => ({ ...prev, [id]: "" }));
                    if (!message?.text) return;
                    setRuntimeSessions((prev) => applyRuntimeSessionsMessage(prev, {
                      type: "runtime.event",
                      event: {
                        id: result.body.eventId || `evt_ui_message_${Date.now()}`,
                        type: "session.output",
                        source: "http",
                        sessionId: id,
                        stream: "structured",
                        kind: "message",
                        role: message.role || "operator",
                        text: message.text,
                        message: message.text,
                        ts: message.ts || new Date().toISOString(),
                      },
                    }));
                  }}
                  onInterrupt=${(result) => {
                    if (!result?.ok && result?.disabledReason) alert(`Interrupt failed: ${result.disabledReason}`);
                  }}
                  onForceKill=${({ sessionId }) => alert(`Force kill ${sessionId} from the session card or CLI.`)}
                  onSetRepoWorktree=${onSetRepoWorktree}
                />
              `
            : html`
                <section class="session-hub-workspace__empty" aria-label="Session detail">
                  <strong>No session running</strong>
                  <span>Start or attach a session to open the operator workspace and chat with an agent.</span>
                  <div class="session-hub-workspace__empty-actions">
                    <button type="button" onClick=${() => onOpenHubRunSession({ mode: "task_backed", source: "empty_state_pick_task" })}>
                      Pick task
                    </button>
                    <button type="button" onClick=${() => onOpenHubRunSession({ mode: "untasked", source: "empty_state_untasked" })}>
                      Start untasked
                    </button>
                    <button type="button" onClick=${() => setAttachOpen(true)}>
                      Attach existing
                    </button>
                  </div>
                </section>
              `}
        </main>
        <button
          class="session-hub-workspace__resize"
          type="button"
          aria-label="Resize tool shelf"
          title="Resize tool shelf"
          onPointerDown=${onStartToolShelfResize}
          onKeyDown=${(event) => {
            if (event.key === "ArrowLeft") setToolShelfWidth((value) => clampToolShelfWidth(value + 24));
            if (event.key === "ArrowRight") setToolShelfWidth((value) => clampToolShelfWidth(value - 24));
          }}
        />
        <aside class="session-hub-workspace__tools" aria-label="Selected tools">
          <${ToolShelf}
            task=${selectedTask}
            session=${selectedSession}
            job=${selectedJob}
            repo=${selectedRepo}
            capabilities=${selectedCapabilities}
            onAction=${onSessionHubToolAction}
          />
        </aside>
      </div>
    </section>
  `;
  const triageEl = triageOpen
    ? html`
        <div class="triage-overlay" role="dialog" aria-modal="true" aria-label="Attention triage">
          <div class="triage-shell">
            <div class="triage-shell__bar">
              <span class="triage-shell__title">Attention triage</span>
              <button class="triage-shell__close" type="button" onClick=${() => setTriageOpen(false)} aria-label="Close triage">×</button>
            </div>
            <${TriagePage} items=${attentionItems} />
          </div>
        </div>
      `
    : null;
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
          onOpenTriage=${() => setTriageOpen(true)}
          onUndo=${onUndo}
          onRedo=${onRedo}
          onDeleteProject=${onDeleteProject}
          onCollapseAll=${onCollapseAll}
          onExpandAll=${onExpandAll}
          onOpenPalette=${() => setPaletteOpen(true)}
          pinnedSlugs=${pinnedSlugs}
          onTogglePinProject=${onTogglePinProject}
        />
        ${attentionStripEl}
        ${workspaceModeTabsEl}
        ${workspaceMode === "sessionHub" ? sessionGroupEl : null}
        <${EmptyState} workspace=${workspace} onOpenHelp=${() => setHelpOpen(true)} />
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
        ${taskModalEl}
        ${attachDialogEl}
        ${runSessionDropEl}
        ${paletteEl}
        ${triageEl}
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
          onOpenTriage=${() => setTriageOpen(true)}
          onUndo=${onUndo}
          onRedo=${onRedo}
          onDeleteProject=${onDeleteProject}
          onCollapseAll=${onCollapseAll}
          onExpandAll=${onExpandAll}
          onOpenPalette=${() => setPaletteOpen(true)}
          pinnedSlugs=${pinnedSlugs}
          onTogglePinProject=${onTogglePinProject}
        />
        ${attentionStripEl}
        ${workspaceModeTabsEl}
        ${workspaceMode === "sessionHub" ? sessionGroupEl : null}
        ${err ? html`<div class="error-banner"><b>${err.kind} error</b> — ${err.message}</div>` : null}
        <div class="empty-state"><p>Project file is not yet valid. Fix it and save.</p></div>
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
        ${projectIntelEl}
        ${attachDialogEl}
        ${runSessionDropEl}
        ${taskModalEl}
        ${paletteEl}
        ${triageEl}
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
        onOpenTriage=${() => setTriageOpen(true)}
        onUndo=${onUndo}
        onRedo=${onRedo}
        onDeleteProject=${onDeleteProject}
        onCollapseAll=${onCollapseAll}
        onExpandAll=${onExpandAll}
        onOpenPalette=${() => setPaletteOpen(true)}
          pinnedSlugs=${pinnedSlugs}
          onTogglePinProject=${onTogglePinProject}
      />
      ${attentionStripEl}
      ${workspaceModeTabsEl}
      ${workspaceMode === "sessionHub"
        ? sessionGroupEl
        : html`
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
                    onRunSession=${onBoardRunSession}
                    onRunProjectSession=${onProjectSessionRun}
                    onSelectSession=${(sessionId) => onOpenSelectedSession(sessionId, s)}
                    runtimeSessions=${runtimeSessions}
                    runtimeJobs=${runtimeJobs}
                    scratchpadExpanded=${!!scratchpadExpanded[s]}
                    onToggleScratchpad=${onToggleScratchpad}
                    onSaveScratchpad=${onSaveScratchpad}
                  />
                `;
              })}
            </div>
          `}
      <${ConnectionPip} up=${wsUp} />
      ${drawerEl}
      ${helpEl}
      ${settingsEl}
      ${historyEl}
      ${projectIntelEl}
      ${taskModalEl}
      ${attachDialogEl}
      ${runSessionDropEl}
      ${paletteEl}
      ${triageEl}
    </div>
  `;
}

if (typeof document !== "undefined") {
  render(html`<${App} />`, document.getElementById("app"));
}
