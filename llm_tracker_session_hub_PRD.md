# Product Requirements Document: llm-tracker Session Hub

**Product:** llm-tracker Session Hub  
**Status:** Draft v0.3  
**Owner:** justguy / llm-tracker  
**Primary user:** a developer/operator running many local coding-agent sessions across multiple projects  
**Scope:** tracker-native active session tracking, task/session orchestration, job/skill guidance, simple UI, stdio display, Codex app-server control where available  
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

---

## 2. Product thesis

> **The tracker owns durable work. Sessions own runtime execution. Jobs connect a task to a session. Skills guide the job lifecycle.**

The product should feel like a simple, powerful workspace, not an IDE replacement and not a complicated PMO system. The main experience is:

1. Open `llm-tracker`.
2. See every active session in one glance.
3. Drag a task onto a session or start a new Codex session from the task.
4. The tracker creates a job, generates the right context pack, suggests/records required skills, and tracks progress.
5. The user can open raw stdio, app-server chat, task context, tools, and handoff from the same compact panel.
6. If the session gets too long or stale, roll it over into a clean successor using deterministic tracker/git/runtime evidence.

---

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

1. **Global session awareness**  
   Show all active sessions across projects, grouped and filtered by urgency.

2. **Task/session binding**  
   Assign a tracker task to a session, move it between sessions, or start a new session from the task.

3. **Job lifecycle orchestration**  
   A job represents one active execution of a task inside a session. Jobs carry skill plans, progress, status, and lifecycle hooks.

4. **Skill-guided workflows**  
   Attach workflow skills to job hooks: before start, checkpoint, before complete, after complete, rollover, resume.

5. **Simple session UI**  
   Provide movable/resizable session thumbnails with progress, warnings, and one-click tools.

6. **Raw stdio and structured chat**  
   Show raw stdio for wrapper-launched sessions. Provide chat-like app-server interaction for Codex app-server sessions.

7. **Safe stop/resume/reload**  
   Stop and resume a session to reload MCP/config/CLI version while preserving task binding and changed-since context.

8. **Deterministic rollover**  
   Create a linked successor session without trusting the old model’s memory.

9. **Cross-session collaboration**  
   Enable handoffs, broadcasts, asks, verifier jobs, and project/task knowledge sharing.

10. **Preserve local-first simplicity**  
   No required cloud service, PMO graph backend, or database.

### 4.2 Non-goals for v1

- Guardrail policy engine.
- Hoplon-specific integration.
- Required Neo4j/PMO backend.
- Hosted SaaS.
- Full autonomous multi-project scheduler without human confirmation.
- Semantic parsing of arbitrary terminal output.
- Deep multi-provider control beyond Codex app-server and generic MCP/manual sessions.

---

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

### 6.7 Session layout

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

### 8.1 Start a new session from a task

1. User clicks `[RUN]` or drags a task onto the session area.
2. User picks a profile: `code-implementer`, `prd-writer`, `reviewer`, `planner`, `closeout`.
3. Hub creates a job and skill plan.
4. Hub atomically claims/starts the task if needed.
5. Hub generates a startup context pack.
6. Launch mode:
   - app-server: inject context into Codex app-server session;
   - wrapper: launch process and show copy/paste context or stdin injection if safe;
   - manual: copy prompt.
7. Session card appears immediately.

Acceptance criteria:

- The task shows active job/session badge.
- The session card shows project, task, profile, source tier, and first required skill.
- User can open tools, stdio/chat, context, and handoff in one click.

### 8.2 Attach an existing session

1. User runs `llm-tracker session attach --project <slug> --task <taskId> --agent codex`.
2. CLI creates a session record and prints a pasteable contract.
3. User pastes the contract into the existing session.
4. If the agent uses MCP tools, the card upgrades from dumb/manual to MCP-tracked.

Acceptance criteria:

- Existing terminal sessions can be represented without restarting.
- The UI clearly shows limited capability until structured events arrive.

### 8.3 Monitor all sessions

1. User opens Session Hub view or session rail.
2. Cards are grouped by project, custom group, or urgency.
3. User can filter: `[WAITING] [QUIET] [ACTIVE] [BLOCKED] [CONFLICTS] [UNASSIGNED]`.
4. Session cards can be moved, resized, grouped, collapsed, and pinned.

Acceptance criteria:

- User identifies attention-needed sessions within 10 seconds.
- No modal is required for common actions.

### 8.4 Use tools without many clicks

Every task card and session card exposes a compact tool row:

```text
[NEXT] [READ] [WHY] [EXEC] [VERIFY] [HANDOFF] [RUN] [STOP/RESUME] [ROLLOVER]
```

A right-side or bottom tool shelf shows the same tools for the selected task/session. `⌘K` remains the catch-all for search/actions.

Acceptance criteria:

- Core actions require one click from the visible card or selected tool shelf.
- Advanced actions are in command palette, not nested menus.

### 8.5 View stdio and chat

1. User opens a session card.
2. The drawer/pane shows:
   - Summary;
   - Stdio;
   - Chat, if app-server capable;
   - Context;
   - Skills;
   - Events.
3. Stdio is raw and labeled raw.
4. Chat is structured only for app-server sessions.

Acceptance criteria:

- User can see raw output without leaving tracker.
- UI never converts raw stdio text into structured status.

### 8.6 Detect quiet sessions

1. A session is active.
2. No output/heartbeat/structured event arrives for configured X minutes.
3. The session enters the unified `quiet` ActivityState. The cause is disambiguated by warning subtype:
   - `quiet_terminal` — dumb terminal: no raw output recently;
   - `missing_heartbeat` — MCP-tracked / app-server / hybrid: expected structured heartbeats are missing.
4. UI shows the warning and quick actions.

There is no separate `stale` state. Stale-ness is a warning subtype, not an activity state.

Acceptance criteria:

- Dumb terminals show `quiet_terminal` warnings ("check terminal"), never an approval-needed badge.
- MCP/app-server sessions surface `missing_heartbeat` when expected structured signals stop arriving.
- App-server/MCP sessions may show specific waiting states (`waiting_for_approval`, `blocked`, `waiting_for_human`) only when structured evidence exists.

### 8.7 Approval-needed hint

1. Structured adapter or explicit MCP/HTTP event reports approval needed.
2. Card shows approval-needed badge.
3. User opens session and handles approval through adapter or raw terminal.

Acceptance criteria:

- Approval badge appears only from structured or explicit source.
- No regex/stdio approval detection.

### 8.8 Stop, resume, reload

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

### 8.9 Context rollover

1. User clicks `[ROLLOVER]`, context threshold is exceeded, or a session is quiet/stale.
2. Hub optionally asks the old session for a final `tracker_session_handoff` call if structured communication is available.
3. Hub builds successor context from tracker/git/runtime evidence.
4. User may edit the successor prompt.
5. New linked session starts.
6. Old session is marked rolled over/archived.

Acceptance criteria:

- Successor context is not based on the old model’s freeform summary.
- Optional old-session handoff is labeled advisory.
- New session has links to predecessor, task, start rev, git evidence, and remaining DoD.

### 8.10 Skill-orchestrated job

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

### 8.11 Cross-session collaboration

Supported primitives:

- **handoff:** structured transfer to task/project/session;
- **broadcast:** project-wide note;
- **ask:** targeted question to another session;
- **verify request:** spawn or assign a reviewer job;
- **changed since:** deterministic delta from job start rev.

Acceptance criteria:

- Handoffs are searchable and attach to project/task/session.
- Broadcasts and asks are visible but do not pollute durable tracker truth unless explicitly promoted.

### 8.12 Cross-project execution order

1. User selects multiple tasks or a tracker group.
2. Hub derives executable order using `next`, dependencies, and external dependencies.
3. User confirms launch plan.
4. Hub starts one or more sessions/jobs.

Acceptance criteria:

- Multi-session launch always requires human confirmation.
- PMO/Neo4j graph backend is optional later.

---

## 9. Simple UI requirements

### 9.1 Layout principle

The UI should remain a calm tracker, not become a dense IDE. The default screen has three zones:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Top bar: project switcher | agent tools | history | command palette       │
├────────────────────────────────────────────────────────────────────────────┤
│ Hero/status: progress | recommended next | warnings | active sessions     │
├───────────────┬───────────────────────────────────────┬────────────────────┤
│ Session rail  │ Tracker board / task tree / graph     │ Tool/context dock  │
│ cards/groups  │ existing llm-tracker board            │ selected item      │
└───────────────┴───────────────────────────────────────┴────────────────────┘
```

The session rail can become a full Session Hub view when the user wants to focus on active sessions.

### 9.2 Session card sizes

- **Compact:** status, project, task, last activity, warning dot.
- **Normal:** compact + progress, model, skill badges, actions.
- **Large:** normal + last output/note and mini event timeline.

MVP supports only these three enum sizes — `compact | normal | large`. Free resize handles are deferred until the enum sizes prove insufficient. Size is layout state.

### 9.3 Session grouping

User can group sessions by:

- project;
- custom group;
- status/urgency;
- agent/provider;
- task group/swimlane;
- repo/worktree.

Groups are collapsible and draggable. Grouping is layout state, not durable project state.

### 9.4 Tool shelf

The selected task/session gets a persistent tool shelf:

```text
Task tools:    [READ] [WHY] [EXEC] [VERIFY] [HANDOFF] [RUN]
Session tools: [CHAT] [STDIO] [PING] [STOP] [RESUME] [ROLLOVER] [ARCHIVE]
Job tools:     [SKILLS] [CHECKPOINT] [VERIFY] [CLOSEOUT] [COMPLETE]
```

No tool should require hunting through nested menus.

### 9.5 Session thumbnail content

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
Capability: raw stdio only; approvals are not detected
[OPEN] [STDIO] [PING] [STOP] [COPY CONTEXT]
```

### 9.6 Wireframe: Session Hub view

```text
┌─ llm-tracker / Session Hub ────────────────────────────────────────────────┐
│ [ALL] [WAITING] [QUIET] [BLOCKED] [CONFLICTS] [ACTIVE]     [⌘K command]   │
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
│ │ DONE          │ │ QUIET 12m     │                                       │
│ └───────────────┘ └───────────────┘                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

---

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

### 10.4 Status model

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

### 10.5 Progress indicators

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

### 10.6 Stdio

- Store raw stdio logs for wrapper sessions.
- UI supports follow/pause/search/copy.
- Raw stdio is not parsed into semantic state.
- Per-session stdio logs are capped at a configurable maximum size (default 5 MB) with rolling rotation. Older rotated segments are retained up to a bounded count (default 3) and then deleted.
- Stdio logs commonly contain secrets (API keys, tokens, cookies, MFA codes). The hub does not redact. Capture is configurable per workspace, the UI surfaces a "stdio captured" indicator on cards whose adapter is writing raw stdio to disk, and the security docs spell out the risk. Operators are expected to disable capture in sensitive environments.

### 10.7 App-server chat

- Codex app-server sessions support send/receive chat.
- App-server events normalize into session events.
- App-server approvals may show approval-needed badges.

### 10.8 Repo/file conflict detection

- Watch project repo paths using file watchers.
- Detect ambiguous writes when multiple sessions share repo/worktree.
- Use git/worktree evidence for stronger attribution.
- Warn on overlapping file changes or changes outside task `repos.allowed_paths`.
- Agent-reported files never clear conflicts by themselves.

### 10.9 Context packs

Generate context packs for:

- start;
- resume;
- rollover;
- handoff;
- review;
- verify;
- closeout;
- changed-since.

### 10.10 Completion gates

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

## 12. MVP plan

### Milestone 1 — RuntimeStore + session cards

- JSONL event store with serialized writer.
- Session registry and snapshot projection.
- Session cards in UI.
- Manual attach.
- Dumb terminal stdio view with no semantic parsing.

### Milestone 2 — Jobs + simple tools

- Job registry.
- Start task as job.
- Task/session binding.
- Tool shelf and context packs.
- Skill plan visible but manual/explicit reporting only.

### Milestone 3 — MCP session/job/skill reporting

- `tracker_session_*`, `tracker_job_*`, `tracker_skill_*` tools.
- Heartbeats, blockers, checkpoints, skill runs.
- Completion gate warnings.

### Milestone 4 — File watchers + conflict warnings

- ProjectWorkspaceWatcher.
- Repo/worktree attribution.
- Ambiguous write warnings.
- Allowed-path warnings.

### Milestone 5 — Deterministic rollover

- Rollover context builder.
- Successor session links.
- Advisory old-session handoff.
- User editable prompt.

### Milestone 6 — Codex app-server adapter

- Structured app-server sessions.
- Chat-like UI.
- Structured approvals.
- Direct context injection.

---

## 13. Success metrics

- User can identify all sessions needing attention in under 10 seconds.
- Starting a task-backed session takes one click plus optional profile selection.
- No approval-needed badge is generated from raw stdio heuristics.
- Runtime snapshot corruption does not lose event history; projection rebuild works.
- Rollover successor prompt can be generated even if old session is dead.
- Conflicts are detected when multiple sessions change the same repo/worktree.
- Required skill gates visibly prevent accidental “done” flow without verification.
- UI remains usable with 10+ active sessions.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| UI becomes too complex | Default to cards + tool shelf + command palette; avoid nested pages. |
| False confidence from terminal text | Raw stdio display only; structured states only from explicit sources. |
| Runtime file corruption | Serialized RuntimeStore + JSONL event log + atomic snapshots. |
| Rollover hallucinations | Successor context from tracker/git/runtime evidence, not dying session summary. |
| Conflicts missed due to agent not reporting files | Watchers/git/worktree evidence; agent reports are hints only. |
| Skill automation feels magical | Skill plan is visible; runs recorded; human override explicit. |
| Too many adapters too soon | Dumb terminal + MCP explicit events first; app-server later. |

---

## 15. Open questions

### 15.1 Resolved in v0.3

- **Card sizes** — MVP uses fixed enum `compact | normal | large`; free resize handles deferred until needed.
- **Manual capability tier** — formally documented as human-attached, advisory-only (no process, no adapter, no stdio).
- **Stale vs quiet** — unified into the `quiet` ActivityState; cause carried by warning subtype (`quiet_terminal`, `missing_heartbeat`); `stale` removed from the vocabulary.
- **Layout persistence** — atomic JSON overwrite at `.runtime/layouts/session-hub.json`; layout events removed from the runtime event log entirely.
- **Context-high triggers** — restricted to structured tiers (Codex app-server, MCP agents that report `tracker_session_context_usage`); other tiers never auto-enter `context_high`.
- **Adapter ↔ hub auth** — session-scoped ephemeral token required on every state-mutating call.
- **Resume semantics** — successor spawn under the same session ID; dumb-terminal resume never claims to preserve in-process state.
- **Stdio retention** — 5 MB per log, rolling rotation, bounded segment count; secrets caveat in security docs.

### 15.2 Still open

1. Should layout state be workspace-level only, or project-level plus global?
2. How much of Codex app-server should be required before launch vs optional enhancement?
3. Should completion gates warn only, or block UI-driven completion by default?
4. Should cross-project launch queues be v1.5 or v2?
5. Default stdio-capture state per workspace — ON (debug-friendly) or OFF (secret-safe)?
6. Default `quietAfterMinutes` / `staleAfterMinutes` thresholds — what feels least annoying in real use?
7. Verify pack `human_approval` items — how to render a "ready for human" notification without UI polling?

---

## 16. Product one-liner

**Session Hub is the simple local control plane for many active coding-agent sessions: see who is doing what, attach tasks to sessions, run the right workflow skills, watch output, detect conflicts, and roll over safely without losing project truth.**
