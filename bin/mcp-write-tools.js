import { runHubMutation, nonEmptyString, makeTextResult } from "./mcp-utils.js";

function createHubWriteTool(workspace, portFlag, definition) {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    handler: async (args = {}) => {
      const prepared = await definition.prepareRequest(args);
      if (prepared?.error) {
        return makeTextResult(prepared.error, { isError: true });
      }
      return runHubMutation({
        workspace,
        portFlag,
        method: "POST",
        path: prepared.path,
        label: definition.name,
        body: prepared.body
      });
    }
  };
}

function createPatchToolDefinition() {
  return {
    name: "tracker_patch",
    description: "Submit a normal partial tracker patch through the running hub.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Project slug" },
        patch: {
          type: "object",
          description: "Partial tracker patch body to merge through the hub",
          additionalProperties: true
        }
      },
      required: ["slug", "patch"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      if (!slug) {
        return { error: "tracker_patch requires a project slug." };
      }
      if (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch)) {
        return { error: "tracker_patch requires a JSON object patch." };
      }
      return {
        path: `/api/projects/${slug}/patch`,
        body: args.patch
      };
    }
  };
}

function createPickToolDefinition() {
  return {
    name: "tracker_pick",
    description: "Atomically claim a task through the running hub. Requires the hub to be reachable.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Project slug" },
        taskId: { type: "string", description: "Optional explicit task id" },
        assignee: { type: "string", description: "Optional assignee id" },
        force: { type: "boolean", description: "Override blocked or assignee conflicts" },
        comment: { type: "string", description: "Optional task note to write with the claim" }
      },
      required: ["slug"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      if (!slug) {
        return { error: "tracker_pick requires a project slug." };
      }

      const body = {};
      const taskId = nonEmptyString(args.taskId);
      const assignee = nonEmptyString(args.assignee);
      if (taskId) body.taskId = taskId;
      if (assignee) body.assignee = assignee;
      if (args.force === true) body.force = true;
      if (args.comment !== undefined) body.comment = args.comment;

      return {
        path: `/api/projects/${slug}/pick`,
        body
      };
    }
  };
}

function createSlugWriteTool(name, description, pathSuffix) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Project slug" }
      },
      required: ["slug"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      if (!slug) {
        return { error: `${name} requires a project slug.` };
      }
      return {
        path: pathSuffix(slug)
      };
    }
  };
}

export function createWriteTools(workspace, portFlag) {
  return [
    createHubWriteTool(workspace, portFlag, createPatchToolDefinition()),
    createHubWriteTool(workspace, portFlag, createPickToolDefinition()),
    createHubWriteTool(
      workspace,
      portFlag,
      createSlugWriteTool(
        "tracker_undo",
        "Undo the most recent effective project change through the running hub.",
        (slug) => `/api/projects/${slug}/undo`
      )
    ),
    createHubWriteTool(
      workspace,
      portFlag,
      createSlugWriteTool(
        "tracker_redo",
        "Redo the last undone project change through the running hub.",
        (slug) => `/api/projects/${slug}/redo`
      )
    ),
    createHubWriteTool(
      workspace,
      portFlag,
      {
        name: "tracker_reload",
        description: "Force one project or the full workspace to reload from disk through the running hub.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Optional project slug. If omitted, reload all trackers."
            }
          }
        },
        prepareRequest(args = {}) {
          const slug = nonEmptyString(args.slug);
          return {
            path: slug ? `/api/projects/${slug}/reload` : "/api/reload"
          };
        }
      }
    )
  ];
}
