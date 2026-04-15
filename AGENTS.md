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

For this repo specifically:

- keep `/help` accurate when you add or change agent-facing endpoints or commands
- prefer additive updates to the contract rather than silent behavior changes
- remind agents to use `/help`, `next`, `brief`, `blockers`, `changed`, and `pick` before they fall back to broad file reads
