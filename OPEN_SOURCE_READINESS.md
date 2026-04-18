# Open-Source Readiness Review

Pre-publish audit of `llm-tracker`. Originally written 2026-04-16 as a gap
list; this revision (same day) records how each item was addressed so the
audit can be checked off in one read.

Final snapshot:

- Tests: **179 passing** (`npm test`, ~37s)
- License: Apache-2.0; `NOTICE` now present and shipped
- CI: Ubuntu × Node 18/20/22 + macOS/Windows smoke + `npm pack --dry-run`
- Community files: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`,
  `.github/pull_request_template.md`
- Architecture diagram in `README.md` (Mermaid)

---

## Blockers — all resolved

### 1. Repo hygiene — resolved

Scratch files removed from working tree: `FOLLOW_UP_GAPS*.md`,
`RELEASE_CHECKLIST.md`, `execution_order*`, `features.txt`,
`llm-tracker-demo-and-provisional-pack.md`, `llm-tracker-0.2.0.tgz`.
`.llm-tracker/` added to `.gitignore`. Nothing was `git rm` because none of
these were tracked.

### 2. `package.json` repo URL — not a blocker

`git remote -v` is `git@github.com:justguy/llm-tracker.git`; metadata matches
the publish target.

### 3. `SECURITY.md` — added

Supported versions, private advisory reporting channel, threat model lifted
from README §Local security, known-limitations list (no rate limit, no audit
log, no CSP, session Map not persisted, no token-rotation invalidation),
response expectations.

### 4. Version bump — not needed

Backward-compatibility shims cover the bind-host change and contract
additions; release-please drives versioning on its own cadence.

---

## Should-fix — all resolved or accepted

### 5. Community health files — resolved

`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (references Contributor Covenant 2.1
by URL), bug-report / feature-request issue templates, PR template. All link
back to the right canonical sources.

### 6. CI coverage gaps — partly resolved

Added `npm pack --dry-run` step to `.github/workflows/ci.yml` so a missing
entry in `package.json:files` fails CI.

**Open**: no lint step (no ESLint config exists in the repo); no
`npm audit` schedule. Both are post-launch follow-ups, not publication
blockers.

### 7. `files` array — resolved

`CHANGELOG.md`, `MIGRATING.md`, `NOTICE` added to `package.json:files`.
Verified via `npm pack --dry-run`.

### 8. Docs duplication between the two READMEs — resolved (cross-reference)

Added a "Canonical agent contract" blockquote at the top of
`workspace-template/README.md` and a "For agents" pointer in `README.md`'s
Agent Help section. `AGENTS.md` already named `workspace-template/README.md`
as canonical — no change there.

Not attempted: aggressive de-duplication. Overlap between the two files is
mostly intentional (one for humans, one for agents); the explicit cross-
references are the lowest-risk way to keep them from drifting.

### 9. Security posture gaps — partly resolved

- Security headers on UI shell (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy: interest-cohort=()`). `nosniff` also applied to all
  UI assets.
- UI session Map TTL sweep (unref'd interval + `clearInterval` on shutdown)
  so long-running hubs don't leak entries.

**Open (documented in `SECURITY.md`)**: no rate limiting, no structured hub
audit log, no CSP (inline importmap in `ui/index.html` would require
nonce-based CSP — deferred), no token-rotation cookie invalidation, wrong
tokens don't log a distinguishable error. All are post-launch work.

### 10. Dependency footprint / first-run UX — resolved

Added a stderr hint (`[llm-tracker] preparing semantic search backend — first
run downloads model weights, this may take a minute`) that fires exactly
once, right before the heavy `@huggingface/transformers` import in
`hub/search.js`. Users no longer wonder why the first `/search` call takes a
minute.

Not attempted: moving `@huggingface/transformers` to `optionalDependencies`.
The existing `semantic_hash_fallback` path covers runtime failures, but a
fully-missing module would need test work to validate; deferring as a
feature decision.

### 11. UI accessibility — resolved (minimal pass)

6 modal roots now have `role="dialog"` + `aria-modal="true"` + `aria-label`;
10 icon-only buttons got `aria-label` across `ui/app.js`,
`ui/modals/history.js`, and `ui/modals/intelligence.js`.

Not attempted: focus trapping, keyboard handling, or full ARIA live regions.
Those are bigger UX projects.

### 12. Test fixture duplication — resolved

`makeWorkspace()` added to `test/fixtures.js`. `test/tombstones.test.js`
migrated as the reference example; other tests left alone to avoid churn.

### 13. Observability — partly resolved

Added unauthenticated `GET /healthz` returning `{ok, projects,
uptimeSeconds}`. Two tests cover it, including the "reachable without bearer
token when `LLM_TRACKER_TOKEN` is set" case.

Not attempted: structured logging or daemon-log rotation. Deferred.

---

## Nice-to-have — done or deliberately out of scope

### 14. Docker — reverted (does not fit the product)

Initially added a `Dockerfile` + `.dockerignore`; removed on review.
`llm-tracker` is deliberately local-first — the hub binds loopback,
watches a workspace on the same filesystem as the LLM agents that talk to
it, and ships as an `npx` CLI. Running it in a container forces
`LLM_TRACKER_HOST=0.0.0.0` and a mandatory token just to replicate
functionality that `npx llm-tracker` already provides with better security
defaults. MCP registry submission and Homebrew tap (also §14) remain
reasonable but are external actions, user-owned.

### 15. Docs — partly resolved

Architecture-at-a-glance Mermaid diagram added to `README.md` between the
pitch and "Why use llm-tracker?".

Not attempted: moving `ARCHITECTURE.md` / `MIGRATING.md` into a `docs/`
folder (too many cross-references would need updating), standalone tutorial
repo (separate project).

### 16. Feature opportunities — out of scope

SSE alongside WebSocket, UI surface for tombstones, per-project ACLs — all
genuine feature work tracked as follow-ups, not readiness concerns.

### 17. NOTICE file — resolved

`NOTICE` created at repo root listing bundled third-party software with
licenses. No dependency ships its own NOTICE file (full `find` on
`node_modules` returned zero matches), so no verbatim reproduction under
Apache-2.0 §4(d) is triggered. `NOTICE` added to `package.json:files`.

---

## Suggested pre-publish checklist — final

- [x] Scratch files + repo URL
- [x] `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR templates
- [x] `MIGRATING.md`, `CHANGELOG.md`, `NOTICE` ship in the tarball
- [x] `npm pack --dry-run` step in CI
- [x] Architecture diagram in README
- [x] Security headers + session cleanup
- [x] Healthz endpoint (Dockerfile reverted — see §14)
- [x] UI a11y minimal pass
- [x] First-run download hint
- [x] `npm test` passes (179/179)
- [ ] Run `npm pack && npm install -g ./llm-tracker-*.tgz` on a clean
      environment and walk through the quickstart one more time
- [ ] Tag a release (release-please drives the version on next merge to `main`)

---

## Items deliberately deferred (not blocking publication)

- ESLint / Prettier config and lint step in CI (§6)
- Periodic `npm audit` (§6)
- Rate limiting, structured audit log, CSP, token-rotation invalidation (§9)
- `@huggingface/transformers` → `optionalDependencies` (§10)
- Focus trap + keyboard handlers for modals (§11)
- Daemon-log rotation + structured logging (§13)
- MCP registry submission, Homebrew tap, tutorial repo (§14-15)
- SSE, tombstone UI, per-project ACLs (§16)
