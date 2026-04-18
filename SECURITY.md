# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Reporting a vulnerability

Prefer **GitHub private security advisories**: open one at
<https://github.com/justguy/llm-tracker/security/advisories/new>.

If advisories are unavailable in your account, open a regular GitHub issue with
the title prefix `security:` and mark it as a draft until a maintainer contacts
you. Do not include exploit details in the public issue body.

## Threat model

`llm-tracker` is designed for **local and trusted-LAN use**, not hostile
multi-tenant environments. Its security surface is bounded accordingly:

- The hub binds to `127.0.0.1` by default. Other hosts on the LAN cannot reach
  it unless you explicitly set `LLM_TRACKER_HOST=0.0.0.0`.
- Every mutating HTTP request (`POST` / `PUT` / `PATCH` / `DELETE`) must carry
  an `Origin` that matches the hub's own origin, or no `Origin` at all (CLI /
  `curl` / MCP context). Anything else is rejected with `403`, blocking browser
  CSRF even when the hub is exposed on a LAN IP.
- WebSocket connections at `/ws` apply the same origin policy; cross-origin
  browser upgrades are rejected with `403`.
- When `LLM_TRACKER_TOKEN` is set, every mutating request must present
  `Authorization: Bearer <secret>` (or `X-LLM-Tracker-Token: <secret>`). The
  browser UI receives a short-lived HttpOnly same-origin session cookie so the
  raw secret is never injected into page JavaScript.
- When tokenized, `/ws` also requires the bearer token unless the request
  carries the UI session cookie.
- JSON request bodies are capped at 1 MB (configurable via
  `LLM_TRACKER_BODY_LIMIT`). Per-field limits further bound oversized payloads
  before any merge logic runs.

If you require genuinely multi-tenant or internet-facing deployment you should
place the hub behind a reverse proxy with TLS, network-level access controls,
and additional authentication that matches your threat model.

## Known limitations

The following gaps are acknowledged and tracked for future releases:

- No rate limiting on any endpoint. A local process or browser tab can flood the
  hub with requests.
- No structured audit log for hub-level authentication events (token mismatch,
  origin rejection). Rejections are returned to clients as `401` / `403` JSON,
  but the hub does not currently emit distinct server-side audit records for
  them.
- No Content-Security-Policy header on the UI shell (`index.html`).
- The in-memory UI session Map is not persisted; all active browser sessions are
  invalidated on hub restart.
- Bearer token rotation does not immediately invalidate existing UI session
  cookies; old cookies remain valid until their TTL expires.

## Response expectations

We will make a best-effort attempt to acknowledge reports within approximately
seven days. Non-critical issues will be addressed in the next scheduled release.
Critical vulnerabilities (those enabling remote code execution, authentication
bypass, or data exfiltration on default configurations) will be patched as
quickly as possible outside the normal release cadence.
