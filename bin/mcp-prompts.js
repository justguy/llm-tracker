import { join } from "node:path";
import { makePrompt, WRITE_TOOL_NAMES } from "./mcp-context-data.js";

export function listPrompts() {
  return [
    {
      name: "tracker_start_here",
      description: "Load the workspace contract, daemon rule, and patch workflow before acting.",
      arguments: []
    },
    {
      name: "tracker_pick_next",
      description: "Find the next task for a project, then claim it safely.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        }
      ]
    },
    {
      name: "tracker_task_context",
      description: "Load the bounded context for one task without rereading the whole tracker.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        },
        {
          name: "taskId",
          description: "Task id",
          required: true
        }
      ]
    },
    {
      name: "tracker_search_project",
      description: "Search a project when the question is fuzzy or feature-oriented instead of task-id-oriented.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        },
        {
          name: "query",
          description: "Feature or concept to search for",
          required: true
        }
      ]
    },
    {
      name: "tracker_execute_task",
      description: "Prepare an execution pass for one task with the deterministic pack.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        },
        {
          name: "taskId",
          description: "Task id",
          required: true
        }
      ]
    },
    {
      name: "tracker_verify_task",
      description: "Prepare a verification pass for one task with explicit evidence sources.",
      arguments: [
        {
          name: "slug",
          description: "Project slug",
          required: true
        },
        {
          name: "taskId",
          description: "Task id",
          required: true
        }
      ]
    },
    {
      name: "tracker_patch_write",
      description: "Explain the file-based patch workflow when the hub is unavailable.",
      arguments: [
        {
          name: "slug",
          description: "Optional project slug for the example patch filename",
          required: false
        }
      ]
    }
  ];
}

export function getPrompt(workspace, name, args = {}) {
  const slug = typeof args.slug === "string" && args.slug.trim() ? args.slug.trim() : "<slug>";
  const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : "<taskId>";
  const patchExample = join(workspace, "patches", `${slug}.<timestamp>.json`);

  switch (name) {
    case "tracker_start_here":
      return makePrompt(
        "Load the workspace contract and operating rules before touching project state.",
        [
          "Start with the workspace contract before acting.",
          "1. Read resource `tracker://help` or call `tracker_help`.",
          "2. Read resource `tracker://workspace/runtime` for daemon state, patch directory, and MCP write rules.",
          `3. MCP read tools do not require the daemon. MCP write tools ${WRITE_TOOL_NAMES.map((tool) => `\`${tool}\``).join(", ")} do require the hub or daemon.`,
          `4. If the hub is unavailable, file-mode patches go in \`${join(workspace, "patches")}\` as \`${patchExample}\`. Rejections create a sibling \`.errors.json\` file.`,
          "5. Structural board edits belong in `swimlaneOps` and `taskOps`; stale writes can use `expectedRev`, and structural failures may return `repair` with a retry shape.",
          "6. Preferred agent flow: `tracker_projects_status` or `tracker_project_status`, then `tracker_next`, then `tracker_brief` or `tracker_why`, then `tracker_execute`, then `tracker_start` for an explicit task start or `tracker_pick` for top-task claim, then `tracker_patch`, and finally `tracker_verify`."
        ].join("\n")
      );
    case "tracker_pick_next":
      return makePrompt(
        `Find the next task for ${slug} and claim it only if a write path is available.`,
        [
          `Use \`tracker_project_status\` for \`${slug}\` if you need a quick progress snapshot.`,
          `Call \`tracker_next\` with \`${slug}\` to get the ranked shortlist.`,
          "Inspect the top recommendation and alternatives before choosing work.",
          `If the task should be explicitly started and the hub is reachable, call \`tracker_start\` for \`${slug}\`; use \`tracker_pick\` only when you want the hub to choose the top ready task.`,
          `If the hub is not reachable, do not pretend the claim succeeded. Use a patch file in \`${patchExample}\` instead.`
        ].join("\n")
      );
    case "tracker_task_context":
      return makePrompt(
        `Load bounded task context for ${slug}/${taskId}.`,
        [
          `Call \`tracker_brief\` with slug \`${slug}\` and task id \`${taskId}\`.`,
          `If rationale is unclear, call \`tracker_why\` for \`${slug}\` / \`${taskId}\`.`,
          `If you need recent changes or decision trail, call \`tracker_history\` or \`tracker_changed\` for \`${slug}\`.`,
          "Avoid rereading the whole tracker unless the bounded packs are insufficient."
        ].join("\n")
      );
    case "tracker_search_project": {
      const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : "<query>";
      return makePrompt(
        `Search ${slug} for feature-oriented or fuzzy questions like "${query}".`,
        [
          `Start with \`tracker_search\` for \`${slug}\` and query \`${query}\` when you want semantic search over task meaning and nearby concepts.`,
          `If you want deterministic lexical matching instead, call \`tracker_fuzzy_search\` for \`${slug}\` and \`${query}\`.`,
          "Use the returned matches to choose a task id, then follow up with `tracker_brief` or `tracker_why` instead of rereading the whole tracker."
        ].join("\n")
      );
    }
    case "tracker_execute_task":
      return makePrompt(
        `Prepare to execute ${slug}/${taskId} with deterministic guardrails.`,
        [
          `Call \`tracker_execute\` with slug \`${slug}\` and task id \`${taskId}\`.`,
          `If you have not started the task yet and the hub is reachable, use \`tracker_start\` first.`,
          "Use the execution pack's readiness, constraints, expected changes, and references to plan edits.",
          `After editing, use \`tracker_verify\` for \`${slug}\` / \`${taskId}\` and \`tracker_changed\` to confirm the resulting tracker state.`
        ].join("\n")
      );
    case "tracker_verify_task":
      return makePrompt(
        `Verify completion of ${slug}/${taskId} using tracker evidence.`,
        [
          `Call \`tracker_verify\` with slug \`${slug}\` and task id \`${taskId}\`.`,
          `Use \`tracker_history\` and \`tracker_changed\` for \`${slug}\` if you need revision-backed confirmation.`,
          "If verification fails, explain the missing evidence or unmet checks explicitly instead of marking the task complete."
        ].join("\n")
      );
    case "tracker_patch_write":
      return makePrompt(
        "Use the file-based patch workflow when the hub is unavailable.",
        [
          "If the hub is reachable, prefer `tracker_patch` so hub locking, revisioning, and broadcasts stay authoritative.",
          `Patch files belong in \`${join(workspace, "patches")}\`.`,
          `Use a filename like \`${patchExample}\`.`,
          "Use `swimlaneOps` for lane add/update/move/remove and `taskOps` for task move/archive/split/merge instead of full tracker rewrites.",
          "Include top-level `expectedRev` when guarding against stale context; if structural validation returns `repair`, retry with the provided operation shape.",
          "Patch mode is the fallback for when the hub is unavailable; MCP write tools remain hub-backed.",
          "If a patch is rejected, inspect the sibling `.errors.json` file for the structured validation error.",
          "Once the hub is reachable again, prefer `tracker_patch` or HTTP writes so locking, revisioning, and broadcasts stay authoritative."
        ].join("\n")
      );
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
