import { Fragment } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";
import { Bracket, CopyInlineBtn, SegBar } from "./primitives.js";
import { TaskInlineDrawer } from "./task-drawer.js";
import { computeDropTargetIndex, taskMatchesBoardFilters } from "./board-models.js";
import { Card, eventComesFromNestedControl } from "./task-card.js";

export function Cell({
  slug,
  laneId,
  priorityId,
  tasks,
  blocked,
  filterQuery,
  statusFilters,
  blockFilters,
  fuzzyQuery,
  fuzzyMatchMap,
  dragState,
  setDragState,
  activeTask,
  activeTaskMode,
  onDrop,
  onDeleteTask,
  onSaveComment,
  onOpenTask,
  onCloseTask,
  onOpenTaskModal,
}) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);

  const filtered = tasks.filter((task) =>
    taskMatchesBoardFilters(task, { filterQuery, statusFilters, blockFilters, blocked })
  );

  const handleDragOver = (e) => {
    if (!dragState.taskId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  const handleDragLeave = (e) => {
    if (ref.current && !ref.current.contains(e.relatedTarget)) setOver(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setOver(false);
    if (!dragState.taskId) return;
    const y = e.clientY;
    let beforeTaskId = null;
    let afterTaskId = null;
    for (const child of ref.current.children) {
      if (!child.classList || !child.classList.contains("card")) continue;
      if (child.dataset.taskId === dragState.taskId) continue;
      const rect = child.getBoundingClientRect();
      if (y <= rect.top + rect.height / 2) {
        beforeTaskId = child.dataset.taskId;
        break;
      }
      afterTaskId = child.dataset.taskId;
    }
    const targetIndex = computeDropTargetIndex({
      tasks,
      draggedTaskId: dragState.taskId,
      beforeTaskId,
      afterTaskId,
    });
    onDrop({ taskId: dragState.taskId, swimlaneId: laneId, priorityId, targetIndex });
  };

  const isOrigin = dragState.taskId &&
    dragState.originLaneId === laneId &&
    dragState.originPriorityId === priorityId;

  return html`
    <div
      class=${[
        "cell",
        over ? "lane-cell--drag-over" : "",
        isOrigin ? "lane-cell--drag-origin" : "",
      ].filter(Boolean).join(" ")}
      ref=${ref}
      onDragOver=${handleDragOver}
      onDragLeave=${handleDragLeave}
      onDrop=${handleDrop}
    >
      ${filtered.length === 0 && tasks.length === 0
        ? html`<div class="cell-empty">no tasks</div>`
        : null}
      ${filtered.map(
        (task) => html`
          <${Fragment} key=${task.id}>
            <${Card}
              task=${task}
              blockedBy=${blocked[task.id]}
              searchMatch=${fuzzyMatchMap?.get(task.id) || null}
              fuzzyActive=${!!(fuzzyQuery && fuzzyQuery.trim())}
              activeMode=${activeTask?.id === task.id ? activeTaskMode : "brief"}
              expanded=${activeTask?.id === task.id}
              dragging=${dragState.taskId === task.id}
              onDragStart=${(e, selectedTask) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", selectedTask.id);
                setDragState({ taskId: selectedTask.id, originLaneId: laneId, originPriorityId: priorityId });
              }}
              onDragEnd=${() => setDragState({ taskId: null })}
              onDelete=${onDeleteTask}
              onSaveComment=${onSaveComment}
              onToggleExpand=${(selectedTask) => onOpenTask && onOpenTask(selectedTask, "brief")}
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
          </${Fragment}>
        `
      )}
    </div>
  `;
}

export function Matrix({
  project,
  slug,
  filterQuery,
  statusFilters,
  blockFilters,
  fuzzyQuery,
  fuzzyMatchMap,
  activeTask,
  activeTaskMode,
  onMove,
  onToggleCollapse,
  onMoveLane,
  onDeleteTask,
  onSaveComment,
  onOpenTask,
  onCloseTask,
  onOpenTaskModal,
}) {
  const [dragState, setDragState] = useState({ taskId: null });
  const swimlanes = project.data.meta.swimlanes;
  const priorities = project.data.meta.priorities;
  const blocked = project.derived?.blocked || {};

  const byCell = useMemo(() => {
    const map = {};
    for (const task of project.data.tasks) {
      const key = `${task.placement.swimlaneId}::${task.placement.priorityId}`;
      if (!map[key]) map[key] = [];
      map[key].push(task);
    }
    return map;
  }, [project]);

  const headerRow = html`
    <div class="hdr">
      <span class="brand">swimlane</span>
    </div>
    ${priorities.map(
      (priority) => html`
        <div class=${`hdr hdr-priority ${priority.id}`}>
          <span class="label">${priority.label}</span>
          <span class="brand">${priority.id}</span>
        </div>
      `
    )}
  `;

  const rows = swimlanes.map((lane) => {
    const laneIndex = swimlanes.findIndex((item) => item.id === lane.id);
    const canMoveUp = laneIndex > 0;
    const canMoveDown = laneIndex >= 0 && laneIndex < swimlanes.length - 1;
    const per = project.derived?.perSwimlane?.[lane.id] || { counts: {}, pct: 0, total: 0 };
    const active = per.counts.in_progress || 0;
    const allComplete = per.total > 0 && per.counts.complete === per.total;
    const effectiveCollapsed =
      lane.collapsed !== undefined ? lane.collapsed : allComplete;

    if (effectiveCollapsed) {
      const done = per.counts.complete || 0;
      const inProgress = per.counts.in_progress || 0;
      const donePct = per.total === 0 ? 0 : (done / per.total) * 100;
      const inProgressPct = per.total === 0 ? 0 : (inProgress / per.total) * 100;
      return html`
        <div
          class="lane-row--collapsed"
          key=${`lane-${lane.id}`}
          onClick=${() => onToggleCollapse(lane.id, false)}
          role="button"
          tabIndex="0"
          onKeyDown=${(e) => {
            if (eventComesFromNestedControl(e)) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleCollapse(lane.id, false);
            }
          }}
          title="Click to expand swimlane"
        >
          <div class="lane-row__label">
            <span class="lane-row__chevron">></span>
            ${lane.live
              ? html`<span class="lane-row__live" title="Live swimlane" aria-label="Live swimlane">
                  <span class="lane-row__live-dot"></span>
                  <span>LIVE</span>
                </span>`
              : null}
            <span class="lane-row__title" title=${lane.label}>${lane.label}</span>
          </div>
          <div class="lane-row__stats">
            <span>${per.total} tasks</span>
            <span>- ${active} active</span>
            <span>- ${done} done</span>
            <div class="lane-row__progress">
              <div class="lane-row__progress-fill" style=${`width: ${donePct}%`}></div>
              ${inProgress > 0 ? html`<div class="lane-row__progress-warn" style=${`left: ${donePct}%; width: ${inProgressPct}%`}></div>` : null}
            </div>
            <span class="lane-row__pct">${per.pct}%</span>
            <div
              class="lane-row__actions"
              onClick=${(e) => e.stopPropagation()}
              onKeyDown=${(e) => e.stopPropagation()}
            >
              <${Bracket}
                label="UP"
                soft
                disabled=${!canMoveUp}
                title=${canMoveUp ? `Move ${lane.label} up` : `${lane.label} is already the top lane`}
                ariaLabel=${`Move lane ${lane.label} up`}
                onClick=${() => onMoveLane && onMoveLane(lane.id, "up")}
              />
              <${Bracket}
                label="DOWN"
                soft
                disabled=${!canMoveDown}
                title=${canMoveDown ? `Move ${lane.label} down` : `${lane.label} is already the bottom lane`}
                ariaLabel=${`Move lane ${lane.label} down`}
                onClick=${() => onMoveLane && onMoveLane(lane.id, "down")}
              />
            </div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="lane-cell" key=${`lane-${lane.id}`}>
        <div class="lane-cell-head">
          <button
            class="lane-chevron"
            aria-label="Collapse swimlane"
            onClick=${() => onToggleCollapse(lane.id, true)}
            title="Collapse swimlane"
          >v</button>
          <div class="lane-label">
            <span class="lane-label-text" title=${lane.label}>${lane.label}</span>
            <${CopyInlineBtn}
              value=${lane.label}
              label="Lane name"
              title=${`Copy lane name: ${lane.label}`}
            />
          </div>
        </div>
        <div class="lane-order-actions">
          <button
            class="icon-btn small"
            disabled=${!canMoveUp}
            aria-label=${`Increase priority of lane ${lane.label}`}
            title=${canMoveUp ? `Move ${lane.label} up` : `${lane.label} is already the top lane`}
            onClick=${() => onMoveLane && onMoveLane(lane.id, "up")}
          >[UP]</button>
          <button
            class="icon-btn small"
            disabled=${!canMoveDown}
            aria-label=${`Decrease priority of lane ${lane.label}`}
            title=${canMoveDown ? `Move ${lane.label} down` : `${lane.label} is already the bottom lane`}
            onClick=${() => onMoveLane && onMoveLane(lane.id, "down")}
          >[DOWN]</button>
        </div>
        ${lane.description ? html`<div class="lane-desc" title=${lane.description}>${lane.description}</div>` : null}
        <div class="lane-stats">
          <span>${per.total} tasks</span>
          <span class="active">- ${active} active</span>
        </div>
        <${SegBar} counts=${per.counts} total=${per.total} thin />
      </div>
      ${priorities.map(
        (priority) => html`
          <${Cell}
            key=${`${lane.id}::${priority.id}`}
            slug=${slug}
            laneId=${lane.id}
            priorityId=${priority.id}
            tasks=${byCell[`${lane.id}::${priority.id}`] || []}
            blocked=${blocked}
            filterQuery=${filterQuery}
            statusFilters=${statusFilters}
            blockFilters=${blockFilters}
            fuzzyQuery=${fuzzyQuery}
            fuzzyMatchMap=${fuzzyMatchMap}
            dragState=${dragState}
            setDragState=${setDragState}
            activeTask=${activeTask?.placement?.swimlaneId === lane.id && activeTask?.placement?.priorityId === priority.id ? activeTask : null}
            activeTaskMode=${activeTaskMode}
            onDrop=${onMove}
            onDeleteTask=${onDeleteTask}
            onSaveComment=${onSaveComment}
            onOpenTask=${onOpenTask}
            onCloseTask=${onCloseTask}
            onOpenTaskModal=${onOpenTaskModal}
          />
        `
      )}
    `;
  });

  return html`
    <div class="matrix-wrap">
      <div class="matrix" style=${`--col-count: ${priorities.length}`}>
        ${headerRow}
        ${rows}
      </div>
    </div>
  `;
}
