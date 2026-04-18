import { ensureHubResponse } from "./shared.js";

function formatTask(task) {
  const lines = [];
  const readiness = task.ready ? "ready" : task.blocked_kind || "not_ready";
  lines.push(`  ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${readiness}`);
  lines.push(`     ${task.title}`);
  if (task.goal) lines.push(`     goal: ${task.goal}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);
  if (task.blocking_on?.length > 0) lines.push(`     blocking: ${task.blocking_on.join(", ")}`);
  return lines.join("\n");
}

function formatTaskRef(task, index) {
  return `  ${index + 1}. ${task.id}  ${task.status}\n     ${task.title}`;
}

function formatWhyReason(reason, index) {
  return `  ${index + 1}. ${reason.text}\n     kind: ${reason.kind}`;
}

function formatReference(reference, index) {
  return `  ${index + 1}. ${reference.value}\n     why: ${reference.selectedBecause}`;
}

function formatHistory(entry, index) {
  const lines = [];
  lines.push(`  ${index + 1}. rev ${entry.rev}  ${entry.ts || "?"}`);
  if (entry.changedKeys?.length > 0) lines.push(`     keys: ${entry.changedKeys.join(", ")}`);
  if (entry.summary?.length > 0) {
    const summary = entry.summary
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("; ");
    lines.push(`     summary: ${summary}`);
  }
  return lines.join("\n");
}

export async function cmdWhy(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const taskId = args._[2];
  if (!slug || !taskId) {
    console.error("Usage: llm-tracker why <slug> <taskId> [--json]");
    process.exit(1);
  }

  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/tasks/${taskId}/why`
  );
  ensureHubResponse(status, body, "Why");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  task ${body.taskId}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  console.log(formatTask(body.task));

  if (body.why?.length > 0) {
    console.log("  WHY");
    for (const [index, reason] of body.why.entries()) {
      console.log(formatWhyReason(reason, index));
    }
  }

  if (body.blockedBy?.length > 0) {
    console.log("  BLOCKED BY");
    for (const [index, task] of body.blockedBy.entries()) {
      console.log(formatTaskRef(task, index));
    }
  }

  if (body.unblocks?.length > 0) {
    console.log("  UNBLOCKS");
    for (const [index, task] of body.unblocks.entries()) {
      console.log(formatTaskRef(task, index));
    }
  }

  if (body.references?.length > 0) {
    console.log("  REFERENCES");
    for (const [index, reference] of body.references.entries()) {
      console.log(formatReference(reference, index));
    }
  }

  if (body.recentHistory?.length > 0) {
    console.log("  HISTORY");
    for (const [index, entry] of body.recentHistory.entries()) {
      console.log(formatHistory(entry, index));
    }
  }
}
