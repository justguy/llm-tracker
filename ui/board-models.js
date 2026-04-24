import * as dagre from "@dagrejs/dagre";

export const STATUS_PILL_LABEL = {
  complete: "COMPLETE",
  in_progress: "IN PROGRESS",
  not_started: "NOT STARTED",
  deferred: "DEFERRED",
  blocked: "BLOCKED",
};

export function taskParentId(task) {
  return typeof task?.parent_id === "string" && task.parent_id.trim()
    ? task.parent_id.trim()
    : null;
}

export function isGroupTask(task) {
  return task?.kind === "group";
}

export function priorityIndex(priorityId, priorities = []) {
  const index = priorities.findIndex((priority) => priority.id === priorityId);
  return index === -1 ? priorities.length : index;
}

export function taskMatchesText(task, filterQuery) {
  if (!filterQuery) return true;
  const query = filterQuery.toLowerCase();
  if (task.title.toLowerCase().includes(query)) return true;
  if (task.id.toLowerCase().includes(query)) return true;
  if ((task.goal || "").toLowerCase().includes(query)) return true;
  const tags = (task.context && task.context.tags) || [];
  if (tags.some((tag) => String(tag).toLowerCase().includes(query))) return true;
  return false;
}

export function taskIsBlocked(task, blocked) {
  return !!(blocked?.[task.id] && blocked[task.id].length > 0);
}

export function taskMatchesBoardFilters(task, { filterQuery, statusFilters, blockFilters, blocked }) {
  const statusOk = !statusFilters || statusFilters.size === 0 || statusFilters.has(task.status);
  const blockOk =
    !blockFilters ||
    blockFilters.size === 0 ||
    blockFilters.has(taskIsBlocked(task, blocked) ? "blocked" : "open");
  return statusOk && blockOk && taskMatchesText(task, filterQuery);
}

export function countTasksByStatus(tasks = []) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  return counts;
}

export function flattenTreeTasks(task, childrenByParent, path = new Set()) {
  if (!task || path.has(task.id)) return [];
  const nextPath = new Set(path);
  nextPath.add(task.id);
  const children = childrenByParent.get(task.id) || [];
  return [task, ...children.flatMap((child) => flattenTreeTasks(child, childrenByParent, nextPath))];
}

export function summarizeTreeTasks(tasks = [], blocked = {}) {
  const counts = countTasksByStatus(tasks);
  const total = tasks.length;
  const done = counts.complete || 0;
  const blockedCount = tasks.filter((task) => taskIsBlocked(task, blocked)).length;
  return {
    counts,
    total,
    done,
    active: counts.in_progress || 0,
    blocked: blockedCount,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

export function buildTreeModel(project) {
  const tasks = project?.data?.tasks || [];
  const swimlanes = project?.data?.meta?.swimlanes || [];
  const priorities = project?.data?.meta?.priorities || [];
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const hasExplicitTree = tasks.some((task) => isGroupTask(task) || taskParentId(task));

  const compareTasks = (a, b) => {
    const laneCompare = String(a.placement?.swimlaneId || "").localeCompare(String(b.placement?.swimlaneId || ""));
    if (laneCompare !== 0) return laneCompare;
    const priorityCompare =
      priorityIndex(a.placement?.priorityId, priorities) - priorityIndex(b.placement?.priorityId, priorities);
    if (priorityCompare !== 0) return priorityCompare;
    return (taskOrder.get(a.id) ?? 0) - (taskOrder.get(b.id) ?? 0);
  };

  if (!hasExplicitTree) {
    return {
      mode: "swimlane",
      roots: swimlanes.map((lane) => ({
        id: `swimlane:${lane.id}`,
        label: lane.label,
        description: lane.description || null,
        lane,
        tasks: tasks
          .filter((task) => task.placement?.swimlaneId === lane.id)
          .sort(compareTasks),
      })),
      childrenByParent: new Map(),
      taskOrder,
    };
  }

  const childrenByParent = new Map();
  const roots = [];
  for (const task of tasks) {
    const parentId = taskParentId(task);
    if (parentId && parentId !== task.id && byId.has(parentId)) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(task);
    } else {
      roots.push(task);
    }
  }

  for (const children of childrenByParent.values()) children.sort(compareTasks);
  roots.sort(compareTasks);

  return {
    mode: "explicit",
    roots,
    childrenByParent,
    taskOrder,
  };
}

export function collectTreeCollapseIds(model) {
  if (!model) return [];
  if (model.mode === "swimlane") {
    return model.roots
      .filter((root) => root.tasks.length > 0)
      .map((root) => root.id);
  }

  const ids = [];
  const visit = (task, path = new Set()) => {
    if (!task || path.has(task.id)) return;
    const nextPath = new Set(path);
    nextPath.add(task.id);
    const children = model.childrenByParent.get(task.id) || [];
    if (children.length > 0) ids.push(`task:${task.id}`);
    for (const child of children) visit(child, nextPath);
  };

  for (const root of model.roots) visit(root);
  return ids;
}

export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 82;

export function buildDependencyGraphModel(project, {
  filterQuery = "",
  statusFilters = new Set(),
  blockFilters = new Set(),
  includeContainment = false,
} = {}) {
  const tasks = project?.data?.tasks || [];
  const blocked = project?.derived?.blocked || {};
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visibleTasks = tasks.filter((task) =>
    taskMatchesBoardFilters(task, { filterQuery, statusFilters, blockFilters, blocked })
  );
  const visibleIds = new Set(visibleTasks.map((task) => task.id));
  const nodes = visibleTasks.map((task, index) => ({
    id: task.id,
    task,
    index,
    blocked: taskIsBlocked(task, blocked),
    group: isGroupTask(task) || tasks.some((candidate) => taskParentId(candidate) === task.id),
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
  }));
  const edges = [];

  for (const task of visibleTasks) {
    for (const dependencyId of task.dependencies || []) {
      if (!byId.has(dependencyId) || !visibleIds.has(dependencyId)) continue;
      edges.push({
        id: `dep:${dependencyId}->${task.id}`,
        from: dependencyId,
        to: task.id,
        kind: "dependency",
      });
    }

    const parentId = taskParentId(task);
    if (includeContainment && parentId && byId.has(parentId) && visibleIds.has(parentId)) {
      edges.push({
        id: `containment:${parentId}->${task.id}`,
        from: parentId,
        to: task.id,
        kind: "containment",
      });
    }
  }

  return { nodes, edges };
}

export function layoutDependencyGraph(model, dagreModule = dagre) {
  const graph = new dagreModule.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    nodesep: 42,
    ranksep: 110,
    edgesep: 16,
    marginx: 28,
    marginy: 28,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of model.nodes) {
    graph.setNode(node.id, {
      width: node.width || GRAPH_NODE_WIDTH,
      height: node.height || GRAPH_NODE_HEIGHT,
    });
  }
  model.edges.forEach((edge, index) => {
    graph.setEdge(edge.from, edge.to, { kind: edge.kind }, `${edge.kind}:${index}`);
  });

  dagreModule.layout(graph);

  const nodes = model.nodes.map((node) => {
    const positioned = graph.node(node.id) || {};
    return {
      ...node,
      x: Number.isFinite(positioned.x) ? positioned.x : 0,
      y: Number.isFinite(positioned.y) ? positioned.y : 0,
    };
  });
  const edges = model.edges.map((edge, index) => {
    const positioned = graph.edge({ v: edge.from, w: edge.to, name: `${edge.kind}:${index}` }) || {};
    return {
      ...edge,
      points: positioned.points || [],
    };
  });
  const graphLabel = graph.graph() || {};
  const width = Math.max(360, Math.ceil(graphLabel.width || GRAPH_NODE_WIDTH + 56));
  const height = Math.max(260, Math.ceil(graphLabel.height || GRAPH_NODE_HEIGHT + 56));

  return { nodes, edges, width, height };
}

export function graphEdgePath(points = []) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

export function graphText(value, max = 34) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function computeDropTargetIndex({
  tasks = [],
  draggedTaskId,
  beforeTaskId = null,
  afterTaskId = null,
} = {}) {
  const ordered = tasks.filter((task) => task.id !== draggedTaskId);

  if (beforeTaskId) {
    const index = ordered.findIndex((task) => task.id === beforeTaskId);
    if (index !== -1) return index;
  }

  if (afterTaskId) {
    const index = ordered.findIndex((task) => task.id === afterTaskId);
    if (index !== -1) return index + 1;
  }

  return ordered.length;
}
