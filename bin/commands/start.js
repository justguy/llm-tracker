import { ensureHubResponse } from "./shared.js";

export async function cmdStart(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const taskId = args._[2];
  if (!slug || !taskId) {
    console.error(
      "Usage: llm-tracker start <slug> <taskId> --assignee ID [--scratchpad TEXT] [--force] [--json]"
    );
    console.error("       --assignee may be omitted only when LLM_TRACKER_ASSIGNEE is set.");
    process.exit(1);
  }

  const body = { taskId };
  const assignee = args.flags.assignee || process.env.LLM_TRACKER_ASSIGNEE;
  if (assignee) body.assignee = assignee;
  if (args.flags.force) body.force = true;
  if (args.flags.comment !== undefined) body.comment = args.flags.comment;
  if (args.flags.scratchpad !== undefined) body.scratchpad = args.flags.scratchpad;

  const { status, body: response } = await httpRequest(
    workspace,
    args.flags.port,
    "POST",
    `/api/projects/${slug}/start`,
    body
  );
  ensureHubResponse(status, response, "Start");

  if (args.flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(`  ${response.project}  rev ${response.rev ?? "?"}  started ${response.startedTaskId}`);
  console.log(`${response.noop ? "  no changes needed" : "  status=in_progress"}`);
  if (response.task?.title) console.log(`  ${response.task.title}`);

  const extras = [];
  if (response.task?.assignee) extras.push(`assignee=${response.task.assignee}`);
  if (response.task?.effort) extras.push(`effort=${response.task.effort}`);
  if (extras.length > 0) console.log(`  ${extras.join(" · ")}`);
}
