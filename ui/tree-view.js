import { useMemo, useState } from "preact/hooks";
import { html } from "htm/preact";
import { Bracket } from "./primitives.js";
import { TaskInlineDrawer } from "./task-drawer.js";
import {
  STATUS_PILL_LABEL,
  buildTreeModel,
  collectTreeCollapseIds,
  flattenTreeTasks,
  isGroupTask,
  summarizeTreeTasks,
  taskMatchesBoardFilters
} from "./board-models.js";
import { Card } from "./task-card.js";

export function TreeTaskCard({
  slug,
  task,
  depth,
  blocked,
  fuzzyQuery,
  fuzzyMatchMap,
  activeTask,
  activeTaskMode,
  onDeleteTask,
  onSaveComment,
  onOpenTask,
  onCloseTask,
  onOpenTaskModal,
}) {
  return html`
    <div class="tree-task" style=${`--tree-depth: ${depth}`}>
      <${Card}
        task=${task}
        blockedBy=${blocked[task.id]}
        searchMatch=${fuzzyMatchMap?.get(task.id) || null}
        fuzzyActive=${!!(fuzzyQuery && fuzzyQuery.trim())}
        activeMode=${activeTask?.id === task.id ? activeTaskMode : "brief"}
        expanded=${activeTask?.id === task.id}
        onDelete=${onDeleteTask}
        onSaveComment=${onSaveComment}
        onToggleExpand=${(selected) => onOpenTask && onOpenTask(selected, "brief")}
        onOpenTaskModal=${onOpenTaskModal}
      />
      ${activeTask?.id === task.id
        ? html`<${TaskInlineDrawer}
            slug=${slug}
            task=${activeTask}
            initialMode=${activeTaskMode || "brief"}
            onOpenTask=${(taskId, mode) => onOpenTask && onOpenTask({ id: taskId }, mode)}
            onClose=${onCloseTask}
          />`
        : null}
    </div>
  `;
}

export function TreeGroupHeader({
  id,
  title,
  subtitle,
  status,
  depth,
  summary,
  collapsed,
  canToggle,
  task,
  onToggle,
  onOpenTask,
  onOpenTaskModal,
}) {
  return html`
    <div class="tree-group__header" style=${`--tree-depth: ${depth}`}>
      <button
        class="tree-group__toggle"
        disabled=${!canToggle}
        aria-label=${`${collapsed ? "Expand" : "Collapse"} ${title}`}
        aria-expanded=${!collapsed}
        onClick=${onToggle}
      >${canToggle ? (collapsed ? ">" : "v") : "."}</button>
      <div class="tree-group__main">
        <div class="tree-group__title-row">
          <span class="tree-group__id">${id}</span>
          <span class="tree-group__title">${title}</span>
          ${status
            ? html`<span class=${`tree-group__status status-${status}`}>
                ${STATUS_PILL_LABEL[status] || status.toUpperCase()}
              </span>`
            : null}
        </div>
        ${subtitle ? html`<div class="tree-group__subtitle">${subtitle}</div>` : null}
      </div>
      <div class="tree-group__stats">
        <span>${summary.total} tasks</span>
        <span>${summary.active} active</span>
        <span>${summary.done} done</span>
        ${summary.blocked > 0 ? html`<span class="warn">${summary.blocked} blocked</span>` : null}
        <span>${summary.pct}%</span>
      </div>
      ${task
        ? html`<div class="tree-group__actions">
            <${Bracket}
              label="READ"
              title=${`Brief for ${task.id}`}
              onClick=${(e) => {
                e.stopPropagation();
                e.preventDefault();
                onOpenTask && onOpenTask(task, "brief");
              }}
            />
            <${Bracket}
              label="WHY"
              title=${`Why - ${task.id}`}
              onClick=${(e) => {
                e.stopPropagation();
                e.preventDefault();
                onOpenTaskModal && onOpenTaskModal(task, "why");
              }}
            />
          </div>`
        : null}
    </div>
  `;
}

export function TreeView({
  project,
  slug,
  filterQuery,
  statusFilters,
  blockFilters,
  fuzzyQuery,
  fuzzyMatchMap,
  activeTask,
  activeTaskMode,
  onDeleteTask,
  onSaveComment,
  onOpenTask,
  onCloseTask,
  onOpenTaskModal,
}) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const model = useMemo(() => buildTreeModel(project), [project]);
  const collapsibleIds = useMemo(() => collectTreeCollapseIds(model), [model]);
  const collapsedCount = collapsibleIds.filter((id) => collapsed.has(id)).length;
  const blocked = project.derived?.blocked || {};
  const filterState = { filterQuery, statusFilters, blockFilters, blocked };

  const toggleCollapsed = (id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderTask = (task, depth) => html`
    <${TreeTaskCard}
      key=${task.id}
      slug=${slug}
      task=${task}
      depth=${depth}
      blocked=${blocked}
      fuzzyQuery=${fuzzyQuery}
      fuzzyMatchMap=${fuzzyMatchMap}
      activeTask=${activeTask?.id === task.id ? activeTask : null}
      activeTaskMode=${activeTaskMode}
      onDeleteTask=${onDeleteTask}
      onSaveComment=${onSaveComment}
      onOpenTask=${onOpenTask}
      onCloseTask=${onCloseTask}
      onOpenTaskModal=${onOpenTaskModal}
    />
  `;

  const renderExplicitNode = (task, depth = 0, path = new Set()) => {
    if (!task || path.has(task.id)) {
      return html`<div class="tree-cycle" style=${`--tree-depth: ${depth}`}>cycle skipped</div>`;
    }

    const nextPath = new Set(path);
    nextPath.add(task.id);
    const children = model.childrenByParent.get(task.id) || [];
    const childNodes = children
      .map((child) => renderExplicitNode(child, depth + 1, nextPath))
      .filter(Boolean);
    const selfVisible = taskMatchesBoardFilters(task, filterState);
    const grouped = isGroupTask(task) || children.length > 0;

    if (!grouped) return selfVisible ? renderTask(task, depth) : null;
    if (!selfVisible && childNodes.length === 0) return null;

    const nodeId = `task:${task.id}`;
    const isCollapsed = collapsed.has(nodeId);
    const descendants = children.flatMap((child) => flattenTreeTasks(child, model.childrenByParent, nextPath));
    const summary = summarizeTreeTasks(descendants, blocked);

    return html`
      <div class="tree-node tree-node--group" key=${task.id}>
        <${TreeGroupHeader}
          id=${task.id}
          title=${task.title}
          subtitle=${task.goal || task.context?.notes || null}
          status=${task.status}
          depth=${depth}
          summary=${summary}
          collapsed=${isCollapsed}
          canToggle=${childNodes.length > 0}
          task=${task}
          onToggle=${() => toggleCollapsed(nodeId)}
          onOpenTask=${onOpenTask}
          onOpenTaskModal=${onOpenTaskModal}
        />
        ${activeTask?.id === task.id
          ? html`<div class="tree-group__drawer" style=${`--tree-depth: ${depth + 1}`}>
              <${TaskInlineDrawer}
                slug=${slug}
                task=${activeTask}
                initialMode=${activeTaskMode || "brief"}
                onOpenTask=${(taskId, mode) => onOpenTask && onOpenTask({ id: taskId }, mode)}
                onClose=${onCloseTask}
              />
            </div>`
          : null}
        ${!isCollapsed && childNodes.length > 0
          ? html`<div class="tree-children">${childNodes}</div>`
          : null}
      </div>
    `;
  };

  const renderSwimlaneRoot = (root) => {
    const laneTextMatches =
      !!filterQuery &&
      (root.label.toLowerCase().includes(filterQuery.toLowerCase()) ||
        root.id.toLowerCase().includes(filterQuery.toLowerCase()));
    const childFilterState = laneTextMatches ? { ...filterState, filterQuery: "" } : filterState;
    const visibleTasks = root.tasks.filter((task) => taskMatchesBoardFilters(task, childFilterState));
    const filtersActive =
      !!filterQuery ||
      (statusFilters && statusFilters.size > 0) ||
      (blockFilters && blockFilters.size > 0);
    if (visibleTasks.length === 0 && filtersActive && !laneTextMatches) return null;

    const nodeId = root.id;
    const isCollapsed = collapsed.has(nodeId);
    const summary = summarizeTreeTasks(root.tasks, blocked);
    const childNodes = visibleTasks.map((task) => renderTask(task, 1));

    return html`
      <div class="tree-node tree-node--swimlane" key=${root.id}>
        <${TreeGroupHeader}
          id=${root.lane.id}
          title=${root.label}
          subtitle=${root.description}
          depth=${0}
          summary=${summary}
          collapsed=${isCollapsed}
          canToggle=${childNodes.length > 0}
          onToggle=${() => toggleCollapsed(nodeId)}
        />
        ${!isCollapsed
          ? html`<div class="tree-children">
              ${childNodes.length > 0
                ? childNodes
                : html`<div class="tree-empty" style=${`--tree-depth: 1`}>no tasks</div>`}
            </div>`
          : null}
      </div>
    `;
  };

  const nodes = model.mode === "swimlane"
    ? model.roots.map(renderSwimlaneRoot).filter(Boolean)
    : model.roots.map((task) => renderExplicitNode(task, 0)).filter(Boolean);

  return html`
    <div class="tree-wrap">
      <div class="tree-view">
        <div class="tree-view__header">
          <span>${model.mode === "swimlane" ? "swimlanes as groups" : "task groups"}</span>
          <div class="tree-view__header-meta">
            <span>${nodes.length} roots</span>
            <div class="tree-view__actions">
              <${Bracket}
                label="EXPAND"
                soft
                title="Expand all tree groups"
                disabled=${collapsedCount === 0}
                onClick=${() => setCollapsed(new Set())}
              />
              <${Bracket}
                label="COLLAPSE"
                soft
                title="Collapse all tree groups"
                disabled=${collapsibleIds.length === 0 || collapsedCount === collapsibleIds.length}
                onClick=${() => setCollapsed(new Set(collapsibleIds))}
              />
            </div>
          </div>
        </div>
        ${nodes.length > 0
          ? nodes
          : html`<div class="tree-empty" style=${`--tree-depth: 0`}>no matching tasks</div>`}
      </div>
    </div>
  `;
}
