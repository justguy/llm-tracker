# Executor handoff — Tracks 2 + 4 (worktree `session-hub-t2t4`)

Paste the block below verbatim into a fresh Claude Code session opened in
`/Users/adilevinshtein/Documents/dev/llm-project-tracker`.

---

```
You are the executor for Tracks 2 and 4 of the llm-tracker Session Hub build,
continuing the work from a prior session. Branch v2 in the main repo holds the
shared foundation; YOUR worktree is /Users/adilevinshtein/Documents/dev/session-hub-t2t4
on branch v2-t2t4 (off v2). It already exists — do NOT recreate it. Session A
(Tracks 1+3) works elsewhere; coordinate via the cross-session collision rules
in TASKS §1.5.

ALREADY SHIPPED on v2-t2t4 (read with `git log --oneline v2..HEAD`):
  65beb44  SH-5-07  schema + standalone validator
                    (schema/tracker-task-extensions.schema.json,
                    hub/validator/task-extensions.js, 34 unit tests).
                    Approval-gated change — already approved.
  1063775  SH-5-04  stub-only: hub/jobs/verify-pack.js exports stampVerifyPack.
                    Task stays in_progress; full §11.6.1 composition lands when
                    sh-5-03 (profiles) + sh-3-05 (RunSessionService) are in.
                    Do NOT mark sh-5-04 complete until then.
  2fa0aa6  SH-5-17  follow-up created in-session: wires
                    validateAllTaskExtensions into hub/validator.js
                    validateProject so task.repos/task.verify fail on
                    patch/write. 68/68 validator tests green.

SOURCE OF TRUTH (precedence per docs/session-hub/precedence.md):
  1. PRD:       llm_tracker_session_hub_PRD_v0.5.md
  2. TDD:       llm_tracker_session_hub_TDD_v0.5.md
  3. TASKS:     llm_tracker_session_hub_TASKS_v0.5.md  (your task list)
  4. Addendum:  llm_tracker_session_hub_EXECUTOR_ADDENDUM.md

YOUR SCOPE (Tracks 2 + 4 only):
  Track 2 — SH-3-01..26, SH-8-01..11
    Owns: hub/run-session/**, hub/context-packs/**, ui/run-session/**,
          ui/project-board/*
  Track 4 — SH-5-01..16, SH-6-01..14, SH-7-01..10
    Owns: hub/jobs/**, hub/skills/**, hub/workspaces/**, hub/conflicts/**,
          bin/mcp-server.js, hub/validator/**, schema/**

DO NOT TOUCH (Session A territory): hub/sessions/**, hub/providers/**,
hub/worktrees/**, hub/attention/**, hub/timeline/**, hub/diffs/**,
ui/session-hub/{SessionCard,SessionGroup,TimelinePanel,DiffPanel}.*,
ui/attention/**, ui/triage/**.

CROSS-SESSION COLLISION FILES (split-by-route, do not rewrite):
  hub/runtime/events.js  — when you add event types (JobQueuedEvent,
                            JobUnblockedEvent, VerifyCommandStartedEvent, etc.),
                            commit each addition as its own tiny commit so
                            Session A can rebase cleanly.
  hub/api/sessions.js    — Track 2 owns attach-task/unbind/restart routes
                            (SH-3-20..22, SH-3-26, SH-8-09..11). Track 1 owns
                            attach (SH-2-12) and stdio toggle (SH-2-23).
                            Split by route.

STUB PROTOCOL (TASKS §1.5 hand-offs):
  CONSUME from Session A: SH-2-15 ProviderBroker, SH-2-19 provider event
    normalizer. Use a fake provider with fixed ProviderCapabilities
    (addendum §5) gated behind LT_STUB_PROVIDER=1 until the real broker lands.
  PUBLISH to Session A:  SH-5-04 stub IS ALREADY SHIPPED at
    hub/jobs/verify-pack.js.

APPROVAL GATES — pause and present the change before tracker_patch:
  sh-5-15 (tracker_job_complete_override — bypasses gate enforcement),
  sh-6-13 (MCP mirror of complete_override),
  sh-3-24 (Inline + Add Task — writes durable tracker truth from launcher).
  (sh-5-07 was the fourth; already cleared.)

WORKFLOW PER TASK (memory rule: never cat/jq tracker JSON — use MCP):
  1. tracker_brief to confirm ready + deps satisfied.
  2. tracker_pick to claim atomically (force only when the deps cycle is
     intentional per stub protocol).
  3. Read the TDD §, PRD §, addendum § the brief references.
  4. Implement strictly within allowed_paths. If scope is too tight, ASK the
     user before widening — prior session was scoped this way intentionally.
  5. Run `npm test`; for MCP changes write integration tests against
     bin/mcp-server.js. Note: ~9–14 pre-existing flaky failures on v2 (UI
     tests, daemon-integration). Baseline (no your code): 28 fails / 469
     tests. Validator surface should stay 68/68.
  6. tracker_patch to mark complete with a substantive comment (what shipped,
     test count, deferred items). Triple-check before declaring done — the
     user has explicitly flagged incomplete work as a recurring issue.

KNOWN QUIRKS:
  - tracker_patch responses include long "task X missing from full-write
    incoming" warnings on every call. These are benign — the hub preserves
    unspecified tasks.
  - tracker_pick on approval-gated tasks returns 409 "Decision required"
    until you pass force: true with the user-approved reason captured in the
    comment.
  - hub/validator.js is the chokepoint called 13x from hub/store.js. If a
    task's allowed_paths exclude it, you cannot meet DoD requiring
    patch/write enforcement without either (a) a wire-up follow-up task or
    (b) user-approved scope widen.

NEXT READY TASKS (last seen at rev 129):
  - sh-3-01 (p1, track-2)  RunSessionDraft model + storage —
                           hub/run-session/drafts.js. Clean unit; ~50–100 LOC
                           + tests; in-memory, 30-min expiry, v0.7
                           source+mode shape, taskId required iff
                           mode==task_backed.
  - sh-5-01 (track-4)      JobRecord + JobRegistry — larger; unblocks
                           sh-5-02..15 spine.

START HERE:
  1. cd /Users/adilevinshtein/Documents/dev/session-hub-t2t4
  2. git log --oneline v2..HEAD     # confirm the 3 commits above are present
  3. tracker_next slug=llm-tracker  # see the ranked shortlist
  4. Filter mentally to swimlanes track-2-run-session and track-4-jobs-mcp.
  5. Ask the user which to pick first (sh-3-01 is the obvious P1 next).
```
