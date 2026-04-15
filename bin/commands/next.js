function parseLimit(value) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) return 5;
  return Math.min(parsed, 5);
}

function formatTask(task, index) {
  const lines = [];
  const readiness = task.ready ? "ready" : task.blocked_kind || "not_ready";
  const identity = `  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${readiness}`;
  lines.push(identity);
  lines.push(`     ${task.title}`);

  const extras = [];
  if (task.status) extras.push(`status=${task.status}`);
  if (task.effort) extras.push(`effort=${task.effort}`);
  if (typeof task.lastTouchedRev === "number") extras.push(`lastTouchedRev=${task.lastTouchedRev}`);
  if (extras.length > 0) lines.push(`     ${extras.join(" · ")}`);

  if (task.reason?.length > 0) lines.push(`     why: ${task.reason.join("; ")}`);
  if (task.blocking_on?.length > 0) lines.push(`     blocking: ${task.blocking_on.join(", ")}`);
  if (task.requires_approval?.length > 0) lines.push(`     approval: ${task.requires_approval.join(", ")}`);
  if (task.references?.length > 0) lines.push(`     refs: ${task.references.join(" | ")}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);

  return lines.join("\n");
}

export async function cmdNext(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  if (!slug) {
    console.error("Usage: llm-tracker next <slug> [--json] [--limit N]");
    process.exit(1);
  }

  const limit = parseLimit(args.flags.limit);
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/next?limit=${limit}`
  );

  if (status === 0) {
    console.error("Hub not reachable. Start it with 'llm-tracker' or 'llm-tracker --daemon'.");
    process.exit(1);
  }
  if (status >= 400) {
    console.error(`Next failed (${status}): ${body.error || body.raw}`);
    process.exit(1);
  }

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  if (!body.next || body.next.length === 0) {
    console.log("  no active tasks");
    return;
  }
  for (const [index, task] of body.next.entries()) {
    console.log(formatTask(task, index));
  }
}
