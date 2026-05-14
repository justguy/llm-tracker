---
name: plan
description: Create or revise LLM Project Tracker tasks with explicit dependencies, definition of done, allowed paths, and approval gates. Use when asked to turn a goal into tasks, create tracker items, articulate dependencies, or show a DoD for review before writing tracker changes.
---

# Plan Tracker Tasks

Convert a goal into reviewable tracker work. Default to review-first planning: show the proposed tasks and definition of done before writing unless the user explicitly asks you to patch immediately.

## Inputs

Resolve these from the user request:

- `slug`: project slug. Default to the relevant slug for the current app/project unless the user explicitly names another slug.
- `goal`: outcome the tasks should accomplish.
- `swimlane`: target lane id or label.
- `priority`: target priority id or label.
- `taskStyle`: flat tasks or grouped tree.
- `allowedPaths`: optional path boundaries.
- `approvalRequiredFor`: decision categories that should gate execution.
- `reviewOnly`: default true.

## Workflow

1. Read the contract with `tracker_help` or `tracker://help`.
2. Inspect existing work with `tracker_project_status`, `tracker_search`, and `tracker_fuzzy_search` to avoid duplicate tasks.
3. Draft the smallest useful task set. Prefer updating an existing owning task over appending a duplicate docs or workflow row.
4. For each proposed task, include:
   - `id`: stable, project-consistent id.
   - `title`: concise action phrase.
   - `goal`: one or two sentences.
   - `status`: `not_started` unless immediate execution is part of this request.
   - `placement`: valid `swimlaneId` and `priorityId`.
   - `dependencies`: only blocker edges. Use `<otherSlug>:<taskId>` for cross-project blockers.
   - `parent_id` and `kind: "group"` only for containment or task trees, not blocking.
   - `definition_of_done`: concrete checks that decide completion.
   - `constraints`, `expected_changes`, `allowed_paths`, and `approval_required_for` when known.
   - `references` only when valid repo-relative `path:line` or `path:line-line` references are known.
5. Check the proposed graph for missing dependencies, cycles, unclear ownership, and tasks with no DoD.
6. Show the proposed task graph and DoD for human review.
7. Patch only after approval or when `reviewOnly` is explicitly false. Use `tracker_patch` for task content and `tracker_create_swimlane` or related lane tools for structural lane changes.

## Planning Rules

- New patch-mode tasks must start as `not_started` or `in_progress`, never `complete` or `deferred`.
- Use `dependencies` for execution blockers and `parent_id` for grouping.
- Do not invent priority or swimlane ids. Resolve labels to declared ids first.
- Do not use bare URLs in `reference` or `references`.
- Put approval-sensitive work behind `approval_required_for` instead of making launch defaults silently change.

## Output Shape

When reviewing with the human, present:

- Task id and title.
- Placement.
- Dependencies and what they block.
- Definition of done.
- Allowed paths and approval gates.
- Whether the plan is ready to patch or needs a decision.
