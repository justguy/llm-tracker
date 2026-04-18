import { readHistory } from "./snapshots.js";
import { normalizeTaskReferences } from "./references.js";
import { loadReferenceSnippets, SNIPPET_MAX_BYTES, SNIPPET_MAX_COUNT } from "./snippets.js";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const BRIEF_HISTORY_LIMIT = 3;

function stringArray(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string" && value.trim());
}

function summarizeTaskForBrief(task, context) {
  const summary = summarizeTask(task, context);
  return {
    id: summary.id,
    title: summary.title,
    goal: task.goal || null,
    status: summary.status,
    assignee: summary.assignee,
    priorityId: summary.priorityId,
    swimlaneId: summary.swimlaneId,
    effort: summary.effort,
    ready: summary.ready,
    blocked_kind: summary.blocked_kind,
    blocking_on: summary.blocking_on,
    blocker_reason: summary.blocker_reason,
    requires_approval: summary.requires_approval,
    references: summary.references,
    comment: summary.comment,
    lastTouchedRev: summary.lastTouchedRev,
    dependencies: stringArray(task.dependencies),
    related: stringArray(task.related),
    definition_of_done: stringArray(task.definition_of_done),
    constraints: stringArray(task.constraints),
    expected_changes: stringArray(task.expected_changes),
    allowed_paths: stringArray(task.allowed_paths)
  };
}

function summarizeTaskIds(taskIds, context) {
  return taskIds
    .map((taskId) => context.byId.get(taskId))
    .filter(Boolean)
    .map((task) => summarizeTaskForBrief(task, context));
}

function deltaChangeKeys(delta) {
  if (!delta || typeof delta !== "object") return [];
  if (delta.__added__) return ["__added__"];
  if (delta.__removed__) return ["__removed__"];
  return Object.keys(delta).sort();
}

function deltaChangeKinds(delta) {
  const keys = deltaChangeKeys(delta);
  const kinds = new Set();
  for (const key of keys) {
    if (key === "__added__") kinds.add("added");
    else if (key === "__removed__") kinds.add("removed");
    else if (key === "status") kinds.add("status");
    else if (key === "placement") kinds.add("placement");
    else if (key === "dependencies") kinds.add("dependencies");
    else if (key === "assignee") kinds.add("assignee");
    else if (key === "reference" || key === "references") kinds.add("references");
    else if (key === "comment" || key === "blocker_reason") kinds.add("notes");
    else kinds.add("edit");
  }
  return Array.from(kinds).sort();
}

function collectTaskHistory(history = [], taskId) {
  return history
    .filter((entry) => Object.prototype.hasOwnProperty.call(entry?.delta?.tasks || {}, taskId))
    .sort((a, b) => (b.rev ?? -1) - (a.rev ?? -1))
    .map((entry) => {
      const delta = entry?.delta?.tasks?.[taskId];
      return {
        rev: entry.rev,
        ts: entry.ts,
        summary: Array.isArray(entry.summary) ? entry.summary : [],
        changedKeys: deltaChangeKeys(delta),
        changeKinds: deltaChangeKinds(delta)
      };
    });
}

function applySnippetBudget(snippets = []) {
  const limited = [];
  let usedBytes = 0;
  let byteCapped = false;

  for (const snippet of snippets) {
    if (limited.length >= SNIPPET_MAX_COUNT) break;

    const size = Buffer.byteLength(snippet.text || "", "utf-8");
    if (snippet.text && usedBytes + size > SNIPPET_MAX_BYTES) {
      byteCapped = true;
      continue;
    }

    limited.push(snippet);
    usedBytes += size;
  }

  const totalBytes = snippets.reduce((sum, snippet) => sum + Buffer.byteLength(snippet.text || "", "utf-8"), 0);
  return {
    snippets: limited,
    returnedBytes: usedBytes,
    applied: limited.length < snippets.length,
    byteCapped,
    totalAvailable: snippets.length,
    totalAvailableBytes: totalBytes
  };
}

export function selectBriefReferences(task, context) {
  const selected = [];
  const seen = new Set();

  const addReference = (value, selectedBecause) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    selected.push({ value, selectedBecause });
  };

  for (const value of normalizeTaskReferences(task)) {
    addReference(value, "explicit task reference");
  }

  for (const dependencyId of stringArray(task.dependencies)) {
    const dependency = context.byId.get(dependencyId);
    if (!dependency) continue;
    for (const value of normalizeTaskReferences(dependency)) {
      addReference(value, `dependency reference from ${dependencyId}`);
    }
  }

  return selected;
}

export function buildBriefPayload({
  slug,
  data,
  history = [],
  taskId,
  references = null,
  snippets = [],
  now = new Date().toISOString()
}) {
  const context = buildProjectTaskContext({ data, history });
  const task = context.byId.get(taskId);
  if (!task) return null;

  const taskPack = summarizeTaskForBrief(task, context);
  const selectedReferences = references || selectBriefReferences(task, context);
  const selectedBecause = new Map(selectedReferences.map((reference) => [reference.value, reference.selectedBecause]));
  const enrichedSnippets = snippets.map((snippet) => ({
    ...snippet,
    selectedBecause: selectedBecause.get(snippet.reference) || "derived snippet"
  }));
  const snippetBudget = applySnippetBudget(enrichedSnippets);
  const relatedHistory = collectTaskHistory(history, taskId);
  const recentHistory = relatedHistory.slice(0, BRIEF_HISTORY_LIMIT);

  return {
    packType: "brief",
    project: slug,
    taskId,
    rev: context.currentRev,
    generatedAt: now,
    task: taskPack,
    dependencies: summarizeTaskIds(taskPack.dependencies, context),
    relatedTasks: summarizeTaskIds(taskPack.related, context),
    references: selectedReferences,
    snippets: snippetBudget.snippets,
    recentHistory,
    truncation: {
      snippets: {
        applied: snippetBudget.applied,
        byteCapped: snippetBudget.byteCapped,
        returned: snippetBudget.snippets.length,
        totalAvailable: snippetBudget.totalAvailable,
        returnedBytes: snippetBudget.returnedBytes,
        totalAvailableBytes: snippetBudget.totalAvailableBytes,
        maxCount: SNIPPET_MAX_COUNT,
        maxBytes: SNIPPET_MAX_BYTES
      },
      history: {
        applied: recentHistory.length < relatedHistory.length,
        returned: recentHistory.length,
        totalAvailable: relatedHistory.length,
        maxCount: BRIEF_HISTORY_LIMIT
      }
    }
  };
}

export function getBriefPayload({ workspace, slug, entry, taskId, now }) {
  if (!entry?.data) {
    return { ok: false, status: 404, message: "not found" };
  }

  const history = readHistory(workspace, slug);
  const context = buildProjectTaskContext({ data: entry.data, history });
  const task = context.byId.get(taskId);
  if (!task) {
    return { ok: false, status: 404, message: "task not found" };
  }

  const references = selectBriefReferences(task, context);
  const { snippets } = loadReferenceSnippets({
    workspace,
    slug,
    trackerPath: entry.path,
    references: references.map((reference) => reference.value),
    indexedAtRev: entry.rev ?? entry.data?.meta?.rev ?? null
  });

  return {
    ok: true,
    payload: buildBriefPayload({
      slug,
      data: entry.data,
      history,
      taskId,
      references,
      snippets,
      now
    })
  };
}
