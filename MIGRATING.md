# Migrating Existing Projects To 0.2.0

This guide covers migration from **`v0.1.1` or any pre-`0.2.0` workspace/tracker setup** to the **`0.2.0` contract and feature set**.

Version boundary in this repo:

- previous release tag: `v0.1.1`
- current release tag: `v0.2.0`

## What Actually Requires Migration

### Code/runtime migration

If you want these capabilities, you need to run `0.2.0` code:

- deterministic `next`
- `blockers`, `changed`, `pick`
- `brief`, `why`, `decisions`, `execute`, `verify`
- MCP tools/resources/prompts
- semantic `/search`
- deterministic `/fuzzy-search`
- background daemon lifecycle
- history, undo, redo

This part requires updating the installed package or running the current checkout, then restarting the daemon on the shared workspace.

### Data migration

Existing tracker files from `0.1.x` continue to work. There is **no required schema rewrite** just to keep using the tracker.

Automatic compatibility in `0.2.0`:

- legacy `reference` still works
- additive `references[]` is supported for new data
- legacy `status: "partial"` is normalized to `in_progress`
- `.runtime/` is created lazily when daemon mode is used
- existing workspaces do not need manual filesystem migration

## Recommended Migration Plan

### Phase 1: Upgrade Runtime

1. Upgrade the code to `0.2.0`.
2. Restart the shared daemon on the same workspace.
3. Verify the live contract:
   - `GET /help`
   - `GET /api/projects`
   - MCP `tracker://help`
4. Verify the new read surfaces are present:
   - `/api/projects/:slug/next`
   - `/api/projects/:slug/search`
   - `/api/projects/:slug/fuzzy-search`

If you are running from a repo checkout:

```bash
node /absolute/path/to/llm-project-tracker/bin/llm-tracker.js daemon restart --path /Users/you/.llm-tracker
```

If you are using MCP from a local checkout, register the stdio server in the client config, do not run it manually in a spare shell:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/llm-project-tracker/bin/llm-tracker.js",
    "mcp",
    "--path",
    "/Users/you/.llm-tracker"
  ]
}
```

### Phase 2: Keep Old Data Working As-Is

Do **not** bulk-rewrite every tracker file just because the new fields exist.

Old projects can keep running with:

- `reference`
- no `references[]`
- no `effort`
- no execution-contract fields

That is valid. The new system will still derive:

- `ready`
- `blocked_kind`
- `blocking_on`
- `requires_approval`
- `lastTouchedRev`

### Phase 3: Backfill Only High-Value Tasks

Backfill metadata only where it creates real value:

- `in_progress` tasks
- `p0` / `p1` tasks
- blocked tasks with weak context
- tasks humans ask about repeatedly

Do **not** start with old completed tasks unless they are still referenced.

## Which Fields To Backfill

### Author-owned fields: safe for LLM migration patches

- `references[]`
- `effort`
- `related`
- `comment`
- `definition_of_done`
- `constraints`
- `expected_changes`
- `allowed_paths`
- `approval_required_for`

### Derived fields: do not write these in migration patches

- `ready`
- `blocked_kind`
- `blocking_on`
- `requires_approval`
- `lastTouchedRev`
- `updatedAt`
- `rev`

## Best Backfill Order

### Pass 1: retrieval quality

Backfill:

- `references[]`
- `comment`
- `related`
- `effort`

This improves:

- `next`
- `brief`
- `why`
- `search`
- `fuzzy-search`

Important:

- a patch that adds only `references[]`, `effort`, `related`, and `comment` is a **retrieval-only** patch
- do **not** call that a complete migration batch for active work
- for bounded active tasks, the first serious migration batch should usually include both retrieval fields and execution-contract fields when they can be grounded

### Pass 2: execution quality

Backfill:

- `definition_of_done`
- `constraints`
- `expected_changes`
- `allowed_paths`
- `approval_required_for`

This improves:

- `execute`
- `verify`

## Existing Project Backfill Playbook

Use this when an existing live project is already linked into a shared workspace and you want to enrich the tracker metadata safely without writing into the wrong checkout.

### Step 1: point the shared workspace at the right file

If the project is linked from a repo checkout and you want writes to land on a branch worktree rather than the main checkout:

1. relink the shared workspace slug to the branch worktree tracker file
2. run `reload <slug>`
3. verify one read call against that slug before writing any patches

Do not assume the daemon will magically follow a different checkout. The shared workspace tracks the linked file path it was given.

### Step 2: backfill bounded active work first

Start with the highest-value executable tasks:

- `in_progress` bounded tasks
- then `p0` / `p1` bounded tasks
- then blocked tasks missing context

Do not start with broad roadmap rows or umbrella program sections unless they are the only available representation of the work.

For each bounded active task in this batch, prefer to fill:

- `references[]`
- `effort`
- `comment`
- `definition_of_done`
- `constraints`
- `expected_changes`
- `allowed_paths`
- `approval_required_for`

If you only fill retrieval fields, treat the batch as **retrieval-only enrichment**, not as a complete migration pass for that task.

### Step 3: backfill broad program rows only where they help

Backfill parent/container rows only when they improve:

- `next` ranking explanations
- `why`
- blocker explanations
- search recall for frequent human questions

Program rows should not dominate the migration queue ahead of bounded active tasks.

### Step 4: defer stale or inactive work

Backfill remaining open but inactive clusters only if they still matter to:

- current ranking
- current blockers
- frequent search questions
- active execution context

Deferred tasks and old completed tasks are not first-pass migration targets unless they are still referenced by active work.

### Step 5: verify, then stop

After each batch, verify representative tasks with:

- `next`
- `brief`
- `execute`
- `verify`
- `search`
- `fuzzy-search`

Stop and report the result after verification. Do **not** commit or refresh a PR unless the human explicitly asked for that step.

## Agent Migration Prompt

Use this with an LLM that already has tracker read access and patch/HTTP write access:

```text
Migrate tracker metadata for project <slug> from the 0.1.x contract to the 0.2.0 contract.

Goal:
- Improve retrieval, ranking, execution, and verification quality for active work.
- Do not rewrite the whole tracker.
- Work in small patches only.

Scope:
- Start with in_progress tasks, then p0/p1 not_started tasks, then blocked tasks that need context.
- Skip completed or low-priority tasks unless they are still referenced by active work.

Write only these author-owned fields when grounded by actual repo/docs/tracker evidence:
- references[]
- effort
- related
- comment
- definition_of_done
- constraints
- expected_changes
- allowed_paths
- approval_required_for

Do not write these derived or hub-owned fields:
- ready
- blocked_kind
- blocking_on
- requires_approval
- lastTouchedRev
- updatedAt
- rev

Rules:
- Prefer references[] over legacy reference for new additions.
- Preserve existing reference if present; do not delete it just to modernize.
- If uncertain, leave the field empty rather than inventing content.
- Use real file paths and real approval categories only when supported by the code/docs/history.
- Keep each patch small: 3-10 tasks max.
- If the project is linked from a branch worktree, verify the shared workspace link and reload the slug before writing.
- Backfill bounded active tasks before broad roadmap/container rows.
- If a patch only adds `references[]`, `effort`, `related`, or `comment`, describe it as retrieval-only enrichment, not as a complete migration batch.
- For bounded active tasks, include `definition_of_done`, `constraints`, `expected_changes`, `allowed_paths`, and `approval_required_for` whenever they can be grounded from actual evidence.
- Verify with next/brief/execute/verify/search after each batch.
- Stop after verification unless the human explicitly asked you to commit or refresh a PR.

Suggested order per task:
1. references[]
2. effort
3. comment
4. definition_of_done
5. constraints
6. expected_changes
7. allowed_paths
8. approval_required_for
```

## Example Patch

```json
{
  "tasks": {
    "t-017": {
      "references": [
        "src/router.js:40-180",
        "docs/parallel-flow.md:10-58"
      ],
      "effort": "m",
      "comment": "Needed before the operator can trust parallel branch routing.",
      "definition_of_done": [
        "parallel route flow works end to end",
        "tests cover branch and variant selection"
      ],
      "constraints": [
        "preserve current public route contract"
      ],
      "expected_changes": [
        "src/router.js",
        "test/router.test.js"
      ],
      "allowed_paths": [
        "src/router.js",
        "test/router.test.js"
      ],
      "approval_required_for": [
        "new dependency"
      ]
    }
  }
}
```

## Operational Checklist

1. Upgrade runtime to `0.2.0`.
2. Restart the shared daemon on the same workspace.
3. Confirm `/help` or `tracker://help` reflects the new contract.
4. Leave existing tracker files alone unless they need high-value metadata.
5. Backfill active tasks first.
6. If the project is linked from a repo worktree, relink the shared workspace slug to the intended branch file and run `reload <slug>`.
7. Review with:
   - `next`
   - `changed`
   - `brief`
   - `execute`
   - `verify`
   - `search`
   - `fuzzy-search`
8. Expand backfill only if the new fields materially improve active work.
9. Stop before commit/PR refresh unless the human asked for it.
