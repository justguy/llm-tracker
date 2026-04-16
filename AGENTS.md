# AGENTS.md

When you are working against a running `llm-tracker` hub, fetch `GET /help` first.

Why:

- `/help` is the current agent contract for that workspace.
- It serves the workspace `README.md`, which is copied from [`workspace-template/README.md`](./workspace-template/README.md).
- It is the endpoint LLMs should use instead of guessing paths, write modes, or status vocabulary.

If you change any agent-facing behavior, keep these in sync:

- `workspace-template/README.md` because `/help` serves it
- `README.md` for human-facing usage and reminders
- `AGENTS.md` when the repo-level workflow changes
- the MCP layer (`llm-tracker mcp`) when the HTTP/CLI contract changes, including tools, resources, and prompts

For this repo specifically:

- keep `/help` accurate when you add or change agent-facing endpoints or commands
- prefer additive updates to the contract rather than silent behavior changes
- if MCP is available, prefer `tracker_help`, `tracker_projects_status`, `tracker_project_status`, `tracker_next`, `tracker_search`, `tracker_fuzzy_search`, `tracker_brief`, `tracker_why`, `tracker_decisions`, `tracker_execute`, `tracker_verify`, `tracker_blockers`, `tracker_changed`, `tracker_history`, `tracker_pick`, `tracker_undo`, `tracker_redo`, and `tracker_reload` over raw `curl`
- if MCP resources are available, prefer `tracker://help` for the contract and `tracker://workspace/runtime` for daemon + patch workflow details before rereading the full README
- if MCP prompts are available, start with `tracker_start_here` and use the workflow prompts instead of inventing your own tool order
- remember the MCP daemon rule: read tools work directly from workspace files; write tools (`tracker_pick`, `tracker_undo`, `tracker_redo`, `tracker_reload`) require the hub or daemon to be reachable
- remind agents to use `/help`, `next`, `search` or `fuzzy-search`, `brief`, `why`, `decisions`, `execute`, `verify`, `blockers`, `changed`, and `pick` before they fall back to broad file reads
- if a slug exists on disk but 404s from the hub, retry once first because the hub auto-reloads missing slugs on demand, then prefer `reload` before asking for a daemon restart
- for metadata backfills on existing projects, prefer bounded active tasks before broad roadmap rows, verify with `next` / `brief` / `execute` / `verify` / `search`, and stop before commit or PR refresh unless the human explicitly asked for that step
