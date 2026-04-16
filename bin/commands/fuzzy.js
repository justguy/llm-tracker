import { runQueryCommand } from "./shared.js";

export async function cmdFuzzy(args, { resolveWorkspace, httpRequest }) {
  return runQueryCommand(args, { resolveWorkspace, httpRequest }, {
    usage: "llm-tracker fuzzy|fuzzy-search <slug> <query> [--json] [--limit N]",
    errorLabel: "Fuzzy",
    heading: "fuzzy search",
    noMatchesLabel: "fuzzy",
    includeMatchedOn: true,
    pathFor: (slug, query, limit) => `/api/projects/${slug}/fuzzy-search?q=${encodeURIComponent(query)}&limit=${limit}`
  });
}
