# Product Requirements Document: llm-tracker Session Hub

**Product:** llm-tracker Session Hub  
**Status:** Draft v0.4 — operator-capable personal build  
**Owner:** justguy / llm-tracker  
**Primary user:** a developer/operator running many local coding-agent sessions across multiple projects  
**Scope:** tracker-native active session tracking, task/session orchestration, attention routing, triage, job/skill guidance, stdio display, and Codex app-server control where available  
**Core principle:** simple, visible, local-first control plane; no hidden heuristics pretending to understand terminals

---

## 1. Executive summary

`llm-tracker` already provides durable project and task truth: projects, tasks, priorities, dependencies, `next`, `brief`, `why`, `execute`, `verify`, `handoff`, patching, snapshots, history, CLI, MCP, and a calm board UI. Session Hub adds the missing runtime layer: **active agent sessions as first-class objects**.

The user problem is not that coding agents lack another chat UI. The real problem is situational awareness and coordination when 5-15 agent sessions are open at once. The user needs to know:

- which session is doing what;
- which task, project, branch, repo, or worktree each session belongs to;
- which sessions are active, quiet (no recent output or heartbeat), blocked, waiting on the user, or done;
- which session needs approval or human input, when that is known from a structured source;
- which sessions are touching the same files or repo;
- what context should move from one session to another;
- when a long session should roll over into a clean successor session;
- which workflow skills should run before, during, or after a job.

Session Hub turns `llm-tracker` into a **local command center for active agent work** while keeping the existing tracker JSON as durable truth. Runtime session state lives separately under `.runtime` and can be rebuilt, cleared, or ignored without corrupting project state.

This version is optimized for the primary user's real workflow, not for a smallest public shipping MVP. The goal is an **operator-capable personal system** that removes the CLI as the bottleneck: one place to start, attach, control, triage, roll over, verify, and close out many agent sessions across many projects.

---

## 2. Product thesis

> **The tracker owns durable work. Sessions own runtime execution. Jobs connect a task to a session. Skills guide the job lifecycle. Attention routes the human.**

The product should feel like a simple, powerful workspace, not an IDE replacement and not a complicated PMO system. The main experience is:

1. Open `llm-tracker`.
2. See every active session across every project in one glance.
3. Start work from the tracker, usually from a task card: `[+ RUN SESSION]`.
4. The tracker creates a job, generates the right context pack, stamps a verify pack, suggests/records required skills, and launches or attaches a runtime session.
5. The user controls the session from visible tools: stdio/chat, checkpoint, stop/resume, rollover, review, verify, closeout, and archive.
6. Normal running sessions stay ambient. Only sessions that need the operator appear in the Attention strip or Triage view.
7. If a session gets too long, quiet, blocked, conflicted, or done, the hub shows exactly why it needs attention and what action is recommended.

The intended wedge is not another agent chat UI. It is a tracker-native operating layer for agent work:

```text
task/project truth
+ active session control
+ attention inbox
+ job/skill lifecycle
+ deterministic context movement
+ repo/worktree awareness
+ one-click operator actions
```

## 3. Non-negotiable design decisions

### 3.1 Raw stdio is display-only

Raw stdout/stderr is never parsed semantically to infer approvals, commands, task progress, MCP calls, skill execution, or completion.

A basic process-wrapper session is a **dumb terminal**. It can show raw output, last-output time, process PID, exit code, and stdin controls. It cannot reliably show `waiting_for_approval` unless a structured source reports that state.

Structured states may come only from:

- Codex app-server events;
- explicit MCP calls such as `tracker_session_status` or `tracker_job_checkpoint`;
- HTTP session/job events;
- human manual state changes in the UI.

### 3.2 Runtime writes are serialized

Runtime session state must not be maintained by concurrent read/merge/write updates to `.runtime/sessions.json`. The hub owns runtime writes through a serialized `RuntimeStore` event queue.

Authoritative runtime data is append-only JSONL plus an in-memory projection. Snapshot JSON files are derived caches only.

### 3.3 Rollover context is deterministic

Rollover must not depend on a degraded LLM summarizing its own long context window. A dying session may submit a final handoff as an **advisory claim**, but the successor context pack is generated from durable evidence:

- tracker `brief`, `why`, `execute`, `verify`, `handoff`, `changed`, `history`, `since`;
- tracker snapshots/history;
- runtime job/session/skill events;
- git status/diff/log;
- repo watcher events;
- optional human edits.

### 3.4 File conflict detection is watcher/git-derived

Agent-reported touched files are hints, not evidence. Conflict warnings must use project watchers, git/worktree state, and task/repo metadata. If multiple sessions share the same worktree, file attribution is ambiguous and the UI must say so plainly.

### 3.5 UI stays simple

The UI should be direct and low-click:

- tools visible on cards and in a compact tool shelf;
- task/session drawers inline, not deep navigation;
- drag/drop for task assignment and session grouping;
- move/resize session cards without opening settings;
- keyboard palette for everything else;
- no hidden automation.

---

## 4. Goals

### 4.1 Primary goals

1. **Tracker-native Run Session funnel**  
   Starting work should usually begin from a task card, swimlane, or Hub run action. Every entry point enters one Run Session funnel that creates the same task-backed job/session/runtime objects.

2. **Global session awareness**  
   Show all active sessions across projects, grouped and filtered by project, urgency, repo/worktree, provider, or custom group.

3. **Attention routing**  
   Normal running sessions are ambient. The UI pulls attention only when there is a concrete operator action to take: approval, blocker, conflict, not responding, quiet terminal, context high, verify missing, or closeout needed.

4. **Task/session binding**  
   Assign a tracker task to a session, move it between sessions, or start a new session from the task.

5. **Job lifecycle orchestration**  
   A job represents one active execution of a task inside a session. Jobs carry skill plans, progress, status, source-labeled evidence, and lifecycle hooks.

6. **Skill-guided workflows**  
   Attach workflow skills to job hooks: before start, checkpoint, before complete, after complete, rollover, resume.

7. **Simple session UI**  
   Provide session cards, project session strips, triage lanes, and a persistent Attention strip with one-click tools.

8. **Raw stdio and structured chat**  
   Show raw stdio for wrapper-launched sessions. Provide chat-like app-server interaction for Codex app-server sessions.

9. **Safe stop/resume/reload**  
   Stop and resume a session to reload MCP/config/CLI version while preserving task binding and changed-since context.

10. **Deterministic rollover**  
    Create a linked successor session without trusting the old model's memory.

11. **Cross-session collaboration**  
    Enable handoffs, broadcasts, asks, verifier jobs, and project/task knowledge sharing.

12. **Preserve local-first simplicity**  
    No required cloud service, PMO graph backend, or database.

### 4.2 Non-goals for this version

- Hosted SaaS.
- Required Neo4j/PMO backend.
- Hoplon-specific integration.
- Semantic parsing of arbitrary terminal output.
- Fully autonomous multi-project scheduler without human confirmation.
- Policy engine that physically prevents local file writes.
- Hiding useful controls just because a session has a lower capability tier. Low-capability sessions should expose the nearest manual, clipboard, or MCP-contract alternative.

## 5. Personas

### 5.1 Human operator

Runs many LLM coding sessions locally. Wants one place to see what is happening, what needs attention, and which tasks are safe to start next.

Needs:

- glanceable session cards;
- warnings for quiet/stale/blocked/waiting sessions;
- raw stdio without switching terminal panes;
- task context and tools without hunting;
- ability to group, move, resize, and arrange sessions;
- stop/resume/rollover controls;
- deterministic handoffs and successor prompts.

### 5.2 Coding session

A Codex/app-server session, Codex CLI session, Claude session, or other local agent.

Needs:

- a bounded context pack;
- current task, DoD, dependencies, and verification instructions;
- explicit MCP/HTTP tools to report heartbeat, status, blockers, handoff, skill runs, and completion;
- a stable rule: use tracker tools instead of rereading the whole project.

### 5.3 Reviewer/verifier session

Reviews or verifies another session’s work.

Needs:

- task brief and DoD;
- changed-since context;
- git diff and watcher evidence;
- previous session handoff, clearly labeled as claim/advisory;
- verify pack and completion gates.

---

## 6. Core concepts

### 6.1 Project

Existing tracker project, identified by `meta.slug`.

### 6.2 Task

Existing tracker task. Durable. Contains status, priority, swimlane, dependencies, DoD, context, references, and execution/verification data.

### 6.3 Session

A runtime execution context for an agent process/thread/conversation.

A session may be:

- **dumb terminal:** launched or attached as a raw process, with stdio display only;
- **MCP-tracked:** any agent that explicitly calls tracker MCP/HTTP session tools;
- **Codex app-server:** structured Codex control and events;
- **hybrid:** app-server structured events plus raw stdio display;
- **manual:** human-attached/advisory only — no process, no adapter, no stdio capture, no structured events. State changes come exclusively from explicit human edits in the UI/CLI. Useful when an agent runs in a tool the hub cannot see (a remote IDE, a teammate's machine, a paper notebook) but the operator still wants the job/task to appear on the board.

### 6.4 Job

One active execution of a task inside a session.

A job answers: “Session `S` is doing task `T` as a `code-implementer`, `prd-writer`, `reviewer`, etc.”

Jobs own:

- selected profile;
- skill plan;
- lifecycle state;
- start revision;
- deterministic context packs;
- required completion gates.

### 6.5 Skill

A reusable workflow step or prompt, such as:

- `lt.execute_scope` / `$lt:execute`;
- `lt.closeout_sweep` / `$lt:closeout`;
- `lt.task_planner` / `$lt:plan`;
- `lt.verify`;
- `prd.intake`;
- `review.changed_since`.

Skills may be invoked through Codex skills, MCP prompt tools, HTTP actions, generated prompt text, or human/manual confirmation. A skill is considered verified only if a structured event or human override records it.

### 6.6 Context pack

A generated prompt/context bundle for start, resume, rollover, handoff, review, or verification.

### 6.7 Run Session draft

A short-lived launch/preflight object created by any Run Session entry point. It captures:

- entry point: task card, swimlane header, Hub, CLI, or attach flow;
- selected or recommended task;
- profile;
- runtime adapter;
- repo/worktree binding;
- context pack preview;
- skill plan preview;
- verify pack preview;
- launch warnings such as existing active job, missing repo metadata, or shared worktree.

All start-session entry points create the same draft and end in the same launch path.

### 6.8 Attention item

A runtime-derived item that says the human should look now. Attention items are not durable tracker truth; they are projections over sessions, jobs, warnings, gates, watcher/git evidence, approvals, and context usage.

Examples:

- approval needed;
- blocked;
- conflict or outside allowed paths;
- not responding / missing heartbeat;
- quiet terminal;
- context high;
- done but closeout pending;
- done claimed but verify evidence missing;
- unbound session.

Every attention item includes evidence source and recommended actions.

### 6.9 Session layout

A user-owned UI arrangement of session cards:

- groups;
- card size: compact / normal / large;
- card position/order;
- pinned tools;
- collapsed/expanded state.

Layouts are local runtime/UI state, not project truth.

---

## 7. Session capability tiers

| Tier | Example | Can show | Cannot infer |
|---|---|---|---|
| Dumb terminal | wrapper-launched CLI | PID, alive/dead, raw stdio, last output time, exit code | approvals, command intent, MCP usage, task progress, skill execution |
| MCP-tracked | agent calling tracker MCP | explicit heartbeats, blockers, job status, skill events | unreported terminal semantics |
| Codex app-server | structured Codex adapter | chat, approvals, structured events, session/thread IDs | non-reported external process behavior |
| Hybrid | app-server + stdio capture | structured events plus raw terminal replay | semantic meaning from raw stdio text |
| Manual | human-attached advisory entry | whatever the human types/edits | anything not entered by a human |

The UI must show confidence/source labels when a state could be ambiguous.

Examples:

- Dumb terminal no output for 8 minutes: ActivityState `quiet`, warning `quiet_terminal` — **check terminal**.
- MCP-tracked agent missing heartbeats for 8 minutes: ActivityState `quiet`, warning `missing_heartbeat`.
- Codex app-server approval event: ActivityState `waiting_for_approval`, warning `approval_needed`.
- MCP status update says blocked: ActivityState `blocked`.
- Human manually sets waiting: ActivityState `waiting_for_human`.
- Manual-tier session: every state change is a human edit; the UI labels the source clearly.

---

## 8. Key user flows

### 8.1 Run Session funnel

There is one Run Session funnel. The entry point decides how much of the draft is pre-filled.

#### Entry point A — from a task card

Most common path.

1. Every runnable, unbound task card shows `[+ RUN SESSION]`.
2. User clicks the action.
3. Run Session wizard opens with the task pre-filled and locked.
4. User chooses profile and runtime, or accepts defaults.
5. Hub shows preflight: repo/worktree, context pack preview, skill plan, verify pack, launch warnings.
6. User launches.

Task card states:

```text
Unbound runnable task:      [+ RUN SESSION]
Bound active task:          [OPEN SESSION] [CHECKPOINT] [ROLLOVER]
Bound quiet/not responding: [OPEN SESSION] [PING] [ROLLOVER]
Done with active job:       [CLOSEOUT] [VERIFY] [ARCHIVE SESSION]
Failed/abandoned session:   [RESUME] [RUN SUCCESSOR]
Conflict:                   [VIEW CONFLICT] [CREATE WORKTREE]
```

#### Entry point B — from a swimlane header

1. Swimlane header shows `[+ NEXT IN LANE]`.
2. Hub ranks unstarted tasks in that lane using dependency readiness, priority, `next`, repo metadata, verify metadata, and active-job conflicts.
3. Wizard opens with the highest-fit task preselected.
4. User may accept or choose another task.

The UI should show a short explanation:

```text
Recommended: Implement auth refresh
Why: next task · dependencies clear · repo known · no active job
```

#### Entry point C — from the Hub

1. Hub shows `[+ RUN]`.
2. Wizard opens with no task locked.
3. Step 1 shows fit-ranked run candidates across all projects.
4. User selects task, profile, runtime, and launch mode.

#### Entry point D — from CLI / attach flow

CLI can create the same draft or attach a manual/dumb/MCP-tracked session to an existing task/job. The UI should immediately show the session and invite the operator to bind or rebind missing metadata.

Acceptance criteria:

- All entry points produce the same `RunSessionDraft` and launch through the same job/session creation path.
- Starting a task-backed session is one click plus optional profile/runtime selection.
- The task shows active job/session badge.
- The session card shows project, task, profile, source tier, and first required skill.
- User can open tools, stdio/chat, context, and handoff in one click.

### 8.2 Launch behavior after the wizard

1. Hub creates a job and skill plan.
2. Hub atomically claims/starts the task if needed.
3. Hub stamps the immutable verify pack.
4. Hub generates a startup context pack.
5. Launch mode:
   - app-server: inject context into Codex app-server session;
   - wrapper: launch process and show copy/paste context or stdin injection if safe;
   - manual: copy prompt / contract;
   - attach existing: bind session to task/job and print/present the contract.
6. Session card appears immediately in the relevant surfaces.

### 8.3 Attach an existing session

1. User runs `llm-tracker session attach --project <slug> --task <taskId> --agent codex`, or creates an attached/manual session from the UI.
2. CLI/UI creates a session record and prints a pasteable contract.
3. User pastes the contract into the existing session.
4. If the agent uses MCP tools, the card upgrades from dumb/manual to MCP-tracked.

Acceptance criteria:

- Existing terminal sessions can be represented without restarting.
- The UI clearly shows limited capability until structured events arrive.
- Low-capability sessions still expose useful controls: open, stdio if available, copy context, mark blocked, bind/rebind task, rollover, archive, and ask for MCP contract.

### 8.4 Where sessions live

Sessions are global runtime objects. Four UI surfaces show the same data through different lenses:

1. **Hub** — all sessions across all projects, grouped by project/status/custom group. This is the control center.
2. **Per-project board** — a Sessions strip above the swimlanes shows only this project's sessions. Task cards bound to a session carry an inline badge.
3. **Triage** — the same sessions and attention items, organized by urgency. This is the view to open when something pings.
4. **Attention strip** — a persistent banner that follows the user across views and surfaces only sessions that need the operator right now.

No surface owns separate truth. Hub, board strip, Triage, and Attention strip are projections over runtime sessions, jobs, warnings, gates, and watcher/git evidence.

Acceptance criteria:

- User can see all active sessions from the Hub.
- User can see project-local sessions from the board without leaving the board.
- User can open Triage to handle all attention items in priority order.
- Attention strip is visible across Hub, project board, task detail, and triage unless explicitly collapsed/snoozed.

### 8.5 When sessions pull attention

A running session is ambient: a calm dot/card. It pulls attention only when one of these states or warnings appears:

- **Approval needed** — structured app-server/MCP/human event asks for approval or explicit confirmation.
- **Blocked** — structured MCP/HTTP/app-server/human event reports blocked.
- **Conflict / outside allowed paths** — watcher/git evidence shows same-file overlap, shared-worktree ambiguity, or a write outside `task.repos.allowed_paths`.
- **Not responding** — expected heartbeat or structured event is overdue.
- **Quiet** — dumb-terminal session has a long pause in raw output. UI never claims a state it cannot prove.
- **Context high** — structured context usage crosses threshold, default 85%; successor pack is ready or can be built.
- **Done needs closeout** — completion evidence exists, but handoff/closeout/review/archive remains.
- **Done claimed, verify missing** — task/session claims done, but required verify/DoD/closeout evidence is absent.
- **Unbound session** — an active runtime session exists without project/task/job binding.

Every item shows its evidence source:

```text
structured · reported · derived · manual · watcher/git · unknown
```

Acceptance criteria:

- No attention item is created from raw stdio semantics.
- Dumb terminal silence may create `quiet_terminal`, not approval/blocker.
- App-server/MCP missing heartbeat may create `not_responding` / `missing_heartbeat`.
- Context-high requires structured context usage.
- Attention items include recommended actions such as approve, open session, open stdio, rollover, run closeout, spawn reviewer, view conflict, create worktree, acknowledge, or snooze.

### 8.6 Monitor all sessions

1. User opens Session Hub view, project board session strip, or Triage.
2. Cards are grouped by project, custom group, urgency, repo/worktree, or provider.
3. User can filter: `[NEEDS ATTENTION] [WAITING] [QUIET] [ACTIVE] [BLOCKED] [CONFLICTS] [UNASSIGNED]`.
4. Session cards can be moved, resized by enum size, grouped, collapsed, and pinned.

Acceptance criteria:

- User identifies attention-needed sessions within 10 seconds.
- No modal is required for common actions.

### 8.7 Use tools without many clicks

Every task card and session card exposes a compact tool row. A right-side or bottom tool shelf shows the same tools for the selected task/session/job.

```text
Task:     [READ] [WHY] [EXEC] [VERIFY] [HANDOFF] [RUN]
Session:  [OPEN] [STDIO] [CHAT] [PING] [STOP] [RESUME] [ROLLOVER] [ARCHIVE]
Job:      [CONTEXT] [SKILLS] [CHECKPOINT] [BLOCKED] [VERIFY] [CLOSEOUT] [COMPLETE]
Repo:     [DIFF] [STATUS] [FILES] [WORKTREE] [CONFLICTS]
Review:   [SPAWN REVIEWER] [CHANGED SINCE] [CLOSEOUT]
```

Actions requiring missing capability are disabled with a short reason, not hidden. The nearest manual/clipboard/MCP-contract alternative should remain available.

Acceptance criteria:

- Core actions require one click from the visible card or selected tool shelf.
- Advanced actions are in command palette, not nested menus.

### 8.8 View stdio and chat

1. User opens a session card.
2. The drawer/pane shows:
   - Summary;
   - Stdio;
   - Chat, if app-server capable;
   - Context;
   - Skills;
   - Events;
   - Attention/evidence.
3. Stdio is raw and labeled raw.
4. Chat is structured only for app-server sessions.

Acceptance criteria:

- User can see raw output without leaving tracker.
- UI never converts raw stdio text into structured status.

### 8.9 Detect quiet / not responding sessions

1. A session is active.
2. No output/heartbeat/structured event arrives for configured X minutes.
3. The session enters the unified `quiet` ActivityState. The cause is disambiguated by warning subtype:
   - `quiet_terminal` — dumb terminal: no raw output recently;
   - `missing_heartbeat` — MCP-tracked / app-server / hybrid: expected structured heartbeats are missing.
4. UI label differs by evidence:
   - `QUIET` for dumb terminal silence;
   - `NOT RESPONDING` for missing structured heartbeat.

There is no separate `stale` state. Stale-ness is a warning subtype / copy concern, not an activity state.

Acceptance criteria:

- Dumb terminals show `quiet_terminal` warnings ("check terminal"), never an approval-needed badge.
- MCP/app-server sessions surface `missing_heartbeat` when expected structured signals stop arriving.
- App-server/MCP sessions may show specific waiting states (`waiting_for_approval`, `blocked`, `waiting_for_human`) only when structured evidence exists.

### 8.10 Approval-needed hint

1. Structured adapter or explicit MCP/HTTP/human event reports approval needed.
2. Card and Attention strip show approval-needed badge.
3. User opens session and handles approval through adapter or raw terminal.

Acceptance criteria:

- Approval badge appears only from structured or explicit source.
- No regex/stdio approval detection.
- `outside_allowed_paths` and `file_conflict` are attention items, not approval-needed unless a structured approval is also present.

### 8.11 Stop, resume, reload

1. User clicks `[STOP]`.
2. Hub gracefully stops the adapter/process if possible.
3. User clicks `[RESUME]` or `[RELOAD]`.
4. Hub rebuilds context from changed-since/session-start state and starts a successor execution under the same session ID umbrella.

Resume does not resurrect the dead process's internal memory or scrollback. For dumb-terminal sessions, "resume" means spawning a fresh process and supplying the deterministic context pack — there is no in-process state recovery beyond what the tracker, git, and runtime event log can describe. For Codex app-server sessions, resume may reattach to a live thread when the adapter exposes one; otherwise it behaves like a successor spawn. The UI must label the two cases distinctly ("successor spawn" vs "thread reattach") so the user does not assume in-process state survived.

Acceptance criteria:

- Stop/resume is audited via runtime events.
- Resume can refresh MCP/config/CLI version.
- Task/job binding is preserved across the stop/resume boundary.
- Dumb-terminal resume never claims to preserve agent memory; the UI surfaces this clearly.

### 8.12 Context rollover

1. User clicks `[ROLLOVER]`, context threshold is exceeded, or a session is quiet/not responding.
2. Hub optionally asks the old session for a final `tracker_session_handoff` call if structured communication is available.
3. Hub builds successor context from tracker/git/runtime evidence.
4. User may edit the successor prompt.
5. New linked session starts.
6. Old session is marked rolled over/archived.

Acceptance criteria:

- Successor context is not based on the old model's freeform summary.
- Optional old-session handoff is labeled advisory.
- New session has links to predecessor, task, start rev, git evidence, and remaining DoD.

### 8.13 Skill-orchestrated job

1. User starts task as `code-implementer`.
2. Job profile adds required skills:
   - before start: `lt.execute_scope`;
   - checkpoint: `lt.status_heartbeat`;
   - before complete: `lt.verify`;
   - after complete: `lt.closeout_sweep`.
3. Session receives startup prompt/injection.
4. Agent reports skill runs via MCP/HTTP/app-server, or user manually marks them.
5. Completion UI shows gates satisfied/missing.

Acceptance criteria:

- Skill plan is visible on the session card and job detail.
- Skill completion is not inferred from terminal text.
- Missing required skills warn/block UI-driven completion unless human overrides.

### 8.14 Cross-session collaboration

Supported primitives:

- **handoff:** structured transfer to task/project/session;
- **broadcast:** project-wide note;
- **ask:** targeted question to another session;
- **verify request:** spawn or assign a reviewer job;
- **changed since:** deterministic delta from job start rev.

Acceptance criteria:

- Handoffs are searchable and attach to project/task/session.
- Broadcasts and asks are visible but do not pollute durable tracker truth unless explicitly promoted.

### 8.15 Cross-project execution order

1. User selects multiple tasks or a tracker group.
2. Hub derives executable order using `next`, dependencies, and external dependencies.
3. User confirms launch plan.
4. Hub starts one or more sessions/jobs.

Acceptance criteria:

- Multi-session launch always requires human confirmation.
- PMO/Neo4j graph backend is optional later.

## 9. Simple UI requirements

### 9.1 Layout principle

The UI should remain a calm tracker, not become a dense IDE. Session Hub is not a separate app bolted onto the tracker; it is the active execution lens over tracker work.

Primary surfaces:

```text
Hub:              all sessions across all projects; grouped by project/urgency/custom group
Project board:    tracker board + project-local Sessions strip + inline task/session badges
Triage:           attention-first kanban by urgency
Attention strip:  persistent, global, only shows sessions/items that need the operator now
```

The default project screen has four zones:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Attention strip: approval/blocker/conflict/not responding/context/done     │
├────────────────────────────────────────────────────────────────────────────┤
│ Top bar: project switcher | Hub | Triage | agent tools | command palette   │
├────────────────────────────────────────────────────────────────────────────┤
│ Project Sessions strip: active sessions for this project                   │
├───────────────┬───────────────────────────────────────┬────────────────────┤
│ Swimlanes     │ Tracker board / task tree / graph     │ Tool/context dock  │
│ + lane runs   │ existing llm-tracker board            │ selected item      │
└───────────────┴───────────────────────────────────────┴────────────────────┘
```

The Hub can become the full-screen control center when the user wants to focus on active sessions. Triage can become the full-screen urgency view when something pings.

### 9.2 Session surfaces

#### Hub

- Shows all sessions across all projects.
- Default grouping: project, then urgency.
- Supports grouping by custom group, provider, repo/worktree, task group/swimlane.
- Includes global `[+ RUN]` action with fit-ranked task recommendations.

#### Project board Sessions strip

- Appears above swimlanes on each project board.
- Shows only sessions bound to this project.
- Task cards bound to a session show inline badge: status, source tier, and last activity.
- Unbound runnable task cards show `[+ RUN SESSION]`.
- Swimlane headers show `[+ NEXT IN LANE]`.

#### Triage

- Shows attention items grouped by severity and kind.
- The same session may appear through its current highest-priority attention item.
- Supports ack/snooze/clear semantics.
- Primary actions are visible on the item: approve, open, stdio, rollover, closeout, verify, spawn reviewer, view conflict.

#### Attention strip

- Persistent across Hub, project board, task detail, and Triage.
- Shows only active high-signal attention items.
- Can be collapsed or snoozed, but should never bury critical approval/conflict items silently.
- Each item includes source label and recommended action.

Example:

```text
Needs you: [APPROVAL · Phalanx auth-refresh · structured · 2m] [CONFLICT · src/auth/session.ts · watcher/git] [NOT RESPONDING · llm-tracker UI job · missing heartbeat · 11m]
```

### 9.3 Session card sizes

- **Compact:** status, project, task, last activity, warning dot.
- **Normal:** compact + progress, model, skill badges, actions.
- **Large:** normal + last output/note and mini event timeline.

This version supports only these three enum sizes — `compact | normal | large`. Free resize handles are deferred until the enum sizes prove insufficient. Size is layout state.

### 9.4 Session grouping

User can group sessions by:

- project;
- custom group;
- status/urgency;
- attention kind;
- agent/provider;
- task group/swimlane;
- repo/worktree.

Groups are collapsible and draggable. Grouping is layout state, not durable project state.

### 9.5 Tool shelf

The selected task/session/job gets a persistent tool shelf:

```text
Task tools:    [READ] [WHY] [EXEC] [VERIFY] [HANDOFF] [RUN]
Session tools: [CHAT] [STDIO] [PING] [STOP] [RESUME] [ROLLOVER] [ARCHIVE]
Job tools:     [CONTEXT] [SKILLS] [CHECKPOINT] [BLOCKED] [VERIFY] [CLOSEOUT] [COMPLETE]
Repo tools:    [DIFF] [STATUS] [FILES] [WORKTREE] [CONFLICTS]
Review tools:  [SPAWN REVIEWER] [CHANGED SINCE] [CLOSEOUT]
```

No tool should require hunting through nested menus. Actions requiring missing capability are disabled with a short reason, not hidden. When direct execution is impossible, offer the nearest manual/clipboard/MCP-contract alternative.

### 9.6 Session thumbnail content

A normal card should show:

```text
Project Phalanx       Codex / app-server      ACTIVE
Task: rm-semantix-alignment-intake
Job: code-implementer
Progress: EXEC ✓  VERIFY ○  CLOSEOUT ○
Last: running npm test auth-refresh.spec.ts — 2m ago
Warnings: none
[OPEN] [STDIO] [CHAT] [STOP] [ROLLOVER]
```

A dumb terminal card should show:

```text
Hoplon                Codex CLI / dumb terminal     QUIET 8m
Task: implement feature
Last raw output: 8m ago
Evidence: derived from raw-output timestamp only
Capability: raw stdio only; approvals are not detected
[OPEN] [STDIO] [PING] [STOP] [COPY CONTEXT] [MCP CONTRACT]
```

An attention item card should show:

```text
NOT RESPONDING        llm-tracker / runtime-store job
Evidence: missing structured heartbeat · reported/MCP expected · 11m
Recommended: [OPEN SESSION] [REQUEST CHECKPOINT] [ROLLOVER] [SNOOZE]
```

### 9.7 Wireframe: Session Hub view

```text
┌─ llm-tracker / Session Hub ────────────────────────────────────────────────┐
│ Attention: [APPROVAL Phalanx] [CONFLICT Hoplon] [NOT RESPONDING tracker]   │
├────────────────────────────────────────────────────────────────────────────┤
│ [ALL] [NEEDS ATTENTION] [WAITING] [QUIET] [BLOCKED] [CONFLICTS] [+ RUN]   │
├────────────────────────────────────────────────────────────────────────────┤
│ Group: Project Phalanx                                      [+ session]    │
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────────────────────────┐ │
│ │ Reviewer      │ │ Implementer   │ │ Large session card                 │ │
│ │ ACTIVE 2m     │ │ APPROVAL      │ │ stdout/chat/context visible        │ │
│ │ VERIFY ○      │ │ npm install   │ │ skills + tool shelf                 │ │
│ │[OPEN][STOP]   │ │[OPEN][CHAT]   │ │[STDIO][ROLLOVER][HANDOFF]          │ │
│ └───────────────┘ └───────────────┘ └───────────────────────────────────┘ │
│                                                                            │
│ Group: llm-tracker                                          collapsed [>]  │
│ ┌───────────────┐ ┌───────────────┐                                       │
│ │ PRD writer    │ │ Code runner   │                                       │
│ │ DONE/CLOSEOUT │ │ QUIET 12m     │                                       │
│ └───────────────┘ └───────────────┘                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

### 9.8 Wireframe: Project board with Sessions strip

```text
┌─ Project Phalanx ──────────────────────────────────────────────────────────┐
│ Attention: [CONFLICT src/auth/session.ts]                                  │
├────────────────────────────────────────────────────────────────────────────┤
│ Sessions: [Implementer ACTIVE] [Reviewer VERIFY ○] [CLI QUIET 8m] [+ RUN] │
├────────────────────────────────────────────────────────────────────────────┤
│ Auth lane                                      [+ NEXT IN LANE]            │
│ ┌────────────────────────────┐ ┌────────────────────────────────────────┐ │
│ │ Task: auth refresh         │ │ Task: login fallback                   │ │
│ │ Bound: Implementer ACTIVE  │ │ [+ RUN SESSION]                        │ │
│ │ [OPEN SESSION][ROLLOVER]   │ │ [READ][WHY][EXEC][RUN]                 │ │
│ └────────────────────────────┘ └────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

## 10. Functional requirements

### 10.1 Session registry

- Create/read/update/archive sessions.
- Support predecessor/successor links.
- Track capability tier.
- Track project/task/job binding.
- Track PID/app-server thread metadata where available.
- Persist through runtime event log and snapshot projection.

### 10.2 Job registry

- Create/read/update/cancel/archive jobs.
- Job binds project + task + session + profile.
- Job records start rev, start time, skill plan, status, and gates.
- Job can be rolled over to successor job/session.

### 10.3 Skills registry

- List skills.
- List job profiles.
- Generate skill plans from profile + task type.
- Record skill run started/completed/skipped/failed.
- Support human override with reason.

### 10.4 Run Session funnel

- Support task-card, swimlane, Hub, CLI, and attach entry points.
- Create a `RunSessionDraft` for every entry point.
- Rank runnable task candidates by lane/project fit, dependency readiness, priority, `next`, repo metadata, verify metadata, and active-job conflicts.
- Show preflight warnings before launch.
- Launch creates job, claims/starts task, stamps verify pack, generates context pack, and starts/attaches runtime session.
- Entry points may lock, preselect, or leave task selection open, but they must converge on the same launch path.

### 10.5 Attention engine

- Compute attention items from runtime sessions, jobs, warnings, completion gates, app-server approvals, MCP blockers, watcher/git conflicts, and tracker patches.
- Prioritize approval, conflict/outside allowed paths, blocker, not responding, context high, done/closeout, verify missing, quiet terminal, and unbound sessions.
- Emit evidence source and recommended actions for every item.
- Support acknowledge, snooze, clear, and dedupe.
- Attention items are runtime projections; they do not become durable tracker truth unless explicitly promoted as a note/decision.

### 10.6 Status model

Session activity states:

- `starting`
- `active`
- `quiet`
- `idle`
- `waiting_for_human`
- `waiting_for_approval`
- `blocked`
- `context_high`
- `done`
- `stopping`
- `stopped`
- `resuming`
- `rolled_over`
- `archived`
- `unknown`

`quiet` is the unified ActivityState for "no output/activity recently." It does not mean approval is pending. The cause (no raw output vs missing structured heartbeat) is carried by the session's warnings, not by separate ActivityStates. There is no `stale` state — use `quiet` plus the `missing_heartbeat` warning kind.

`context_high` only applies to sessions whose tier reports structured token/context usage: Codex app-server sessions, or MCP-tracked agents that explicitly call `tracker_session_context_usage`. Dumb-terminal sessions never enter `context_high` automatically, and basic MCP sessions that do not report usage never enter it either.

User-facing labels may be more specific than ActivityState. For example, `quiet` + `missing_heartbeat` renders as `NOT RESPONDING`; `quiet` + `quiet_terminal` renders as `QUIET`. `done` + missing closeout renders as `DONE / CLOSEOUT`, while `done` + missing verify evidence renders as `DONE CLAIMED / VERIFY MISSING`.

### 10.7 Progress indicators

Progress sources:

- durable task status;
- job skill plan;
- explicit MCP/HTTP checkpoint;
- app-server structured event;
- git/watcher evidence;
- human update.

Progress must be source-labeled:

- `structured`;
- `reported`;
- `derived`;
- `manual`;
- `unknown`.

### 10.8 Stdio

- Store raw stdio logs for wrapper sessions.
- UI supports follow/pause/search/copy.
- Raw stdio is not parsed into semantic state.
- Per-session stdio logs are capped at a configurable maximum size (default 5 MB) with rolling rotation. Older rotated segments are retained up to a bounded count (default 3) and then deleted.
- Stdio logs commonly contain secrets (API keys, tokens, cookies, MFA codes). The hub does not redact. Capture is configurable per workspace, the UI surfaces a "stdio captured" indicator on cards whose adapter is writing raw stdio to disk, and the security docs spell out the risk. Operators are expected to disable capture in sensitive environments.

### 10.9 App-server chat

- Codex app-server sessions support send/receive chat.
- App-server events normalize into session events.
- App-server approvals may show approval-needed badges.

### 10.10 Repo/file conflict detection

- Watch project repo paths using file watchers.
- Detect ambiguous writes when multiple sessions share repo/worktree.
- Use git/worktree evidence for stronger attribution.
- Warn on overlapping file changes or changes outside task `repos.allowed_paths`.
- Agent-reported files never clear conflicts by themselves.

### 10.11 Context packs

Generate context packs for:

- start;
- resume;
- rollover;
- handoff;
- review;
- verify;
- closeout;
- changed-since.

### 10.12 Completion gates

UI-driven completion may warn/block when required gates are missing:

- required skill runs;
- verify pack not run;
- DoD not checked;
- required handoff missing;
- conflict warning unresolved;
- repo allowed-path violation.

Human override must require a reason.

---

## 11. Data ownership

### 11.1 Durable tracker truth

Existing tracker JSON remains the source for:

- project/task metadata;
- task status;
- dependencies;
- DoD;
- references;
- context fields;
- durable decisions and notes;
- rev/history/snapshots.

### 11.2 Runtime truth

`.runtime` owns:

- active sessions;
- jobs;
- skill runs;
- raw stdio logs;
- app-server mappings;
- layout state;
- watcher events;
- ephemeral warnings;
- session event logs.

### 11.3 Optional promotion

A runtime event can be promoted into durable tracker truth only by explicit patch/write action. Example: a session note becomes a task comment or context note only when the user/agent patches the tracker.

---

## 12. Operator-capable build plan

This is not framed as a smallest public MVP. The first useful version should solve the operator's real workflow: start work from tracker tasks, control sessions across projects, and know where attention is required.

### Phase 1 — Runtime foundation + session presence

- JSONL event store with serialized writer.
- Session registry and snapshot projection.
- Session cards in UI.
- Manual attach.
- Dumb terminal stdio view with no semantic parsing.
- Project/session/task/job binding visible everywhere.

### Phase 2 — Run Session funnel + project board integration

- `[+ RUN SESSION]` on runnable task cards.
- `[+ NEXT IN LANE]` on swimlane headers.
- Hub `[+ RUN]` with fit-ranked task recommendations.
- `RunSessionDraft` preflight with profile, runtime, repo/worktree, context, skills, verify pack, warnings.
- Task/session inline badges on cards.
- Project board Sessions strip.

### Phase 3 — Attention strip + Triage

- `AttentionEngine` projection.
- Persistent Attention strip across views.
- Triage view by severity/kind.
- Ack/snooze/clear lifecycle.
- Recommended actions on each attention item.
- Source/evidence labels everywhere.

### Phase 4 — Jobs + skills + simple tools

- Job registry.
- Start task as job.
- Tool shelf and context packs.
- Skill plan visible.
- Verify pack stamped at job creation.
- Completion gate warnings and human override with reason.

### Phase 5 — MCP session/job/skill reporting

- `tracker_session_*`, `tracker_job_*`, `tracker_skill_*` tools.
- Heartbeats, blockers, checkpoints, skill runs.
- `tracker_session_context_usage` for context-high.
- Session MCP contract paste block.
- Completion gate evidence.

### Phase 6 — File watchers + conflict warnings

- ProjectWorkspaceWatcher.
- Repo/worktree attribution.
- Ambiguous write warnings.
- Allowed-path warnings.
- Worktree recommendation / create-worktree action where available.

### Phase 7 — Deterministic rollover

- Rollover context builder.
- Successor session links.
- Advisory old-session handoff.
- User editable prompt.
- One-click successor spawn when configured.

### Phase 8 — Codex app-server adapter

- Structured app-server sessions.
- Chat-like UI.
- Structured approvals.
- Structured context usage.
- Direct context injection.
- Thread reattach where supported.

## 13. Success metrics

- User can identify all sessions needing attention in under 10 seconds.
- Starting a task-backed session from a task card takes one click plus optional profile/runtime selection.
- `[+ NEXT IN LANE]` chooses a sensible task and explains why.
- The Attention strip surfaces only actionable items and includes evidence source + recommended action.
- Hub, project board strip, Triage, and Attention strip show consistent projections of the same runtime state.
- No approval-needed badge is generated from raw stdio heuristics.
- Runtime snapshot corruption does not lose event history; projection rebuild works.
- Rollover successor prompt can be generated even if old session is dead.
- Conflicts are detected when multiple sessions change the same repo/worktree.
- Required skill gates visibly prevent accidental “done” flow without verification.
- UI remains usable with 10+ active sessions across multiple projects.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| UI becomes too complex | Default to cards + tool shelf + command palette; avoid nested pages. |
| False confidence from terminal text | Raw stdio display only; structured states only from explicit sources. |
| Runtime file corruption | Serialized RuntimeStore + JSONL event log + atomic snapshots. |
| Rollover hallucinations | Successor context from tracker/git/runtime evidence, not dying session summary. |
| Conflicts missed due to agent not reporting files | Watchers/git/worktree evidence; agent reports are hints only. |
| Skill automation feels magical | Skill plan is visible; runs recorded; human override explicit. |
| Capability tiers feel limiting | Keep controls visible; disable only physically impossible actions and offer manual/clipboard/MCP-contract alternatives. |

---

## 15. Open questions

### 15.1 Resolved in v0.4

- **Card sizes** — the first operator-capable build uses fixed enum `compact | normal | large`; free resize handles deferred until needed.
- **Manual capability tier** — formally documented as human-attached, advisory-only (no process, no adapter, no stdio).
- **Stale vs quiet** — unified into the `quiet` ActivityState; cause carried by warning subtype (`quiet_terminal`, `missing_heartbeat`); `stale` removed from the vocabulary.
- **Layout persistence** — atomic JSON overwrite at `.runtime/layouts/session-hub.json`; layout events removed from the runtime event log entirely.
- **Context-high triggers** — restricted to structured tiers (Codex app-server, MCP agents that report `tracker_session_context_usage`); other tiers never auto-enter `context_high`.
- **Adapter ↔ hub auth** — session-scoped ephemeral token required on every state-mutating call.
- **Resume semantics** — successor spawn under the same session ID; dumb-terminal resume never claims to preserve in-process state.
- **Stdio retention** — 5 MB per log, rolling rotation, bounded segment count; secrets caveat in security docs.
- **Run Session entry points** — task card, swimlane, Hub, CLI/attach all converge on a single Run Session funnel and `RunSessionDraft`.
- **Session surfaces** — Hub, project board Sessions strip, Triage, and Attention strip are projections over the same runtime state.
- **Attention model** — normal running sessions remain ambient; attention items are source-labeled runtime projections with recommended actions.
- **Done semantics** — distinguish `done_needs_closeout` from `done_claimed_verify_missing` in UI/attention copy.
- **App-server timing** — Codex app-server is P0 for the operator-capable build but **not a boot-time dependency**. The Hub starts and manages sessions without it; app-server features are capability-gated.
- **Activity thresholds** — defaults set in TDD §25 (`heartbeatEveryMinutes: 5`, `missingHeartbeatAfterMinutes: 12`, `dumbTerminalQuietAfterMinutes: 10`, `dumbTerminalQuietEscalateAfterMinutes: 25`, `appServerDisconnectedWarningAfterSeconds: 60`).
- **Default stdio capture** — live tail ON, disk capture OFF; cards label one of `STDIO LIVE | STDIO CAPTURED | STDIO OFF`.
- **Worktree recommendation** — `multiple_sessions_same_worktree` raises an attention item with `[Create worktree for this job]`; Run Session preflight may preselect dedicated worktree creation; no silent moves.
- **`human_approval` notifications** — push-style via Attention projection; emits `verify.human_approval.requested`; persistent strip + Triage, no modal popovers by default; label is `HUMAN APPROVAL REQUIRED` when required, `HUMAN REVIEW READY` otherwise.
- **Layout scope** — single workspace-local `.runtime/layouts/session-hub.json` with per-view + per-project subsections; no separate per-project file (TDD §6.11).
- **UI completion gate enforcement** — UI-driven Complete blocks by default when required gates are missing; human override allowed with recorded reason; direct tracker patches still allowed but produce a `done_claimed_verify_missing` attention item.
- **Cross-project queue scope** — workspace-scope visibility only, no autonomous scheduling; multi-launch capped at 3 with explicit confirmation.
- **Trust model** — all background automation off by default; user-clicked actions remain powerful (TDD §25 `trustedLocalMode`).

### 15.2 Still open

_(no remaining product-level open questions; see TASKS file §1.2 for the two remaining advisory implementation gaps.)_

---

## 16. Product one-liner

**Session Hub is the tracker-native operating layer for agent work: start sessions from tasks, control many sessions across projects, see exactly where attention is needed, run the right skills, watch output, detect conflicts, verify/close out, and roll over safely without losing project truth.**
