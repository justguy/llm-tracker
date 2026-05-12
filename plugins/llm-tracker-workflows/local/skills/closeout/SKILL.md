---
name: closeout
description: Sweep LLM Project Tracker state for stale, in-progress, blocked, or nearly complete work. Use when asked to ensure all tasks are updated and closed, clean up a swimlane, close out a work burst, or prepare tracker evidence before commit, push, merge, or handoff.
---

# Closeout Tracker Work

Update tracker truth after work has happened. This skill is evidence-first: close tasks only when tracker verification and real work evidence support closure.

## Inputs

Resolve these from the user request:

- `slug`: project slug.
- `scope`: `project`, `swimlane`, `changed`, `in-progress`, or explicit task ids.
- `swimlane`: lane id or label when applicable.
- `closePolicy`: default `evidence-required`.
- `evidenceMode`: tests, diff, references, review notes, or tracker history.
- `assignee`: optional agent id for status updates.

## Workflow

1. Read the contract with `tracker_help` or `tracker://help`.
2. Load a bounded state view with `tracker_project_status`, `tracker_hygiene`, `tracker_blockers`, and `tracker_changed` when a recent rev is known.
3. Build the sweep list from the requested scope. Avoid full tracker-file reads unless bounded tools cannot answer the question.
4. For each open or stale task:
   - Read `tracker_brief`.
   - Use `tracker_verify` before any completion patch.
   - If the task is done, patch `status: "complete"` with concise evidence in `context` and `context.files_touched` where useful.
   - If it is partly done, leave it open and patch the most accurate status, notes, remaining work, and blocker reason.
   - If it is blocked, patch one concrete `blocker_reason` and do not close it.
5. Re-run `tracker_hygiene` or `tracker_project_status` after material updates to confirm no stale started work remains in scope.

## Rules

- Never mark a task complete only because it looks old, quiet, or likely done.
- Never reopen a `complete` task unless the human explicitly asks or verification proves the previous completion false.
- Keep durable notes short. Put long evidence in repo docs, commits, PR text, or referenced files.
- For linked repo-local trackers, patch tracker state before committing code and include the tracker JSON diff in the same commit.
- If a write is rejected, treat the warning or error as a repair instruction and fix the tracker fields.

## Output

Report:

- Closed tasks and the evidence used.
- Tasks left open and the exact remaining work or blocker.
- Any decision-gated work that needs human input.
- Any tracker writes that failed or could not be attempted.
