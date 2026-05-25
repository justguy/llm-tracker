import { html } from "htm/preact";
import { DependencyGraphView } from "./dependency-graph-view.js";
import { Matrix } from "./matrix-view.js";
import { TreeView } from "./tree-view.js";

export function ProjectPane({
  project,
  slug,
  isActive,
  solo,
  pinned,
  onFocus,
  onTogglePin,
  filter,
  searchMode,
  boardView,
  fuzzyMatchMap,
  statusFilters,
  blockFilters,
  onMove,
  onToggleCollapse,
  onMoveLane,
  onDeleteTask,
  onSaveComment,
  onOpenTask,
  openTaskId,
  openTaskMode,
  onCloseTask,
  onOpenTaskModal,
  runtimeSessions,
  runtimeJobs,
  scratchpadExpanded,
  onToggleScratchpad,
  onSaveScratchpad
}) {
  const data = project?.data;
  const derived = project?.derived;
  const meta = data?.meta;
  const projectName = meta?.name || slug;
  const completeCount = derived?.counts?.complete || 0;
  const totalCount = derived?.total || data?.tasks?.length || 0;
  const pct = derived?.pct ?? (totalCount > 0 ? Math.round((completeCount / totalCount) * 100) : 0);
  const progressText = `${completeCount} of ${totalCount} task${totalCount === 1 ? "" : "s"} complete.`;
  const activeTask = openTaskId
    ? data?.tasks?.find((task) => task.id === openTaskId) || null
    : null;

  return html`
    <section
      class=${`project-pane ${isActive ? "active" : ""} ${solo ? "solo" : ""}`}
      onMouseDown=${() => onFocus && onFocus(slug)}
    >
      ${pinned
        ? html`
          <div class="project-pane-header">
            <span class="project-pane-name" title=${projectName}>${projectName}</span>
            <span class="project-pane-progress" title=${`${pct}% · ${progressText}`}>
              <span class="project-pane-progress-pct">${pct}%</span>
              <span class="project-pane-progress-text">${progressText}</span>
            </span>
            <button
              class="icon-btn small"
              type="button"
              title="Unpin from workspace"
              aria-label=${`Unpin ${projectName} from workspace`}
              onMouseDown=${(e) => e.stopPropagation()}
              onClick=${(e) => {
                e.stopPropagation();
                onTogglePin && onTogglePin(slug);
              }}
            >
              [UNPIN]
            </button>
          </div>
        `
        : null}
      ${project?.error
        ? html`<div class="error-banner"><b>${project.error.kind} error</b> — last valid state shown; ${project.error.message}</div>`
        : null}
      ${data
        ? boardView === "graph"
          ? html`<${DependencyGraphView}
              project=${project}
              slug=${slug}
              filterQuery=${searchMode === "filter" ? filter : ""}
              statusFilters=${statusFilters}
              blockFilters=${blockFilters}
              fuzzyQuery=${searchMode === "fuzzy" ? filter : ""}
              fuzzyMatchMap=${fuzzyMatchMap}
              activeTask=${activeTask}
              activeTaskMode=${openTaskMode}
              runtimeSessions=${runtimeSessions}
              runtimeJobs=${runtimeJobs}
              onDeleteTask=${(task) => onDeleteTask(slug, task)}
              onSaveComment=${(taskId, value) => onSaveComment(slug, taskId, value)}
              onOpenTask=${(task, mode) => onOpenTask && onOpenTask(slug, task, mode)}
              onCloseTask=${onCloseTask}
              onOpenTaskModal=${onOpenTaskModal}
            />`
          : boardView === "tree"
            ? html`<${TreeView}
              project=${project}
              slug=${slug}
              filterQuery=${searchMode === "filter" ? filter : ""}
              statusFilters=${statusFilters}
              blockFilters=${blockFilters}
              fuzzyQuery=${searchMode === "fuzzy" ? filter : ""}
              fuzzyMatchMap=${fuzzyMatchMap}
              activeTask=${activeTask}
              activeTaskMode=${openTaskMode}
              runtimeSessions=${runtimeSessions}
              runtimeJobs=${runtimeJobs}
              onDeleteTask=${(task) => onDeleteTask(slug, task)}
              onSaveComment=${(taskId, value) => onSaveComment(slug, taskId, value)}
              onOpenTask=${(task, mode) => onOpenTask && onOpenTask(slug, task, mode)}
              onCloseTask=${onCloseTask}
              onOpenTaskModal=${onOpenTaskModal}
            />`
            : html`<${Matrix}
              project=${project}
              slug=${slug}
              filterQuery=${searchMode === "filter" ? filter : ""}
              statusFilters=${statusFilters}
              blockFilters=${blockFilters}
              fuzzyQuery=${searchMode === "fuzzy" ? filter : ""}
              fuzzyMatchMap=${fuzzyMatchMap}
              activeTask=${activeTask}
              activeTaskMode=${openTaskMode}
              runtimeSessions=${runtimeSessions}
              runtimeJobs=${runtimeJobs}
              onMove=${(args) => onMove(slug, args)}
              onToggleCollapse=${(laneId, collapsed) => onToggleCollapse(slug, laneId, collapsed)}
              onMoveLane=${(laneId, direction) => onMoveLane(slug, laneId, direction)}
              onDeleteTask=${(task) => onDeleteTask(slug, task)}
              onSaveComment=${(taskId, value) => onSaveComment(slug, taskId, value)}
              onOpenTask=${(task, mode) => onOpenTask && onOpenTask(slug, task, mode)}
              onCloseTask=${onCloseTask}
              onOpenTaskModal=${onOpenTaskModal}
            />`
        : html`<div class="empty-state"><p>Project file is not yet valid. Fix it and save.</p></div>`}
    </section>
  `;
}
