# Session Hub: stdio capture and secrets

This page explains how Session Hub handles raw session stdio: what is live, what is written to disk, how long it is kept, and how to turn capture off. It is short on purpose. The SH-2-05 "stdio captured" indicator tooltip links here.

Spec sources: TDD v0.5 §5.1, §10.8 (renumbered §19.3 in TDD), §23.2 closure 6, §25 (`sessionHub.stdio.*`).

<a id="overview"></a>

## What gets captured

Session Hub keeps stdio in two layers:

1. **Live stdio (in-memory ring buffer)** — always on for any session whose adapter emits stdout/stderr. The hub keeps an in-memory ring buffer of `sessionHub.stdio.memoryRingBytes` (default **256 KiB**, see §25). The UI follows/pauses/searches this buffer. Nothing is written to disk in this mode.
2. **Disk capture (optional)** — when enabled, the adapter also appends raw stdio to `.runtime/session-stdio/<sessionId>.log` (TDD §5.1). Capture is **OFF by default** per TDD §23.2 closure 6.

Session cards show one of three labels so you always know which mode is active (§23.2 #6):

- `STDIO LIVE` — live ring buffer only, nothing on disk.
- `STDIO CAPTURED` — adapter is writing raw stdio to `.runtime/session-stdio/<sessionId>.log`.
- `STDIO OFF` — adapter does not expose stdio (manual/structured-only session).

<a id="retention"></a>

## Retention when capture is on

Per TDD §19.3 and §25 (`sessionHub.stdio`):

- Each live log is capped at `maxBytes` (default **5 MB**, `5242880`). When the live log exceeds the cap it is rotated to `<sessionId>.<n>.log` and a fresh live log is started.
- Rotated segments are retained up to `rotatedSegments` (default **3**) and then deleted oldest-first.
- Total on-disk stdio for one session is therefore bounded at roughly `4 × maxBytes` (live + 3 rotated), about 20 MB per session at defaults.

There is no time-based expiry; rotation is purely size-driven.

<a id="secrets-caveat"></a>

## Secrets caveat (read this before enabling capture)

Per TDD §19.3:

- Raw stdio is **not parsed and not redacted** by the hub. Anything the agent or the operator types or echoes lands verbatim in the log.
- That commonly includes **API keys, OAuth tokens, session cookies, MFA codes, `.env` contents printed by tools, and prompt content that quotes secrets**.
- The log file `.runtime/session-stdio/<sessionId>.log` is plain text. Anyone with read access to `.runtime/` (other local processes, backup tooling, sync clients, container mounts) can read it.
- If you commit, ship, or sync the workspace directory, exclude `.runtime/` or strip it first.

Operators are expected to **disable disk capture in sensitive environments**. Live ring-buffer viewing in the UI is unaffected by this choice.

<a id="disable-per-workspace"></a>

## How to disable capture per workspace

Edit the workspace config (lookup order from TDD §23.2 closure 11: `--config <path>`, `LLM_TRACKER_CONFIG`, `<workspaceRoot>/llm-tracker.config.yaml`, `<workspaceRoot>/.llm-tracker/config.yaml`, then built-in defaults).

Set:

```yaml
sessionHub:
  stdio:
    liveTail: true            # in-memory ring is still useful; leave on
    captureToDisk: false      # NO writes to .runtime/session-stdio/*.log
    promptOnFirstCapture: true
    memoryRingBytes: 262144
    maxBytes: 5242880
    rotatedSegments: 3
```

`sessionHub.stdio.captureToDisk: false` is the default; the snippet above is the explicit form. The same key is also controlled by `sessionHub.trustedLocalMode.stdioCaptureToDiskDefault` in §25 — keep both `false` to prevent trusted-mode from flipping it on for new sessions.

After the change, **restart the hub** so it picks up the new config (`llm-tracker daemon restart` if running as a daemon).

<a id="disable-per-session"></a>

## How to disable capture for one running session

Toggling capture at runtime emits an auditable `SessionStdioCaptureChangedEvent` (TDD §6.6, §23.2 closure 6). Two paths:

- **UI** — open the session card, use the stdio control in the detail dock. The card label flips between `STDIO CAPTURED` and `STDIO LIVE` immediately.
- **HTTP** — `POST /api/sessions/:sessionId/stdio/capture` with `{ "captureToDisk": false }`. (This endpoint is the toggle wired to the `SessionStdioCaptureChangedEvent` in TDD §6.6; the broader session-endpoint table is in TDD §12.1.)

Switching capture off:

- Stops new writes to the live log immediately.
- Does **not** delete already-rotated segments; remove `.runtime/session-stdio/<sessionId>*.log` manually if you need to scrub.
- Leaves the in-memory ring buffer running so the UI keeps working.

<a id="checklist"></a>

## Quick checklist before enabling capture

- The workspace is on a host you trust with plaintext secrets.
- `.runtime/` is not synced, backed up, or shipped.
- Operators know the 5 MB × 3-segment retention applies per session and can fill disk in long bursts.
- Any tool that prints credentials to stdout has been audited or wrapped.
