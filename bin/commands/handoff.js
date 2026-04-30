import { ensureHubResponse } from "./shared.js";

export async function cmdHandoff(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const taskId = args._[2];
  if (!slug || !taskId) {
    console.error(
      "Usage: llm-tracker handoff <slug> <taskId> [--from ID] [--to ID] [--json] [--prompt-only]"
    );
    process.exit(1);
  }

  const params = new URLSearchParams();
  if (args.flags.from) params.set("from", String(args.flags.from));
  if (args.flags.to) params.set("to", String(args.flags.to));
  const query = params.toString();
  const path =
    `/api/projects/${slug}/tasks/${taskId}/handoff` + (query ? `?${query}` : "");

  const { status, body } = await httpRequest(workspace, args.flags.port, "GET", path);
  ensureHubResponse(status, body, "Handoff");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (args.flags["prompt-only"] || args.flags.promptOnly) {
    console.log(body.handoffPrompt || "");
    return;
  }

  console.log(`  ${body.project}/${body.taskId}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  if (body.fromAssignee || body.toAssignee) {
    console.log(`  from=${body.fromAssignee || "(unspecified)"}  to=${body.toAssignee || "(next agent)"}`);
  }
  console.log("");
  console.log(body.handoffPrompt || "");
}
