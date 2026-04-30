import { buildWorkspaceLookup } from "./cross-project-deps.js";
import { readHistory } from "./snapshots.js";
import { buildBriefPayload, selectBriefReferences } from "./briefs.js";
import { buildDecisionsPayload } from "./decisions.js";
import { buildWhyPayload } from "./why.js";
import { loadReferenceSnippets } from "./snippets.js";
import { buildProjectTaskContext } from "./task-metadata.js";

const HANDOFF_DECISION_LIMIT = 5;

function bullet(values) {
  return values.map((value) => `- ${value}`);
}

function markdownFenceFor(text) {
  const matches = String(text || "").match(/`+/g) || [];
  const longest = matches.reduce((max, value) => Math.max(max, value.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function renderHandoffPrompt({ slug, rev, fromAssignee, toAssignee, brief, why, decisions }) {
  const lines = [];
  const task = brief.task;

  lines.push(`# Handoff: ${slug}/${task.id} — ${task.title}`);
  if (fromAssignee || toAssignee) {
    lines.push(`From: ${fromAssignee || "(unspecified)"}  →  To: ${toAssignee || "(next agent)"}`);
  }
  lines.push(
    `Project rev: ${rev ?? "?"}  ·  status: ${task.status}  ·  priority: ${
      task.priorityId || "p?"
    }  ·  swimlane: ${task.swimlaneId || "?"}`
  );
  lines.push("");

  if (task.goal) {
    lines.push("## Goal");
    lines.push(task.goal);
    lines.push("");
  }

  lines.push("## Readiness");
  lines.push(`- actionability: ${task.actionability}`);
  if (task.blocking_on?.length > 0) lines.push(`- blocked by: ${task.blocking_on.join(", ")}`);
  if (task.decision_required?.length > 0) {
    lines.push(`- decision required: ${task.decision_required.join(", ")}`);
  }
  if (task.requires_approval?.length > 0) {
    lines.push(`- approval required for: ${task.requires_approval.join(", ")}`);
  }
  if (task.not_actionable_reason) {
    lines.push(`- not actionable: ${task.not_actionable_reason}`);
  }
  lines.push("");

  if (task.definition_of_done?.length > 0) {
    lines.push("## Definition of done");
    lines.push(...bullet(task.definition_of_done));
    lines.push("");
  }
  if (task.constraints?.length > 0) {
    lines.push("## Constraints");
    lines.push(...bullet(task.constraints));
    lines.push("");
  }
  if (task.expected_changes?.length > 0) {
    lines.push("## Expected changes");
    lines.push(...bullet(task.expected_changes));
    lines.push("");
  }
  if (task.allowed_paths?.length > 0) {
    lines.push("## Allowed paths");
    lines.push(...bullet(task.allowed_paths));
    lines.push("");
  }

  if (task.repos) {
    lines.push("## Cross-repo scope");
    if (task.repos.primary) lines.push(`- primary: ${task.repos.primary}`);
    if ((task.repos.secondary || []).length > 0) {
      lines.push(`- secondary: ${task.repos.secondary.join(", ")}`);
    }
    for (const [repo, paths] of Object.entries(task.repos.allowed_paths || {})) {
      lines.push(`- in ${repo}, keep edits within: ${paths.join(", ")}`);
    }
    if ((task.repos.approval_required_for || []).length > 0) {
      lines.push(`- approval required before editing: ${task.repos.approval_required_for.join(", ")}`);
    }
    lines.push("");
  }

  if (why?.why?.length > 0) {
    lines.push("## Why this matters");
    for (const reason of why.why) {
      lines.push(`- ${reason.kind}: ${reason.text}`);
    }
    lines.push("");
  }

  if (task.blocker_reason) {
    lines.push("## Blocker reason");
    lines.push(task.blocker_reason);
    lines.push("");
  }
  if (task.comment) {
    lines.push("## Decision note");
    lines.push(task.comment);
    lines.push("");
  }

  if (brief.dependencies?.length > 0) {
    lines.push("## Dependencies");
    for (const dep of brief.dependencies) {
      lines.push(`- ${dep.id} [${dep.status}] ${dep.title}`);
    }
    lines.push("");
  }

  if ((task.external_dependencies || []).length > 0) {
    lines.push("## External dependencies");
    for (const ext of task.external_dependencies) {
      const detail = ext.exists
        ? `[${ext.status || "?"}] ${ext.title || ""}`.trim()
        : "[missing]";
      lines.push(`- ${ext.slug}:${ext.taskId} ${detail}`);
    }
    lines.push("");
  }

  if (brief.references?.length > 0) {
    lines.push("## References");
    for (const ref of brief.references) {
      lines.push(`- ${ref.value} (${ref.selectedBecause})`);
    }
    lines.push("");
  }

  if (brief.snippets?.length > 0) {
    lines.push("## Snippets");
    for (const snippet of brief.snippets) {
      const fence = markdownFenceFor(snippet.text);
      lines.push(`### ${snippet.reference}`);
      lines.push(fence);
      lines.push(snippet.text || "");
      lines.push(fence);
    }
    lines.push("");
  }

  if (decisions?.decisions?.length > 0) {
    lines.push("## Recent project decisions");
    for (const decision of decisions.decisions) {
      const note = decision.comment ? ` — ${decision.comment}` : "";
      lines.push(`- ${decision.id} [${decision.status}] ${decision.title}${note}`);
    }
    lines.push("");
  }

  if (brief.recentHistory?.length > 0) {
    lines.push("## Recent task history");
    for (const entry of brief.recentHistory) {
      const kinds = (entry.changeKinds || []).join(", ") || "edit";
      lines.push(`- rev ${entry.rev} (${entry.ts || "ts unknown"}): ${kinds}`);
    }
    lines.push("");
  }

  lines.push("## Next step");
  lines.push(
    `Use \`tracker_execute\` for ${slug}/${task.id} to confirm readiness, then implement and call \`tracker_verify\` before marking complete.`
  );

  return lines.join("\n");
}

export function buildHandoffPayload({
  slug,
  data,
  history = [],
  externalLookup = null,
  taskId,
  references = null,
  snippets = [],
  fromAssignee = null,
  toAssignee = null,
  now = new Date().toISOString()
}) {
  const brief = buildBriefPayload({
    slug,
    data,
    history,
    externalLookup,
    taskId,
    references,
    snippets,
    now
  });
  if (!brief) return null;

  const why = buildWhyPayload({ slug, data, history, externalLookup, taskId, now }) || null;
  const decisions = buildDecisionsPayload({
    slug,
    data,
    history,
    limit: HANDOFF_DECISION_LIMIT,
    now
  });

  const fromAgent = fromAssignee || brief.task.assignee || null;
  const handoffPrompt = renderHandoffPrompt({
    slug,
    rev: brief.rev,
    fromAssignee: fromAgent,
    toAssignee: toAssignee || null,
    brief,
    why,
    decisions
  });

  return {
    packType: "handoff",
    project: slug,
    taskId,
    rev: brief.rev,
    generatedAt: now,
    fromAssignee: fromAgent,
    toAssignee: toAssignee || null,
    task: brief.task,
    readiness: {
      actionability: brief.task.actionability,
      actionable: brief.task.actionable,
      ready: brief.task.ready,
      blocked_kind: brief.task.blocked_kind,
      blocked_by: brief.task.blocked_by,
      blocking_on: brief.task.blocking_on,
      decision_required: brief.task.decision_required,
      decision_reason: brief.task.decision_reason,
      not_actionable_reason: brief.task.not_actionable_reason,
      requires_approval: brief.task.requires_approval
    },
    executionContract: {
      definition_of_done: brief.task.definition_of_done,
      constraints: brief.task.constraints,
      expected_changes: brief.task.expected_changes,
      allowed_paths: brief.task.allowed_paths,
      repos: brief.task.repos || null,
      approval_required_for: brief.task.requires_approval,
      traceability: brief.task.traceability
    },
    why: why?.why || [],
    blockedBy: why?.blockedBy || [],
    unblocks: why?.unblocks || [],
    dependencies: brief.dependencies,
    relatedTasks: brief.relatedTasks,
    references: brief.references,
    snippets: brief.snippets,
    recentDecisions: decisions?.decisions || [],
    recentHistory: brief.recentHistory,
    handoffPrompt,
    truncation: brief.truncation
  };
}

export function getHandoffPayload({
  workspace,
  slug,
  entry,
  externalLookup,
  taskId,
  fromAssignee,
  toAssignee,
  now
}) {
  if (!entry?.data) return { ok: false, status: 404, message: "not found" };

  const history = readHistory(workspace, slug);
  const lookup =
    externalLookup ||
    buildWorkspaceLookup(workspace, { selfSlug: slug, selfData: entry.data });
  const context = buildProjectTaskContext({
    data: entry.data,
    history,
    externalLookup: lookup
  });
  const task = context.byId.get(taskId);
  if (!task) return { ok: false, status: 404, message: "task not found" };

  const references = selectBriefReferences(task, context);
  const { snippets } = loadReferenceSnippets({
    workspace,
    slug,
    trackerPath: entry.path,
    references: references.map((reference) => reference.value),
    indexedAtRev: entry.rev ?? entry.data?.meta?.rev ?? null
  });

  const payload = buildHandoffPayload({
    slug,
    data: entry.data,
    history,
    externalLookup: lookup,
    taskId,
    references,
    snippets,
    fromAssignee,
    toAssignee,
    now
  });

  return { ok: true, payload };
}
