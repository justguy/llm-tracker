import { ensureHubResponse } from "./shared.js";

function formatBlockedTask(task, index) {
  const lines = [];
  lines.push(`  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  blocked`);
  lines.push(`     ${task.title}`);
  lines.push(`     blocking: ${task.blocking_on.join(", ")}`);
  if (task.blocking_task_details?.length > 0) {
    lines.push(
      `     blocked by: ${task.blocking_task_details.map((dep) => `${dep.id} (${dep.status})`).join("; ")}`
    );
  }
  if (task.blocker_reason) lines.push(`     blocker: ${task.blocker_reason}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);
  if (task.references?.length > 0) lines.push(`     refs: ${task.references.join(" | ")}`);
  return lines.join("\n");
}

function formatBlockingTask(task, index) {
  const lines = [];
  lines.push(
    `  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  blocks ${task.blockedCount}`
  );
  lines.push(`     ${task.title}`);
  if (task.blocks?.length > 0) {
    lines.push(`     blocks: ${task.blocks.map((blocked) => blocked.id).join(", ")}`);
  }
  if (task.status) lines.push(`     status=${task.status}`);
  return lines.join("\n");
}

export async function cmdBlockers(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  if (!slug) {
    console.error("Usage: llm-tracker blockers <slug> [--json]");
    process.exit(1);
  }

  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/blockers`
  );
  ensureHubResponse(status, body, "Blockers");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  console.log(`  blocked ${body.blocked.length}  ·  blocking ${body.blocking.length}`);

  if (body.blocked.length > 0) {
    console.log("  BLOCKED");
    for (const [index, task] of body.blocked.entries()) {
      console.log(formatBlockedTask(task, index));
    }
  }

  if (body.blocking.length > 0) {
    console.log("  BLOCKING");
    for (const [index, task] of body.blocking.entries()) {
      console.log(formatBlockingTask(task, index));
    }
  }

  if (body.blocked.length === 0 && body.blocking.length === 0) {
    console.log("  no structural blockers");
  }
}
