# Session Hub: repository inventory (Step 0)

Purpose: satisfy Executor Addendum §18 Step 0 — "Before coding, inspect the repository and write a short implementation note". This page records the existing server framework, UI framework, store/revision implementation, CLI/MCP structure, type/schema style, test runner, routing patterns, and WebSocket patterns that Session Hub work must reuse.

**Bottom line: no new framework or database is being introduced for Session Hub.** The runtime layer described in TDD v0.5 §5 (`hub/runtime/*`) extends the existing Hub process; it does not replace the Store, the validator, the UI, or the CLI/MCP entry points.

## Server framework

- **Runtime:** Node.js, ESM (`"type": "module"` in `package.json:5`). Engine pin: `node >=18` (`package.json:15-17`).
- **HTTP:** Express 4 (`package.json:50`), mounted on a `node:http` server (`hub/server.js:1`, `hub/server.js:15`).
- **Process entrypoint:** `bin/llm-tracker.js` boots the hub; `npm start` runs `node bin/llm-tracker.js` (`package.json:9-13`).

Session Hub extension: continue to mount new routes on the same Express `app` and `node:http` server. No move to Fastify/Koa/Nest.

## UI framework

- **Preact + htm**, no build step. Modules are loaded via browser-native `<script type="module">` and an import map (`ui/index.html:12-22`) that maps `preact`, `preact/hooks`, `htm`, `htm/preact`, and `@dagrejs/dagre` to vendored ESM files under `/vendor/*`.
- App entry: `ui/app.js:1-3` (`import { render } from "preact"`, `useState/useEffect/useMemo` from `preact/hooks`, `html` tagged template from `htm/preact`).
- Static assets are served by the hub (`hub/server.js` static handlers; no Vite/webpack/rollup config exists).

Session Hub extension: per TDD §23.2 closure 18 — reuse the existing UI framework. New panels are additional Preact components rendered via `htm`. If an isolated UI package becomes necessary, default to React + Vite + TypeScript.

## Store / revision implementation

- **In-memory state + per-slug lock + atomic file writes:** `hub/store.js` (Store class, `applyPatch`, `applyMove`, `applyCollapse`, rollback, deleteTask/Project, restoreProject, symlinkProject — see `ARCHITECTURE.md:29`).
- **Merge:** `hub/merge.js` — hub-authoritative, preserves task order, refuses deletions, drops `updatedAt`/`rev` from incoming payloads (`ARCHITECTURE.md:30`).
- **Versioning:** `hub/versioning.js:1-2` — `computeDelta(prev, current)`, structured field-level diff used by `since/:rev`; `summarize`, `hasChanges`.
- **Snapshots and history:** `hub/snapshots.js:18-56` — `.snapshots/<slug>/<rev>.json` per-rev snapshots and append-only `.history/<slug>.jsonl` (`writeSnapshot`, `readSnapshot`, `appendHistoryEntry`, `historySince`, `listRevs`).
- **Runtime overlay (linked-tracker high-churn split):** `hub/runtime-overlay.js` — keeps runtime fields out of the repo-visible JSON for linked trackers (`README.md:163-165`).

Session Hub extension: the **durable tracker Store stays untouched.** The new `RuntimeStore` (TDD §5) is a separate serialized JSONL writer at `.runtime/runtime-events.jsonl` with derived snapshots; it never bypasses `hub/store.js` for durable writes (TDD §3.1, §4.2). The optional `task.repos` and `task.verify` keys (TDD §6.9) extend the existing AJV schema validator.

## CLI structure

- **Entry:** `bin/llm-tracker.js` — argument parsing, init/start/daemon/mcp subcommands, dispatch to command modules.
- **Subcommand modules:** `bin/commands/{blockers,brief,changed,decisions,execute,fuzzy,next,pick,reload,search,verify,why}.js` plus `bin/commands/shared.js`. Each module exports `cmdXxx` and is wired in `bin/llm-tracker.js:6-19`.
- **HTTP client:** `bin/workspace-client.js` (`httpRequest`, `resolveWorkspace`, `resolvePort`, `DEFAULT_PORT`) — used by commands that need the running hub.

Session Hub extension: any new CLI surface (`llm-tracker session ...`, `llm-tracker run ...`) lands as a new `bin/commands/<name>.js` and registers from `bin/llm-tracker.js`. No CLI framework migration (no oclif/yargs/commander).

## MCP structure

- **Stdio MCP server:** `bin/mcp-server.js:1-19` uses `@modelcontextprotocol/sdk` (`package.json:46`) with `StdioServerTransport`.
- **Tool registries:** `bin/mcp-tools.js` (composer), `bin/mcp-read-tools.js` (workspace-file-backed deterministic reads), `bin/mcp-write-tools.js` (hub-backed mutations), `bin/mcp-utils.js` (shared formatting/hub helpers).
- **Resources/prompts/context:** `bin/mcp-resources.js`, `bin/mcp-prompts.js`, `bin/mcp-context.js`, `bin/mcp-context-data.js`.

Session Hub extension: `tracker_session_*`, `tracker_job_*`, `tracker_skill_*` (TDD §13) register through the same composer pattern. Reads go through the workspace/runtime files; mutations route through the hub (matches the existing read/write split).

## Type / schema style

- **Pure JavaScript ESM.** No TypeScript anywhere in the runtime (`find` for `*.ts` / `tsconfig*` returns nothing outside `node_modules`).
- **JSON Schema validation via AJV:** `hub/validator.js:1-2` — `ajv@^8.17.1` plus `ajv-formats@^3.0.1` (`package.json:47-48`). The tracker schema is defined inline in `hub/validator.js` and reuses constants from `hub/references.js` and `hub/status-vocabulary.js`.

Session Hub extension: extend the AJV schema for the optional `task.repos` and `task.verify` blocks per TDD §6.9 and §23.2 closure 10. Runtime event shapes (TDD §6.6) are validated by a parallel AJV instance owned by `hub/runtime/events.js` (TDD §5.2). No move to Zod/io-ts.

## Test runner

- **Node's built-in `node --test`:** `package.json:13` (`"test": "node --test"`).
- Tests live under `test/*.test.js` and import `node:test` directly (e.g. `test/blockers.test.js:1`, `test/briefs.test.js:1`, `test/changed.test.js:1`). UI logic is unit-tested via `test/ui-*.test.js`. Shared fixtures: `test/fixtures.js`, `test/helpers/`.

Session Hub extension: new tests follow the same convention — one `test/<area>.test.js` file per module under test, importing `node:test` and `node:assert/strict`. No move to Mocha/Jest/Vitest. TDD §20 maps each subsystem (RuntimeStore, ProcessSessionAdapter, ActivityMonitor, RunSessionService, AttentionEngine, Rollover, WorkspaceWatcher, Skills/jobs, UI, Auth/stdio retention, WebSocket coalescing) to test suites that will land under `test/`.

## Routing patterns

- Express-style handlers attached directly on the `app` instance in `hub/server.js`: `app.get`, `app.post`, `app.patch` (e.g. `hub/server.js:289`, `:354`, `:391`, `:454`, `:543`).
- Cross-cutting middleware is also `app.use(...)` (origin/CSRF guard, JSON body parser with `LLM_TRACKER_BODY_LIMIT`, auth) at `hub/server.js:225`, `:278`.
- Subsystem routes can be split into a registrar function: `hub/routes/intelligence.js` exports `registerIntelligenceRoutes(app, { workspace, store })`, invoked from `hub/server.js:376`.

Session Hub extension: new endpoints (TDD §12) land either inline in `hub/server.js` or — preferred for the larger Session Hub surface — as `hub/routes/<area>.js` files exposing `registerXxxRoutes(app, deps)`, matching the intelligence pattern.

## WebSocket patterns

- Single `WebSocketServer` from `ws@^8.18.0` (`package.json:53`) attached to the same HTTP server on path `/ws` (`hub/server.js:17`, `:723`).
- Same-origin / bearer-token check via `verifyClient: verifyWsClient` (`hub/server.js:723`).
- **Broadcast pattern:** a `broadcast(msg)` closure that JSON-stringifies once and writes to every connected client whose `readyState === 1` (`hub/server.js:732-737`). Every mutating route calls `broadcast({ type, ... })` after a successful write (`:387`, `:405`, `:511`, `:523`, `:535`, `:556`, `:580`, `:596`).
- On connection, the server immediately sends a `SNAPSHOT` frame (`hub/server.js:739-741`).

Session Hub extension: per TDD §15 the WS surface gains `runtime.event`, `attention.updated`, `session.output`, `layout.updated`, etc. Reuse the same `broadcast(...)` helper. Coalescing rules (TDD §15.1: 50 ms for `session.output`, 100 ms for `layout.updated`) sit in the runtime layer and call `broadcast` after the debounce window. **No second WebSocket server.**

## Database

There is **no database**. The system is file-system-as-database (`README.md:11`):

- Durable tracker truth: `<workspace>/trackers/<slug>.json` (one JSON file per project), plus `<workspace>/.snapshots/<slug>/<rev>.json` and `<workspace>/.history/<slug>.jsonl`.
- Linked-tracker runtime split: `.runtime/overlays/<slug>.json` (`README.md:163-165`).
- Workspace scaffold: `workspace-template/` (copied by `llm-tracker init`).
- Hub runtime metadata (daemon pid, port, logs): `.runtime/daemon.json`, `.runtime/daemon.log` (`README.md:411-412`).

Session Hub extension: TDD §5.1 adds more files under `.runtime/` (`runtime-events.jsonl`, `repo-events.jsonl`, `sessions.snapshot.json`, `jobs.snapshot.json`, `skill-runs.snapshot.json`, `session-stdio/*.log`, `layouts/session-hub.json`). All under the same workspace `.runtime/` tree. **No SQLite, Postgres, Redis, LevelDB, or Neo4j.** PRD v0.5 §4.2 explicitly lists "Required Neo4j/PMO backend" as a non-goal.

## Confirmation

Session Hub work for v0.5 does not introduce:

- a new server framework (continues on Express + `node:http`);
- a new UI framework (continues on Preact + htm, no build step);
- a new test runner (continues on `node --test`);
- a TypeScript layer (continues as pure JS ESM);
- a JSON Schema library swap (continues on AJV);
- a second WebSocket implementation (continues on `ws`);
- a database (continues on file-system-as-database under `<workspace>/` and `<workspace>/.runtime/`).

Cross-references: TDD v0.5 §5 (RuntimeStore on JSONL + snapshots), §6.9 (optional tracker schema additions), §12 (HTTP endpoints), §13 (MCP tools), §15 (WS event surface), §20 (test plan), §23.2 closures 1 / 11 / 18 (single event log, workspace config path, reuse existing UI framework).
