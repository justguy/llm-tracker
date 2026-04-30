import { ensureHubResponse, formatTraceability } from "./shared.js";

function formatTask(task) {
  const lines = [`  ${task.id}  ${task.status}`, `     ${task.title}`];
  lines.push(...formatTraceability(task.traceability));
  return lines.join("\n");
}

function formatCheck(check, index) {
  return `  ${index + 1}. ${check.text}\n     kind: ${check.kind} · status: ${check.status}\n     evidence: ${check.evidenceFrom.join(", ")}`;
}

function formatReference(reference, index) {
  return `  ${index + 1}. ${reference.value}\n     why: ${reference.selectedBecause}`;
}

function formatSnippet(snippet, index) {
  const lines = [];
  lines.push(`  ${index + 1}. ${snippet.reference}`);
  lines.push(`     why: ${snippet.selectedBecause}`);
  if (snippet.error) lines.push(`     error: ${snippet.error}`);
  return lines.join("\n");
}

export async function cmdVerify(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const taskId = args._[2];
  if (!slug || !taskId) {
    console.error("Usage: llm-tracker verify <slug> <taskId> [--json]");
    process.exit(1);
  }

  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/tasks/${taskId}/verify`
  );
  ensureHubResponse(status, body, "Verify");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  task ${body.taskId}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  console.log(formatTask(body.task));

  const evidenceTraceability = formatTraceability(body.evidenceSources?.traceability);
  if (evidenceTraceability.length > 0) {
    console.log("  TRACEABILITY");
    console.log(evidenceTraceability.join("\n"));
  }

  if (body.checks?.length > 0) {
    console.log("  CHECKS");
    for (const [index, check] of body.checks.entries()) {
      console.log(formatCheck(check, index));
    }
  }

  if (body.evidenceSources?.references?.length > 0) {
    console.log("  REFERENCES");
    for (const [index, reference] of body.evidenceSources.references.entries()) {
      console.log(formatReference(reference, index));
    }
  }

  if (body.evidenceSources?.snippets?.length > 0) {
    console.log("  SNIPPETS");
    for (const [index, snippet] of body.evidenceSources.snippets.entries()) {
      console.log(formatSnippet(snippet, index));
    }
  }
}
