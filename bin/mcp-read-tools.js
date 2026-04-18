import { readHistory } from "../hub/snapshots.js";
import { getBlockersPayload } from "../hub/blockers.js";
import { getBriefPayload } from "../hub/briefs.js";
import { getChangedPayload } from "../hub/changed.js";
import { getDecisionsPayload } from "../hub/decisions.js";
import { getExecutePayload } from "../hub/execute.js";
import { getNextPayload } from "../hub/next.js";
import { getVerifyPayload } from "../hub/verify.js";
import { getWhyPayload } from "../hub/why.js";
import { loadReadableEntry, makeJsonResult, nonEmptyString, clampInt, readToolPayload, makeTextResult } from "./mcp-utils.js";
import { projectStatusPayload, summarizeProject } from "./mcp-context-data.js";
import { listProjectEntries, readWorkspaceHelp } from "../hub/project-loader.js";

let searchModulePromise = null;

async function loadSearchModule() {
  if (!searchModulePromise) {
    searchModulePromise = import("../hub/search.js");
  }
  return searchModulePromise;
}

async function getSearchToolPayload(...args) {
  const module = await loadSearchModule();
  return module.getSearchPayload(...args);
}

async function getFuzzySearchToolPayload(...args) {
  const module = await loadSearchModule();
  return module.getFuzzyPayload(...args);
}

export function createReadTools(workspace) {
  return [
    {
      name: "tracker_help",
      description: "Read the workspace agent contract served by /help.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const help = readWorkspaceHelp(workspace);
        if (!help.ok) {
          return makeTextResult(`Workspace help is unavailable at ${help.path}: ${help.message}`, {
            isError: true
          });
        }
        return makeTextResult(help.text);
      }
    },
    {
      name: "tracker_projects",
      description: "List projects available in the configured llm-tracker workspace.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const projects = listProjectEntries(workspace).map(summarizeProject);
        return makeJsonResult({
          workspace,
          projectCount: projects.length,
          projects
        });
      }
    },
    {
      name: "tracker_projects_status",
      description: "Return overall status for all projects in the configured workspace.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const projects = listProjectEntries(workspace).map(summarizeProject);
        return makeJsonResult({
          workspace,
          projectCount: projects.length,
          projects
        });
      }
    },
    {
      name: "tracker_project_status",
      description:
        "Return status for one project: totals, progress, blocked map, swimlane breakdown, and scratchpad.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const loaded = loadReadableEntry(workspace, slug);
        if (!loaded.ok) return loaded.result;
        return makeJsonResult(projectStatusPayload(workspace, loaded.entry));
      }
    },
    {
      name: "tracker_next",
      description: "Return the ranked next-task shortlist for one project.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          limit: { type: "integer", minimum: 1, maximum: 5 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getNextPayload, workspace, nonEmptyString(args.slug), {
          limit: clampInt(args.limit, { fallback: 5, min: 1, max: 5 })
        })
    },
    {
      name: "tracker_search",
      description: "Search tasks semantically with local embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["slug", "query"]
      },
      handler: async (args = {}) =>
        readToolPayload(getSearchToolPayload, workspace, nonEmptyString(args.slug), {
          query: nonEmptyString(args.query),
          limit: clampInt(args.limit, { fallback: 10, min: 1, max: 50 })
        })
    },
    {
      name: "tracker_fuzzy_search",
      description: "Search tasks with deterministic fuzzy lexical matching.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["slug", "query"]
      },
      handler: async (args = {}) =>
        readToolPayload(getFuzzySearchToolPayload, workspace, nonEmptyString(args.slug), {
          query: nonEmptyString(args.query),
          limit: clampInt(args.limit, { fallback: 10, min: 1, max: 50 })
        })
    },
    {
      name: "tracker_brief",
      description: "Return the bounded task brief pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getBriefPayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_why",
      description: "Return the deterministic why pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getWhyPayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_decisions",
      description: "Return recent project decisions derived from task comments.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          limit: { type: "integer", minimum: 1, maximum: 20 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getDecisionsPayload, workspace, nonEmptyString(args.slug), {
          limit: clampInt(args.limit, { fallback: 20, min: 1, max: 20 })
        })
    },
    {
      name: "tracker_execute",
      description: "Return the deterministic execution pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getExecutePayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_verify",
      description: "Return the deterministic verification pack for one task.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getVerifyPayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId)
        })
    },
    {
      name: "tracker_blockers",
      description: "Return blocked tasks and the tasks currently blocking others.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getBlockersPayload, workspace, nonEmptyString(args.slug))
    },
    {
      name: "tracker_changed",
      description: "Return changed tasks since a given revision.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          fromRev: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getChangedPayload, workspace, nonEmptyString(args.slug), {
          fromRev: clampInt(args.fromRev, { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
          limit: clampInt(args.limit, { fallback: 20, min: 1, max: 50 })
        })
    },
    {
      name: "tracker_history",
      description: "Return recent project history entries from the append-only revision log.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          fromRev: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200 }
        },
        required: ["slug"]
      },
      handler: async (args = {}) => {
        const slug = nonEmptyString(args.slug);
        const loaded = loadReadableEntry(workspace, slug);
        if (!loaded.ok) return loaded.result;

        const fromRev = clampInt(args.fromRev, {
          fallback: 0,
          min: 0,
          max: Number.MAX_SAFE_INTEGER
        });
        const limit = clampInt(args.limit, { fallback: 50, min: 1, max: 200 });
        const all = readHistory(workspace, slug).filter((event) => event.rev > fromRev);
        const events = all.slice(-limit);

        return makeJsonResult({
          project: slug,
          currentRev: loaded.entry.rev,
          fromRev,
          events,
          truncation: {
            applied: events.length < all.length,
            returned: events.length,
            totalAvailable: all.length,
            maxCount: limit
          }
        });
      }
    }
  ];
}
