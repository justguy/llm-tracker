import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runHubMutation, nonEmptyString, makeTextResult, makeJsonResult } from "./mcp-utils.js";
import { Store, trackerPath } from "../hub/store.js";
import { targetMetadata } from "../hub/target-metadata.js";

function resolveTargetWorkspace(defaultWorkspace, value) {
  return value === undefined ? defaultWorkspace : resolve(nonEmptyString(value) || "");
}

async function runDirectPatch({ workspace, slug, patch, label = "tracker_patch" }) {
  const file = trackerPath(workspace, slug);
  if (!existsSync(file)) {
    return makeJsonResult(
      {
        ok: false,
        status: 404,
        error: `${label} direct mode could not find ${file}. Pass the workspace that owns trackers/${slug}.json, or register/link the project first.`,
        ...targetMetadata(workspace, slug, null)
      },
      { isError: true }
    );
  }

  const store = new Store(workspace);
  const loaded = store.ingest(file, readFileSync(file, "utf-8"));
  if (!loaded?.ok) {
    return makeJsonResult(
      {
        ok: false,
        status: loaded?.status || 400,
        error: `${label} direct mode could not load ${file}: ${loaded?.message || loaded?.reason || "unknown error"}`,
        ...targetMetadata(workspace, slug, null)
      },
      { isError: true }
    );
  }
  const loadWarnings = loaded?.notes?.warnings || [];

  const result = await store.applyPatch(slug, patch);
  if (!result.ok) {
    return makeJsonResult(
      {
        ok: false,
        status: result.status || 400,
        error: result.message,
        type: result.type || null,
        hint: result.hint || null,
        repair: result.repair || null,
        expectedRev: Number.isInteger(result.expectedRev) ? result.expectedRev : null,
        currentRev: Number.isInteger(result.currentRev) ? result.currentRev : null,
        ...targetMetadata(workspace, slug, store.get(slug))
      },
      { isError: true }
    );
  }

  const entry = store.get(slug);
  return makeJsonResult({
    ok: true,
    rev: result.rev ?? entry?.rev ?? null,
    updatedAt: entry?.data?.meta?.updatedAt ?? null,
    ...targetMetadata(workspace, slug, entry),
    workspace,
    mode: "direct",
    notes: {
      ...result.notes,
      warnings: [...loadWarnings, ...(result.notes?.warnings || [])]
    },
    noopReason: result.noopReason || null,
    noop: result.noop === true
  });
}

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
      const targetWorkspace = prepared.workspace || workspace;
      if (prepared.mode === "direct") {
        return runDirectPatch({
          workspace: targetWorkspace,
          slug: prepared.slug,
          patch: prepared.body,
          label: definition.name
        });
      }
      return runHubMutation({
        workspace: targetWorkspace,
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
    description:
      "Submit a normal partial tracker patch. By default this writes through the running hub for the configured workspace. For a versioned repo-local tracker workspace, pass `workspace` and `mode: \"direct\"` to apply the same Store merge/validation/history path without starting another daemon. The hub shallow-merges `task.context` per key: patches add or overwrite keys, they do not delete existing ones. To drop a key, send `context: { key: null }`. Direct file edits flow through the same merge, so removing a key by editing the JSON on disk will be undone on re-ingest — use this tool (with null values) or `PUT /api/projects/<slug>` for a true replace.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Project slug" },
        workspace: {
          type: "string",
          description:
            "Optional tracker workspace path. Use this to target a repo-local `.llm-tracker` workspace instead of the MCP server's configured shared workspace."
        },
        mode: {
          type: "string",
          enum: ["hub", "direct"],
          description:
            "`hub` posts to the running hub. `direct` applies the patch to the target workspace file through Store.applyPatch without requiring a daemon."
        },
        patch: {
          type: "object",
          description:
            "Partial tracker patch body to merge through the hub. Optional top-level `expectedRev` rejects stale writes when it does not match the current project rev. Reopening a complete task as not_started/in_progress requires top-level `statusRegression: { allow: true, reason }`; bulk reopenings also require `migration: true`. `swimlaneOps` supports add/update/move/remove structural lane edits; `taskOps` supports move/archive/split/merge structural task edits. Structural failures may return `repair` with a safe retry shape. `task.context` is shallow-merged; set a key to `null` to delete it.",
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
      const mode = nonEmptyString(args.mode) || "hub";
      if (mode !== "hub" && mode !== "direct") {
        return { error: "tracker_patch mode must be `hub` or `direct`." };
      }
      return {
        slug,
        workspace: resolveTargetWorkspace(this?.workspace, args.workspace),
        mode,
        path: `/api/projects/${slug}/patch`,
        body: args.patch
      };
    }
  };
}

function writeModeProperties() {
  return {
    slug: { type: "string", description: "Project slug" },
    workspace: {
      type: "string",
      description:
        "Optional tracker workspace path. Use this to target a repo-local `.llm-tracker` workspace instead of the MCP server's configured shared workspace."
    },
    mode: {
      type: "string",
      enum: ["hub", "direct"],
      description:
        "`hub` posts to the running hub. `direct` applies the structural patch to the target workspace file without requiring a daemon."
    },
    expectedRev: {
      type: "integer",
      minimum: 0,
      description: "Optional optimistic concurrency guard. Rejects if the current project rev differs."
    }
  };
}

function swimlaneIdFromArgs(args, toolName) {
  const id = nonEmptyString(args.id) || nonEmptyString(args.swimlaneId);
  return id || { error: `${toolName} requires id or swimlaneId.` };
}

function structuralPatch(args, op) {
  const body = { swimlaneOps: [op] };
  if (Number.isInteger(args.expectedRev)) body.expectedRev = args.expectedRev;
  return body;
}

function createSwimlaneToolDefinition() {
  return {
    name: "tracker_create_swimlane",
    description:
      "Create a swimlane through the same structural patch path as swimlaneOps.add. Supports hub and direct modes.",
    inputSchema: {
      type: "object",
      properties: {
        ...writeModeProperties(),
        id: { type: "string", description: "New swimlane id." },
        label: { type: "string", description: "Human-readable swimlane label." },
        description: { type: "string", description: "Optional swimlane description." },
        index: {
          type: "integer",
          minimum: 0,
          description: "Optional insertion index. Defaults to the end."
        }
      },
      required: ["slug", "id", "label"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      if (!slug) return { error: "tracker_create_swimlane requires a project slug." };
      const id = nonEmptyString(args.id);
      if (!id) return { error: "tracker_create_swimlane requires id." };
      const label = nonEmptyString(args.label);
      if (!label) return { error: "tracker_create_swimlane requires label." };
      const lane = { id, label };
      const description = nonEmptyString(args.description);
      if (description) lane.description = description;
      const op = { op: "add", lane };
      if (Number.isInteger(args.index)) op.index = args.index;
      const mode = nonEmptyString(args.mode) || "hub";
      if (mode !== "hub" && mode !== "direct") {
        return { error: "tracker_create_swimlane mode must be `hub` or `direct`." };
      }
      return {
        slug,
        workspace: resolveTargetWorkspace(this?.workspace, args.workspace),
        mode,
        path: `/api/projects/${slug}/patch`,
        body: structuralPatch(args, op)
      };
    }
  };
}

function updateSwimlaneToolDefinition() {
  return {
    name: "tracker_update_swimlane",
    description:
      "Update swimlane metadata through the same structural patch path as swimlaneOps.update. Label and description are agent-owned; collapsed UI state is ignored by the hub.",
    inputSchema: {
      type: "object",
      properties: {
        ...writeModeProperties(),
        id: { type: "string", description: "Swimlane id." },
        swimlaneId: { type: "string", description: "Alias for id." },
        label: { type: "string", description: "New swimlane label." },
        description: { type: "string", description: "New swimlane description." }
      },
      required: ["slug"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      if (!slug) return { error: "tracker_update_swimlane requires a project slug." };
      const id = swimlaneIdFromArgs(args, "tracker_update_swimlane");
      if (typeof id !== "string") return id;
      const patch = {};
      if (args.label !== undefined) {
        const label = nonEmptyString(args.label);
        if (!label) return { error: "tracker_update_swimlane label must be a non-empty string." };
        patch.label = label;
      }
      if (args.description !== undefined) {
        patch.description = String(args.description);
      }
      if (Object.keys(patch).length === 0) {
        return { error: "tracker_update_swimlane requires label or description." };
      }
      const mode = nonEmptyString(args.mode) || "hub";
      if (mode !== "hub" && mode !== "direct") {
        return { error: "tracker_update_swimlane mode must be `hub` or `direct`." };
      }
      return {
        slug,
        workspace: resolveTargetWorkspace(this?.workspace, args.workspace),
        mode,
        path: `/api/projects/${slug}/patch`,
        body: structuralPatch(args, { op: "update", id, patch })
      };
    }
  };
}

function moveSwimlaneToolDefinition() {
  return {
    name: "tracker_move_swimlane",
    description:
      "Move a swimlane by direction or absolute index through the same structural patch path as swimlaneOps.move.",
    inputSchema: {
      type: "object",
      properties: {
        ...writeModeProperties(),
        id: { type: "string", description: "Swimlane id." },
        swimlaneId: { type: "string", description: "Alias for id." },
        direction: { type: "string", enum: ["up", "down"], description: "Move one position up or down." },
        index: { type: "integer", minimum: 0, description: "Absolute target index." }
      },
      required: ["slug"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      if (!slug) return { error: "tracker_move_swimlane requires a project slug." };
      const id = swimlaneIdFromArgs(args, "tracker_move_swimlane");
      if (typeof id !== "string") return id;
      const direction = nonEmptyString(args.direction);
      const hasIndex = Number.isInteger(args.index);
      if (!hasIndex && direction !== "up" && direction !== "down") {
        return { error: "tracker_move_swimlane requires direction up|down or index." };
      }
      const op = { op: "move", id };
      if (hasIndex) op.index = args.index;
      else op.direction = direction;
      const mode = nonEmptyString(args.mode) || "hub";
      if (mode !== "hub" && mode !== "direct") {
        return { error: "tracker_move_swimlane mode must be `hub` or `direct`." };
      }
      return {
        slug,
        workspace: resolveTargetWorkspace(this?.workspace, args.workspace),
        mode,
        path: `/api/projects/${slug}/patch`,
        body: structuralPatch(args, op)
      };
    }
  };
}

function deleteSwimlaneToolDefinition() {
  return {
    name: "tracker_delete_swimlane",
    description:
      "Delete a swimlane through the same structural patch path as swimlaneOps.remove. If tasks are in the lane, provide reassignTo or use the returned repair payload.",
    inputSchema: {
      type: "object",
      properties: {
        ...writeModeProperties(),
        id: { type: "string", description: "Swimlane id." },
        swimlaneId: { type: "string", description: "Alias for id." },
        reassignTo: {
          type: "string",
          description: "Optional destination swimlane id for tasks currently in the deleted lane."
        },
        reassignToSwimlaneId: { type: "string", description: "Alias for reassignTo." }
      },
      required: ["slug"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      if (!slug) return { error: "tracker_delete_swimlane requires a project slug." };
      const id = swimlaneIdFromArgs(args, "tracker_delete_swimlane");
      if (typeof id !== "string") return id;
      const op = { op: "remove", id };
      const reassignTo = nonEmptyString(args.reassignTo) || nonEmptyString(args.reassignToSwimlaneId);
      if (reassignTo) op.reassignTo = reassignTo;
      const mode = nonEmptyString(args.mode) || "hub";
      if (mode !== "hub" && mode !== "direct") {
        return { error: "tracker_delete_swimlane mode must be `hub` or `direct`." };
      }
      return {
        slug,
        workspace: resolveTargetWorkspace(this?.workspace, args.workspace),
        mode,
        path: `/api/projects/${slug}/patch`,
        body: structuralPatch(args, op)
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
        assignee: { type: "string", description: "Assignee id required for the started task" },
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

function createStartToolDefinition() {
  return {
    name: "tracker_start",
    description:
      "Atomically start an explicit task through the running hub: sets status=in_progress, assignee, and optional scratchpad.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Project slug" },
        taskId: { type: "string", description: "Explicit task id to start" },
        assignee: { type: "string", description: "Optional assignee id" },
        force: { type: "boolean", description: "Override blocked or assignee conflicts" },
        comment: { type: "string", description: "Optional task note to write while starting" },
        scratchpad: { type: "string", description: "Optional project scratchpad update" }
      },
      required: ["slug", "taskId", "assignee"]
    },
    prepareRequest(args = {}) {
      const slug = nonEmptyString(args.slug);
      const taskId = nonEmptyString(args.taskId);
      const assignee = nonEmptyString(args.assignee);
      if (!slug) return { error: "tracker_start requires a project slug." };
      if (!taskId) return { error: "tracker_start requires a task id." };
      if (!assignee) return { error: "tracker_start requires an assignee." };

      const body = { taskId, assignee };
      if (args.force === true) body.force = true;
      if (args.comment !== undefined) body.comment = args.comment;
      if (args.scratchpad !== undefined) body.scratchpad = args.scratchpad;

      return {
        path: `/api/projects/${slug}/start`,
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
    createHubWriteTool(workspace, portFlag, createSwimlaneToolDefinition()),
    createHubWriteTool(workspace, portFlag, updateSwimlaneToolDefinition()),
    createHubWriteTool(workspace, portFlag, moveSwimlaneToolDefinition()),
    createHubWriteTool(workspace, portFlag, deleteSwimlaneToolDefinition()),
    createHubWriteTool(workspace, portFlag, createStartToolDefinition()),
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
