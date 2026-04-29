import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runHubMutation, nonEmptyString, makeTextResult, makeJsonResult } from "./mcp-utils.js";
import { Store, trackerPath } from "../hub/store.js";

function resolveTargetWorkspace(defaultWorkspace, value) {
  return value === undefined ? defaultWorkspace : resolve(nonEmptyString(value) || "");
}

function projectFilePayload(slug, entry) {
  let file = entry?.path || trackerPath(entry?.workspace || "", slug);
  try {
    file = realpathSync(file);
  } catch {}
  return file;
}

async function runDirectPatch({ workspace, slug, patch }) {
  const file = trackerPath(workspace, slug);
  if (!existsSync(file)) {
    return makeTextResult(
      `tracker_patch direct mode could not find ${file}. Pass the workspace that owns trackers/${slug}.json, or register/link the project first.`,
      { isError: true }
    );
  }

  const store = new Store(workspace);
  const loaded = store.ingest(file, readFileSync(file, "utf-8"));
  if (!loaded?.ok) {
    return makeTextResult(
      `tracker_patch direct mode could not load ${file}: ${loaded?.message || loaded?.reason || "unknown error"}`,
      { isError: true }
    );
  }

  const result = await store.applyPatch(slug, patch);
  if (!result.ok) {
    return makeJsonResult(
      {
        ok: false,
        status: result.status || 400,
        error: result.message,
        type: result.type || null,
        hint: result.hint || null,
        expectedRev: Number.isInteger(result.expectedRev) ? result.expectedRev : null,
        currentRev: Number.isInteger(result.currentRev) ? result.currentRev : null
      },
      { isError: true }
    );
  }

  const entry = store.get(slug);
  return makeJsonResult({
    ok: true,
    rev: result.rev ?? entry?.rev ?? null,
    updatedAt: entry?.data?.meta?.updatedAt ?? null,
    file: projectFilePayload(slug, { ...entry, workspace }),
    workspace,
    mode: "direct",
    notes: result.notes,
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
          patch: prepared.body
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
            "Partial tracker patch body to merge through the hub. Optional top-level `expectedRev` rejects stale writes when it does not match the current project rev. `swimlaneOps` supports add/update/move/remove structural lane edits; `taskOps` supports move/archive/split/merge structural task edits. `task.context` is shallow-merged; set a key to `null` to delete it.",
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
