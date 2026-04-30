import { readHistory } from "../hub/snapshots.js";
import { targetMetadata } from "../hub/target-metadata.js";
import { getBlockersPayload } from "../hub/blockers.js";
import { getBriefPayload } from "../hub/briefs.js";
import { getChangedPayload } from "../hub/changed.js";
import { getDecisionsPayload } from "../hub/decisions.js";
import { getExecutePayload } from "../hub/execute.js";
import { getHandoffPayload } from "../hub/handoff.js";
import { getHygienePayload, HYGIENE_DEFAULTS } from "../hub/hygiene.js";
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
        const projects = listProjectEntries(workspace).map((entry) => summarizeProject(entry, workspace));
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
        const projects = listProjectEntries(workspace).map((entry) => summarizeProject(entry, workspace));
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
          limit: { type: "integer", minimum: 1, maximum: 5 },
          includeGated: { type: "boolean", description: "Include decision-gated tasks after executable tasks" }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getNextPayload, workspace, nonEmptyString(args.slug), {
          limit: clampInt(args.limit, { fallback: 5, min: 1, max: 5 }),
          includeGated: args.includeGated === true
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
      name: "tracker_hygiene",
      description:
        "Return board hygiene helpers for one project: empty swimlanes (with removable flag), orphaned priorities, stale in_progress tasks, and blocked or decision-gated tasks missing narrative.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          staleAfterRevs: {
            type: "integer",
            minimum: HYGIENE_DEFAULTS.staleAfterRevsMin,
            maximum: HYGIENE_DEFAULTS.staleAfterRevsMax,
            description:
              "How many revs an in_progress task may go untouched before it is reported as stale. Defaults to 10."
          }
        },
        required: ["slug"]
      },
      handler: async (args = {}) =>
        readToolPayload(getHygienePayload, workspace, nonEmptyString(args.slug), {
          staleAfterRevs: clampInt(args.staleAfterRevs, {
            fallback: HYGIENE_DEFAULTS.staleAfterRevs,
            min: HYGIENE_DEFAULTS.staleAfterRevsMin,
            max: HYGIENE_DEFAULTS.staleAfterRevsMax
          })
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
      name: "tracker_handoff",
      description:
        "Return a deterministic handoff pack for one task: brief + why + execution contract + recent decisions + a pre-rendered markdown handoffPrompt for the next agent.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Task id" },
          fromAssignee: { type: "string", description: "Optional outgoing assignee label" },
          toAssignee: { type: "string", description: "Optional incoming assignee label" },
          from: { type: "string", description: "Alias for fromAssignee" },
          to: { type: "string", description: "Alias for toAssignee" }
        },
        required: ["slug", "taskId"]
      },
      handler: async (args = {}) =>
        readToolPayload(getHandoffPayload, workspace, nonEmptyString(args.slug), {
          taskId: nonEmptyString(args.taskId),
          fromAssignee: nonEmptyString(args.fromAssignee ?? args.from),
          toAssignee: nonEmptyString(args.toAssignee ?? args.to)
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
          ...targetMetadata(workspace, slug, loaded.entry),
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
