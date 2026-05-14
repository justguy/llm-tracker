---
name: tracker-execute-scope
description: Execute LLM Project Tracker work by bounded scope. Use when asked to start executing a swimlane, execute all open tasks, run the next tasks in a project, coordinate subagents for tracker work, or keep tracker state current during an execution burst.
---

# Tracker Execute Scope

Run a bounded work burst from tracker state to verified task updates. Prefer `tracker_*` MCP tools when available; otherwise use the equivalent `llm-tracker` CLI or HTTP endpoints after reading `/help`.

## Inputs

Resolve these from the user request or project defaults:

- `slug`: project slug. Default to the relevant slug for the current app/project unless the user explicitly names another slug.
- `scope`: `swimlane`, `all-open`, `next`, or explicit task ids.
- `swimlane`: lane id or label when scope is a swimlane.
- `maxTasks`: cap for the burst; default to a small batch if unspecified.
- `assignee`: model or agent id to write into started tasks.
- `parallelism`: optional subagent count.
- `includeDecisionGated`: default false.
- `stopOn`: default to blocker, failed verification, missing approval, or user decision.

## Workflow

1. Read the contract first with `tracker_help` or `tracker://help`.
2. Inspect state with `tracker_project_status`, then use `tracker_next` for executable ranking. Use `includeGated` only when the user explicitly asks to inspect gated work.
3. Resolve the scope without broad tracker-file reads. For a swimlane name, match declared swimlane id or label from status/context. For a fuzzy target, use `tracker_search` or `tracker_fuzzy_search`.
4. For each candidate task:
   - Skip `complete` and `deferred` tasks.
   - Skip blocked tasks unless the current work is to resolve that blocker.
   - Skip `decision_gated` tasks unless `includeDecisionGated` is true and the user authorized that class of work.
   - Call `tracker_brief`; call `tracker_why` if purpose or priority is unclear.
   - Call `tracker_execute` before changing code.
   - Call `tracker_start` when the task is actually starting. Do not pretend the start succeeded if the hub is unavailable.
   - Execute the work, patching small progress notes and `context.files_touched` as useful.
   - Call `tracker_verify` before marking the task complete.
   - Patch `status: "complete"` only when the definition of done and evidence are satisfied.
5. If execution stops, patch a short `blocker_reason` or `meta.scratchpad` note that says exactly what is needed next.

## Subagents

Use subagents only when the client supports them and the user or host has explicitly allowed delegation. Do not delegate the immediate critical-path step if the main agent is blocked on it.

When using subagents:

- Split by independent task or disjoint file ownership.
- Give each subagent one task id, the `tracker_execute` pack, allowed paths, expected changes, and required final evidence.
- Pick reasoning level from risk: low for narrow docs or metadata, medium for normal implementation, high for cross-module behavior or uncertain debugging.
- Tell subagents they are not alone in the codebase, must not revert others' work, and must report changed files plus verification.
- Integrate results locally, then run `tracker_verify` and patch final tracker state yourself.

## Close Criteria

Finish with a concise summary of tasks started, completed, blocked, and left untouched. Include verification commands or evidence. Leave open tasks open with accurate status rather than closing by inference.
