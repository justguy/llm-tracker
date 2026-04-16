import { runQueryCommand } from "./shared.js";

export async function cmdSearch(args, { resolveWorkspace, httpRequest }) {
  return runQueryCommand(args, { resolveWorkspace, httpRequest }, {
    usage: "llm-tracker search <slug> <query> [--json] [--limit N]",
    errorLabel: "Search",
    heading: "semantic search",
    noMatchesLabel: "semantic",
    includeAssignee: true,
    pathFor: (slug, query, limit) => `/api/projects/${slug}/search?q=${encodeURIComponent(query)}&limit=${limit}`
  });
}
