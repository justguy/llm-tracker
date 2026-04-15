import { ensureHubResponse, parseLimit } from "./shared.js";

function formatDecision(decision, index) {
  const lines = [];
  lines.push(`  ${index + 1}. ${decision.id}  ${decision.priorityId || "p?"}  ${decision.swimlaneId || "?"}`);
  lines.push(`     ${decision.title}`);
  lines.push(`     decision: ${decision.comment}`);

  const extras = [];
  if (decision.status) extras.push(`status=${decision.status}`);
  if (decision.effort) extras.push(`effort=${decision.effort}`);
  if (typeof decision.lastDecisionRev === "number") extras.push(`lastDecisionRev=${decision.lastDecisionRev}`);
  if (typeof decision.lastTouchedRev === "number") extras.push(`lastTouchedRev=${decision.lastTouchedRev}`);
  if (extras.length > 0) lines.push(`     ${extras.join(" · ")}`);

  if (decision.references?.length > 0) {
    lines.push(`     refs: ${decision.references.map((reference) => reference.value).join(" | ")}`);
  }

  return lines.join("\n");
}

export async function cmdDecisions(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  if (!slug) {
    console.error("Usage: llm-tracker decisions <slug> [--json] [--limit N]");
    process.exit(1);
  }

  const limit = parseLimit(args.flags.limit, { fallback: 20, min: 1, max: 20 });
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/decisions?limit=${limit}`
  );
  ensureHubResponse(status, body, "Decisions");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  console.log(`  decisions ${body.decisions.length}`);
  for (const [index, decision] of body.decisions.entries()) {
    console.log(formatDecision(decision, index));
  }
  if (body.decisions.length === 0) {
    console.log("  no decisions recorded");
  }
}
