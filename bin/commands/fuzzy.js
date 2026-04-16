import { ensureHubResponse, parseLimit } from "./shared.js";

function formatMatch(match, index) {
  const lines = [];
  const readiness = match.ready ? "ready" : match.blocked_kind || "not_ready";
  lines.push(
    `  ${index + 1}. ${match.id}  ${match.priorityId || "p?"}  ${match.swimlaneId || "?"}  ${readiness}  score=${match.score.toFixed(3)}`
  );
  lines.push(`     ${match.title}`);

  const extras = [];
  if (match.status) extras.push(`status=${match.status}`);
  if (match.aggregate) extras.push("aggregate=yes");
  if (Array.isArray(match.matchedOn) && match.matchedOn.length > 0) {
    extras.push(`matchedOn=${match.matchedOn.join(",")}`);
  }
  if (extras.length > 0) lines.push(`     ${extras.join(" · ")}`);

  if (match.excerpt) lines.push(`     excerpt: ${match.excerpt}`);
  if (match.references?.length > 0) lines.push(`     refs: ${match.references.join(" | ")}`);

  return lines.join("\n");
}

export async function cmdFuzzy(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const query = args._.slice(2).join(" ").trim();
  if (!slug || !query) {
    console.error("Usage: llm-tracker fuzzy|fuzzy-search <slug> <query> [--json] [--limit N]");
    process.exit(1);
  }

  const limit = parseLimit(args.flags.limit, { fallback: 10, min: 1, max: 50 });
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/fuzzy-search?q=${encodeURIComponent(query)}&limit=${limit}`
  );

  ensureHubResponse(status, body, "Fuzzy");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  rev ${body.rev ?? "?"}  fuzzy search  generated ${body.generatedAt}`);
  console.log(`  query: ${body.query}`);
  if (!body.matches || body.matches.length === 0) {
    console.log("  no fuzzy matches");
    return;
  }
  for (const [index, match] of body.matches.entries()) {
    console.log(formatMatch(match, index));
  }
}
