import { ensureHubResponse, parseLimit } from "./shared.js";

function formatChangedTask(task, index) {
  const lines = [];
  const state = task.removed ? "removed" : task.ready ? "ready" : task.blocked_kind || "changed";
  lines.push(`  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${state}`);
  if (task.title) lines.push(`     ${task.title}`);
  lines.push(`     revs: ${task.changedInRevs.join(", ")}`);
  if (task.changeKinds?.length > 0) lines.push(`     kinds: ${task.changeKinds.join(", ")}`);
  if (task.changedKeys?.length > 0) lines.push(`     keys: ${task.changedKeys.join(", ")}`);
  if (task.comment) lines.push(`     note: ${task.comment}`);
  if (task.references?.length > 0) lines.push(`     refs: ${task.references.join(" | ")}`);
  return lines.join("\n");
}

export async function cmdChanged(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const fromRev = parseInt(args._[2] ?? "0", 10);
  if (!slug || isNaN(fromRev) || fromRev < 0) {
    console.error("Usage: llm-tracker changed <slug> [<fromRev>] [--json] [--limit N]");
    process.exit(1);
  }

  const limit = parseLimit(args.flags.limit, { fallback: 20, max: 50 });
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/changed?fromRev=${fromRev}&limit=${limit}`
  );
  ensureHubResponse(status, body, "Changed");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(
    `  ${body.project}  rev ${body.rev ?? "?"}  changed since rev ${body.fromRev}  generated ${body.generatedAt}`
  );
  if (body.metaChanges?.length > 0) {
    console.log(`  meta: ${body.metaChanges.map((change) => `${change.key}@${change.lastChangedRev}`).join(", ")}`);
  }
  if (body.orderChangedRevs?.length > 0) {
    console.log(`  order changed at revs: ${body.orderChangedRevs.join(", ")}`);
  }
  if (!body.changed || body.changed.length === 0) {
    console.log("  no changes in range");
    return;
  }
  for (const [index, task] of body.changed.entries()) {
    console.log(formatChangedTask(task, index));
  }
}
