import { ensureHubResponse } from "./shared.js";

function indentBlock(text, prefix = "       ") {
  return (text || "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatTask(task) {
  const lines = [];
  const actionability = task.actionability || (task.ready ? "executable" : task.blocked_kind || "not_actionable");
  lines.push(`  ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${actionability}`);
  lines.push(`     ${task.title}`);

  const extras = [];
  if (task.status) extras.push(`status=${task.status}`);
  if (task.effort) extras.push(`effort=${task.effort}`);
  if (typeof task.lastTouchedRev === "number") extras.push(`lastTouchedRev=${task.lastTouchedRev}`);
  if (extras.length > 0) lines.push(`     ${extras.join(" · ")}`);

  if (task.goal) lines.push(`     goal: ${task.goal}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);
  lines.push(`     Actionability: ${actionability}`);
  if (task.blocked_by?.length > 0) lines.push(`     Blocked By: ${task.blocked_by.join(", ")}`);
  if (task.decision_required?.length > 0) lines.push(`     Decision Needed: ${task.decision_required.join(", ")}`);
  if (task.not_actionable_reason) lines.push(`     Why Not Actionable Now: ${task.not_actionable_reason}`);
  return lines.join("\n");
}

function formatLinkedTask(task, index) {
  const lines = [];
  const actionability = task.actionability || (task.ready ? "executable" : task.blocked_kind || "not_actionable");
  lines.push(`  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${actionability}`);
  lines.push(`     ${task.title}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);
  if (task.blocked_by?.length > 0) lines.push(`     blocked by: ${task.blocked_by.join(", ")}`);
  return lines.join("\n");
}

function formatReference(reference, index) {
  return `  ${index + 1}. ${reference.value}\n     why: ${reference.selectedBecause}`;
}

function formatSnippet(snippet, index) {
  const lines = [];
  lines.push(`  ${index + 1}. ${snippet.reference}`);
  lines.push(`     why: ${snippet.selectedBecause}`);
  if (snippet.error) {
    lines.push(`     error: ${snippet.error}`);
    return lines.join("\n");
  }
  if (snippet.hash) lines.push(`     hash: ${snippet.hash}`);
  lines.push("     text:");
  lines.push(indentBlock(snippet.text || ""));
  return lines.join("\n");
}

function formatHistory(entry, index) {
  const lines = [];
  lines.push(`  ${index + 1}. rev ${entry.rev}  ${entry.ts || "?"}`);
  if (entry.changeKinds?.length > 0) lines.push(`     kinds: ${entry.changeKinds.join(", ")}`);
  if (entry.changedKeys?.length > 0) lines.push(`     keys: ${entry.changedKeys.join(", ")}`);
  if (entry.summary?.length > 0) {
    const summary = entry.summary
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("; ");
    lines.push(`     summary: ${summary}`);
  }
  return lines.join("\n");
}

export async function cmdBrief(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const taskId = args._[2];
  if (!slug || !taskId) {
    console.error("Usage: llm-tracker brief <slug> <taskId> [--json]");
    process.exit(1);
  }

  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/tasks/${taskId}/brief`
  );
  ensureHubResponse(status, body, "Brief");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  task ${body.taskId}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  console.log(formatTask(body.task));

  if (body.dependencies?.length > 0) {
    console.log("  DEPENDENCIES");
    for (const [index, dependency] of body.dependencies.entries()) {
      console.log(formatLinkedTask(dependency, index));
    }
  }

  if (body.relatedTasks?.length > 0) {
    console.log("  RELATED");
    for (const [index, related] of body.relatedTasks.entries()) {
      console.log(formatLinkedTask(related, index));
    }
  }

  if (body.references?.length > 0) {
    console.log("  REFERENCES");
    for (const [index, reference] of body.references.entries()) {
      console.log(formatReference(reference, index));
    }
  }

  if (body.snippets?.length > 0) {
    console.log("  SNIPPETS");
    for (const [index, snippet] of body.snippets.entries()) {
      console.log(formatSnippet(snippet, index));
    }
    if (body.truncation?.snippets?.applied) {
      console.log(
        `  snippet budget: ${body.truncation.snippets.returned}/${body.truncation.snippets.totalAvailable} snippets, ${body.truncation.snippets.returnedBytes}/${body.truncation.snippets.maxBytes} bytes`
      );
    }
  } else {
    console.log("  no referenced snippets");
  }

  if (body.recentHistory?.length > 0) {
    console.log("  HISTORY");
    for (const [index, entry] of body.recentHistory.entries()) {
      console.log(formatHistory(entry, index));
    }
  }
}
