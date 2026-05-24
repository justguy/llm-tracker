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
- if MCP is available, prefer `tracker_help`, `tracker_projects_status`, `tracker_project_status`, `tracker_next`, `tracker_search`, `tracker_fuzzy_search`, `tracker_brief`, `tracker_why`, `tracker_decisions`, `tracker_execute`, `tracker_verify`, `tracker_blockers`, `tracker_changed`, `tracker_history`, `tracker_patch`, `tracker_pick`, `tracker_undo`, `tracker_redo`, and `tracker_reload` over raw `curl`
- if MCP resources are available, prefer `tracker://help` for the contract and `tracker://workspace/runtime` for daemon + patch workflow details before rereading the full README
- if MCP prompts are available, start with `tracker_start_here` and use the workflow prompts instead of inventing your own tool order
- remember the MCP daemon rule: read tools work directly from workspace files; write tools (`tracker_patch`, `tracker_pick`, `tracker_undo`, `tracker_redo`, `tracker_reload`) require the hub or daemon to be reachable
- remind agents to use `/help`, `next`, `search` or `fuzzy-search`, `brief`, `why`, `decisions`, `execute`, `verify`, `blockers`, `changed`, and `pick` before they fall back to broad file reads
- if the human wants direct zero-token terminal shortcuts in Codex or Claude, use `llm-tracker shortcuts`; prompt/skill helpers still spend model tokens
- when adding tasks through patch mode, only append genuinely open work; brand-new patch tasks must start as `not_started` or `in_progress`, not `complete` or `deferred`
- if an idea is already folded into an existing owning row, update that row instead of appending a standalone docs/workflow task and retiring it immediately
- treat bare URLs in `reference` / `references[]` as invalid; use repo-relative `path:line` or `path:line-line`
- if `/search` returns a warning, treat that as a degraded local semantic runtime, not as a tracker-data failure; the hub now tries native semantic, then local WASM semantic, then a bundled offline hash semantic runtime, and only then fuzzy fallback
- if `/search` returns `backend: "semantic_hash_fallback"`, continue with the returned matches; that means the local model runtime is unavailable but the bundled offline semantic fallback is still working
- if `/search` returns `backend: "fuzzy_fallback"`, continue with the returned matches or call `fuzzy-search` explicitly instead of blaming tracker data
- if a slug exists on disk but 404s from the hub, retry once first because the hub auto-reloads missing slugs on demand, then prefer `reload` before asking for a daemon restart
- for metadata backfills on existing projects, prefer bounded active tasks before broad roadmap rows, verify with `next` / `brief` / `execute` / `verify` / `search`, and stop before commit or PR refresh unless the human explicitly asked for that step
- do not call a patch that only adds `references[]`, `effort`, `related`, or `comment` a complete migration batch for active work; that is retrieval-only enrichment unless execution-contract fields were intentionally out of scope
- if the human explicitly asks you to relink a shared symlinked project registration to a different branch/worktree file and the slug is already registered, the safe sequence is: verify target -> `DELETE /api/projects/<slug>` to remove only the workspace symlink registration -> re-link the slug -> `reload` -> verify a read call before writing patches
- for linked shared-workspace projects, `GET /api/projects/<slug>` and successful `POST /api/projects/<slug>/patch` responses include `file`, the effective tracker JSON path the hub writes; use that instead of guessing whether a linked repo file will get dirtied
- for linked shared-workspace projects, high-churn runtime fields (`status`, `assignee`, `blocker_reason`, `meta.scratchpad`, `updatedAt`, `rev`) now live in `<shared-workspace>/.runtime/overlays/<slug>.json`; durable tracker edits still write through to the linked repo-local file
- for linked repo-local trackers, treat the repo JSON as hub-managed durable state, not branch-local scratch state or a merge artifact; do not use `git restore`, `git checkout`, `git stash`, or merge-conflict cleanup as a tracker update mechanism
- before push or merge, prove `.llm-tracker/trackers/hoplon.json` on the branch contains the live tracker truth for the touched tasks; compare `tracker_brief` against the repo file and against `origin/main`; do not restore, stash, or discard tracker diffs; if merging would regress tracker truth, stop and make a tracker-sync commit/PR first
- for active-task backfills, evaluate the whole author-owned field set, not just the obvious subset: `goal`, `references[]`, `related`, `comment`, `context.tags`, `context.notes`, `context.files_touched`, `blocker_reason`, `effort`, `definition_of_done`, `constraints`, `expected_changes`, `allowed_paths`, and `approval_required_for`
- the migration guide's field order is a sequence, not permission to ignore the rest of the author-owned fields when evidence exists
- for linked repo-local trackers such as `<repo>/.llm-tracker/trackers/<slug>.json` or `<repo>/.phalanx/<slug>.json`, keep repo file references portable and relative to the repo root; do not rewrite them into machine-specific absolute paths just to force snippet extraction
- if a valid repo-relative reference is not producing snippets, verify the shared workspace link and use `reload`; treat persistent misses as a resolver/runtime issue to report, not as a reason to bake absolute paths into tracker data
- use `kind: "group"` plus `parent_id` for task tree containment; nested groups are valid, but dependencies remain the only blocker graph
- do not use `dependencies` to express grouping, and do not use `parent_id` to express blocking; if no explicit groups exist, the UI tree view treats swimlanes as the root groups
- treat the dependency graph view as derived UI only: it reads existing `dependencies[]` blocker edges, adds no schema or data fields, and keeps its optional `parent_id` containment overlay visual-only

## Behavioral guidelines to reduce common LLM coding mistakes

Merge these with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it; don't delete it.

When your changes create orphans:

- Remove imports, variables, and functions that your changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
