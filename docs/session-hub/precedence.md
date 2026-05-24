# Session Hub: executor precedence

Short reference for anyone executing Session Hub work. The order below is verbatim from the Executor Addendum §0 ("How to use this file"); follow it whenever two sources disagree.

## Precedence order

When sources conflict, follow them in this order — the higher line always wins:

1. **Non-negotiable safety/trust rules in the PRD/TDD.** The "raw stdio is display-only," "runtime writes are serialized," "rollover is deterministic," and "watcher/git owns conflict evidence" rules (PRD v0.5 §3, TDD §4) are not overridable by later layers.
2. **Existing llm-tracker durable project/task semantics.** The current tracker Store, AJV validator, merge rules, revision/snapshot/history behavior, and HTTP/MCP contracts at `/help` are durable truth. Session Hub adds runtime objects under `.runtime/`; it never rewrites how durable tracker JSON is owned.
3. **The v0.4 PRD/TDD data model and endpoints.** v0.4 (and any v0.5 sections that build on it) defines `SessionRecord`, `JobRecord`, `SkillPlanItem`, `RuntimeEvent`, `AttentionItem`, `RunSessionDraft`, and the `/api/sessions/*`, `/api/jobs/*`, `/api/skills/*` surfaces. Treat that as the structural source of truth.
4. **The Executor Addendum.** Adds the provider-runtime layer (ProviderBroker, GenericPtyProvider, CodexAppServerProvider, SessionTimelineService, DiffReviewService, WorktreeService), capability gating, and the Step 0–8 implementation order. It refines and extends levels 1–3; it does not override them.
5. **Provider-specific assumptions.** Codex app-server method names, Codex CLI flags, Claude Code wrappers, etc. Anything provider-specific must be verified against the installed provider or the vendored schema (TDD §23.2 closure 19, addendum §0) before it is coded.

## Concrete example

Suppose the addendum (level 4) hints that a Codex app-server event payload includes a `command_completed` field that could mark a tracker task as done.

- Level 1 (safety) says raw provider output cannot drive semantic state without a structured contract — but in this case the provider event IS structured, so this rule does not block the change.
- Level 2 (existing tracker semantics) requires that any move of a task to `status: complete` go through the existing tracker Store with merge, snapshot, and history append. So the completion cannot be written directly into the tracker JSON file by the adapter; it must call the same `POST /api/projects/:slug/patch` (or hub-internal Store call) the rest of the system uses.
- Level 3 (v0.4 data model) requires that the structured event also produce a `RuntimeEvent` (`JobCompletedEvent` plus any provider-event normalization) so the runtime projection stays consistent.
- Level 4 (addendum) provides the recipe for normalizing the provider event.
- Level 5 (provider-specific) supplies the actual field name — to be checked against the vendored Codex schema before merging.

If the addendum's recipe ever conflicts with the level 2 rule that all durable writes go through the Store, the level 2 rule wins. If a provider's actual schema (level 5) names the field differently from the addendum's example (level 4), the real schema wins.

## Non-overridable safety flags

One workspace-config flag is pinned by the schema itself: `sessionHub.trustedLocalMode.neverAutoApproveTerminalPrompts` must be `true`. The strict workspace schema (SH-0-07, see `schema/workspace.schema.json`) declares it as `const: true`, so any config that flips it to `false` fails validation at load time with a dedicated "non-overridable" error. A repo-wide lint test in `test/workspace-config-strict.test.js` additionally fails CI if any source file assigns the flag to `false`, so PRs cannot quietly relax this guarantee. This implements TDD §23.2 closure #20: even in `trustedLocalMode.enabled: true` workspaces, hub automation NEVER auto-approves a provider's terminal-style approval prompt — only a real human action does.

## See also

- PRD v0.5 §3 (non-negotiable design decisions).
- TDD v0.5 §4 (critical design corrections) and §23.2 (closed technical questions).
- Executor Addendum §0 (precedence statement) and §3 (non-negotiables to preserve).
