export function parseLimit(value, { fallback = 5, min = 1, max = 5 } = {}) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

export function ensureHubResponse(status, body, label) {
  if (status === 0) {
    console.error("Hub not reachable. Start it with 'llm-tracker' or 'llm-tracker --daemon'.");
    process.exit(1);
  }
  if (status >= 400) {
    console.error(`${label} failed (${status}): ${body.error || body.raw}`);
    process.exit(1);
  }
}

function formatQueryMatch(match, index, { includeAssignee = false, includeMatchedOn = false } = {}) {
  const lines = [];
  const readiness = match.actionability || (match.ready ? "executable" : match.blocked_kind || "not_actionable");
  lines.push(
    `  ${index + 1}. ${match.id}  ${match.priorityId || "p?"}  ${match.swimlaneId || "?"}  ${readiness}  score=${match.score.toFixed(3)}`
  );
  lines.push(`     ${match.title}`);

  const extras = [];
  if (match.status) extras.push(`status=${match.status}`);
  if (match.aggregate) extras.push("aggregate=yes");
  if (includeAssignee && match.assignee) extras.push(`assignee=${match.assignee}`);
  if (includeMatchedOn && Array.isArray(match.matchedOn) && match.matchedOn.length > 0) {
    extras.push(`matchedOn=${match.matchedOn.join(",")}`);
  }
  if (extras.length > 0) lines.push(`     ${extras.join(" · ")}`);

  if (match.excerpt) lines.push(`     excerpt: ${match.excerpt}`);
  if (match.blocked_by?.length > 0) lines.push(`     blocked by: ${match.blocked_by.join(", ")}`);
  if (match.decision_required?.length > 0) lines.push(`     decision needed: ${match.decision_required.join(", ")}`);
  if (match.references?.length > 0) lines.push(`     refs: ${match.references.join(" | ")}`);

  return lines.join("\n");
}

export async function runQueryCommand(
  args,
  { resolveWorkspace, httpRequest },
  {
    usage,
    errorLabel,
    heading,
    noMatchesLabel,
    includeAssignee = false,
    includeMatchedOn = false,
    pathFor
  }
) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const query = args._.slice(2).join(" ").trim();
  if (!slug || !query) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }

  const limit = parseLimit(args.flags.limit, { fallback: 10, min: 1, max: 50 });
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    pathFor(slug, query, limit)
  );

  ensureHubResponse(status, body, errorLabel);

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  rev ${body.rev ?? "?"}  ${heading}  generated ${body.generatedAt}`);
  console.log(`  query: ${body.query}`);
  if (body.backend && body.backend !== body.mode) {
    console.log(`  backend: ${body.backend}`);
  }
  if (body.warning) {
    console.log(`  warning: ${body.warning}`);
  }
  if (!body.matches || body.matches.length === 0) {
    console.log(`  no ${noMatchesLabel} matches`);
    return;
  }
  for (const [index, match] of body.matches.entries()) {
    console.log(formatQueryMatch(match, index, { includeAssignee, includeMatchedOn }));
  }
}
