import { ensureHubResponse, formatTraceability, parseLimit } from "./shared.js";

function formatTask(task, index) {
  const lines = [];
  const actionability = task.actionability || (task.ready ? "executable" : task.blocked_kind || "not_actionable");
  const identity = `  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${actionability}`;
  lines.push(identity);
  lines.push(`     ${task.title}`);

  const extras = [];
  if (task.status) extras.push(`status=${task.status}`);
  if (task.effort) extras.push(`effort=${task.effort}`);
  if (typeof task.lastTouchedRev === "number") extras.push(`lastTouchedRev=${task.lastTouchedRev}`);
  if (extras.length > 0) lines.push(`     ${extras.join(" · ")}`);

  if (task.reason?.length > 0) lines.push(`     why: ${task.reason.join("; ")}`);
  lines.push(...formatTraceability(task.traceability));
  if (task.blocked_by?.length > 0) lines.push(`     blocked by: ${task.blocked_by.join(", ")}`);
  if (task.decision_required?.length > 0) lines.push(`     decision needed: ${task.decision_required.join(", ")}`);
  if (task.not_actionable_reason) lines.push(`     why not actionable: ${task.not_actionable_reason}`);
  if (task.references?.length > 0) lines.push(`     refs: ${task.references.join(" | ")}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);

  return lines.join("\n");
}

export async function cmdNext(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  if (!slug) {
    console.error("Usage: llm-tracker next <slug> [--json] [--limit N] [--include-gated]");
    process.exit(1);
  }

  const limit = parseLimit(args.flags.limit);
  const includeGated = args.flags["include-gated"] === true || args.flags.includeGated === true;
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/next?limit=${limit}${includeGated ? "&includeGated=true" : ""}`
  );

  ensureHubResponse(status, body, "Next");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  if (!body.next || body.next.length === 0) {
    const gated = body.actionabilityCounts?.decision_gated || 0;
    console.log(gated > 0 ? "  no executable tasks; rerun with --include-gated to show decision-gated work" : "  no executable tasks");
    return;
  }
  for (const [index, task] of body.next.entries()) {
    console.log(formatTask(task, index));
  }
}
