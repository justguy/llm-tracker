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
  scratchpadExpanded,
  onToggleScratchpad,
  onSaveScratchpad
}) {
  const data = project?.data;
  const derived = project?.derived;
  const meta = data?.meta;
  const activeTask = openTaskId
    ? data?.tasks?.find((task) => task.id === openTaskId) || null
    : null;

  return html`
    <section
      class=${`project-pane ${isActive ? "active" : ""} ${solo ? "solo" : ""}`}
      onMouseDown=${() => onFocus && onFocus(slug)}
    >
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
