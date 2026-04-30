import { ensureHubResponse, formatTraceability } from "./shared.js";

function formatTask(task) {
  const lines = [];
  const actionability = task.actionability || (task.ready ? "executable" : task.blocked_kind || "not_actionable");
  lines.push(`  ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${actionability}`);
  lines.push(`     ${task.title}`);
  if (task.goal) lines.push(`     goal: ${task.goal}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);
  lines.push(...formatTraceability(task.traceability));
  lines.push(`     Actionability: ${actionability}`);
  if (task.blocked_by?.length > 0) lines.push(`     Blocked By: ${task.blocked_by.join(", ")}`);
  if (task.decision_required?.length > 0) lines.push(`     Decision Needed: ${task.decision_required.join(", ")}`);
  if (task.not_actionable_reason) lines.push(`     Why Not Actionable Now: ${task.not_actionable_reason}`);
  return lines.join("\n");
}

function formatListItem(item, index, prefix = "  ") {
  return `${prefix}${index + 1}. ${item}`;
}

function formatPlanItem(item, index) {
  return `  ${index + 1}. ${item.text}\n     kind: ${item.kind}`;
}

function formatReference(reference, index) {
  return `  ${index + 1}. ${reference.value}\n     why: ${reference.selectedBecause}`;
}

export async function cmdExecute(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const taskId = args._[2];
  if (!slug || !taskId) {
    console.error("Usage: llm-tracker execute <slug> <taskId> [--json]");
    process.exit(1);
  }

  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/tasks/${taskId}/execute`
  );
  ensureHubResponse(status, body, "Execute");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  task ${body.taskId}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  console.log(formatTask(body.task));

  if (body.executionPlan?.length > 0) {
    console.log("  EXECUTION PLAN");
    for (const [index, item] of body.executionPlan.entries()) {
      console.log(formatPlanItem(item, index));
    }
  }

  if (body.executionContract?.definition_of_done?.length > 0) {
    console.log("  DONE WHEN");
    for (const [index, item] of body.executionContract.definition_of_done.entries()) {
      console.log(formatListItem(item, index));
    }
  }

  if (body.executionContract?.constraints?.length > 0) {
    console.log("  CONSTRAINTS");
    for (const [index, item] of body.executionContract.constraints.entries()) {
      console.log(formatListItem(item, index));
    }
  }

  if (body.executionContract?.expected_changes?.length > 0) {
    console.log("  EXPECTED CHANGES");
    for (const [index, item] of body.executionContract.expected_changes.entries()) {
      console.log(formatListItem(item, index));
    }
  }

  if (body.executionContract?.allowed_paths?.length > 0) {
    console.log("  ALLOWED PATHS");
    for (const [index, item] of body.executionContract.allowed_paths.entries()) {
      console.log(formatListItem(item, index));
    }
  }

  if (body.references?.length > 0) {
    console.log("  REFERENCES");
    for (const [index, reference] of body.references.entries()) {
      console.log(formatReference(reference, index));
    }
  }
}
