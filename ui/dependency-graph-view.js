import { useEffect, useMemo, useState } from "preact/hooks";
import { html } from "htm/preact";
import { Bracket } from "./primitives.js";
import { TaskInlineDrawer } from "./task-drawer.js";
import {
  buildDependencyGraphModel,
  graphEdgePath,
  graphText,
  layoutDependencyGraph
} from "./board-models.js";

export function DependencyGraphView({
  project,
  slug,
  filterQuery,
  statusFilters,
  blockFilters,
  fuzzyQuery,
  fuzzyMatchMap,
  activeTask,
  activeTaskMode,
  onOpenTask,
  onCloseTask,
}) {
  const [showContainment, setShowContainment] = useState(false);
  const [dagreModule, setDagreModule] = useState(null);
  useEffect(() => {
    let active = true;
    import("@dagrejs/dagre")
      .then((module) => {
        if (active) setDagreModule(module);
      })
      .catch(() => {
        if (active) setDagreModule(null);
      });
    return () => {
      active = false;
    };
  }, []);
  const graphModel = useMemo(
    () => buildDependencyGraphModel(project, {
      filterQuery,
      statusFilters,
      blockFilters,
      includeContainment: showContainment,
    }),
    [project, filterQuery, statusFilters, blockFilters, showContainment]
  );
  const layout = useMemo(() => layoutDependencyGraph(graphModel, dagreModule), [graphModel, dagreModule]);
  const markerBase = `graph-${String(slug || "project").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const depMarkerId = `${markerBase}-dep-arrow`;
  const containmentMarkerId = `${markerBase}-containment-arrow`;
  const activeVisibleTask = activeTask && graphModel.nodes.some((node) => node.id === activeTask.id) ? activeTask : null;
  const activeTaskId = activeVisibleTask?.id || null;

  return html`
    <div class="graph-wrap">
      <div class="dependency-graph">
        <div class="dependency-graph__header">
          <div class="dependency-graph__title">
            <span>dependency graph</span>
            <span>${layout.nodes.length} nodes</span>
            <span>${graphModel.edges.filter((edge) => edge.kind === "dependency").length} deps</span>
          </div>
          <div class="dependency-graph__actions">
            <${Bracket} label="DEPS" active title="Dependency edges from dependencies[]" />
            <${Bracket}
              label="CONTAINMENT"
              active=${showContainment}
              soft=${!showContainment}
              title="Toggle parent_id containment overlay"
              onClick=${() => setShowContainment((value) => !value)}
            />
          </div>
        </div>
        ${layout.nodes.length === 0
          ? html`<div class="graph-empty">no matching tasks</div>`
          : html`
              <div class="dependency-graph__canvas">
                <svg
                  class="dependency-graph__svg"
                  viewBox=${`0 0 ${layout.width} ${layout.height}`}
                  role="img"
                  aria-label="Task dependency graph"
                >
                  <defs>
                    <marker
                      id=${depMarkerId}
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                      markerUnits="strokeWidth"
                    >
                      <path d="M 0 0 L 8 4 L 0 8 z" class="dependency-graph__marker dependency-graph__marker--dependency" />
                    </marker>
                    <marker
                      id=${containmentMarkerId}
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                      markerUnits="strokeWidth"
                    >
                      <path d="M 0 0 L 8 4 L 0 8 z" class="dependency-graph__marker dependency-graph__marker--containment" />
                    </marker>
                  </defs>
                  <g class="dependency-graph__edges">
                    ${layout.edges.map((edge) => html`
                      <path
                        key=${edge.id}
                        class=${`dependency-edge dependency-edge--${edge.kind}`}
                        d=${graphEdgePath(edge.points)}
                        marker-end=${`url(#${edge.kind === "containment" ? containmentMarkerId : depMarkerId})`}
                      >
                        <title>${edge.kind === "containment" ? "contains" : "blocks"}: ${edge.from} -> ${edge.to}</title>
                      </path>
                    `)}
                  </g>
                  <g class="dependency-graph__nodes">
                    ${layout.nodes.map((node) => {
                      const task = node.task;
                      const searchMatch = fuzzyMatchMap?.get(task.id) || null;
                      const fuzzyDim = !!(fuzzyQuery && fuzzyQuery.trim()) && !searchMatch;
                      const x = node.x - node.width / 2;
                      const y = node.y - node.height / 2;
                      return html`
                        <g
                          key=${node.id}
                          class=${[
                            "dependency-node",
                            `status-${task.status}`,
                            node.blocked ? "dependency-node--blocked" : "dependency-node--open",
                            node.group ? "dependency-node--group" : "",
                            activeTaskId === task.id ? "dependency-node--active" : "",
                            searchMatch ? "fuzzy-hit" : "",
                            fuzzyDim ? "fuzzy-dim" : "",
                          ].filter(Boolean).join(" ")}
                          transform=${`translate(${x}, ${y})`}
                          role="button"
                          tabIndex="0"
                          aria-label=${`Task ${task.id}: ${task.title}`}
                          onClick=${() => onOpenTask && onOpenTask(task, "brief")}
                          onKeyDown=${(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onOpenTask && onOpenTask(task, "brief");
                            }
                          }}
                        >
                          <title>${task.id}: ${task.title}</title>
                          <rect class="dependency-node__box" width=${node.width} height=${node.height} rx="0" />
                          <text class="dependency-node__id" x="12" y="19">${graphText(task.id, 28)}</text>
                          <text class="dependency-node__title" x="12" y="39">${graphText(task.title, 30)}</text>
                          <text class="dependency-node__meta" x="12" y="61">
                            ${task.placement?.priorityId || "p?"} - ${task.placement?.swimlaneId || "lane?"} - ${node.blocked ? "blocked" : "open"}
                          </text>
                          ${node.group
                            ? html`<text class="dependency-node__kind" x=${node.width - 56} y="19">GROUP</text>`
                            : null}
                        </g>
                      `;
                    })}
                  </g>
                </svg>
              </div>
            `}
        ${activeVisibleTask
          ? html`<div class="dependency-graph__drawer">
              <${TaskInlineDrawer}
                slug=${slug}
                task=${activeVisibleTask}
                initialMode=${activeTaskMode || "brief"}
                onOpenTask=${(taskId, mode) => onOpenTask && onOpenTask({ id: taskId }, mode)}
                onClose=${onCloseTask}
              />
            </div>`
          : null}
      </div>
    </div>
  `;
}
