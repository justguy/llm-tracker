import { ensureHubResponse } from "./shared.js";

export async function cmdPick(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const taskId = args._[2];
  if (!slug) {
    console.error("Usage: llm-tracker pick <slug> [<taskId>] [--assignee ID] [--force] [--json]");
    process.exit(1);
  }

  const body = {};
  const assignee = args.flags.assignee || process.env.LLM_TRACKER_ASSIGNEE;
  if (taskId) body.taskId = taskId;
  if (assignee) body.assignee = assignee;
  if (args.flags.force) body.force = true;
  if (args.flags.comment !== undefined) body.comment = args.flags.comment;

  const { status, body: response } = await httpRequest(
    workspace,
    args.flags.port,
    "POST",
    `/api/projects/${slug}/pick`,
    body
  );
  ensureHubResponse(status, response, "Pick");

  if (args.flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(`  ${response.project}  rev ${response.rev ?? "?"}  picked ${response.pickedTaskId}`);
  console.log(
    `  ${response.autoSelected ? "auto-selected" : "explicit"}${response.noop ? " · no changes needed" : ""}`
  );
  if (response.selectedBecause) console.log(`  why: ${response.selectedBecause}`);
  if (response.task?.title) console.log(`  ${response.task.title}`);

  const extras = [];
  if (response.task?.status) extras.push(`status=${response.task.status}`);
  if (response.task?.assignee) extras.push(`assignee=${response.task.assignee}`);
  if (response.task?.effort) extras.push(`effort=${response.task.effort}`);
  if (extras.length > 0) console.log(`  ${extras.join(" · ")}`);

  if (response.task?.blocking_on?.length > 0) {
    console.log(`  blocking: ${response.task.blocking_on.join(", ")}`);
  }
  if (response.task?.references?.length > 0) {
    console.log(`  refs: ${response.task.references.join(" | ")}`);
  }
  if (response.task?.comment) {
    console.log(`  note: ${response.task.comment}`);
  }
}
