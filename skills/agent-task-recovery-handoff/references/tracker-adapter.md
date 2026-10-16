# Optional llm-tracker evidence adapter

The core workflow works without a tracker. This adapter describes an already available connection; do not install a server, start a daemon or change registrations to use it. No external service is required by the core workflow.

## Source and runtime boundary

Schema source inspected: [justguy/llm-tracker at v1.1.0 commit 23371f3](https://github.com/justguy/llm-tracker/tree/23371f37f5059228f610cf91566380e4b6a8b3c1), specifically `bin/mcp-read-tools.js` and `bin/mcp-write-tools.js`. The inspected main commit `5cc5d17bf2c71600e37f96b52795e4d0c6b064ad` reports 1.0.0; v2 refs diverge. Version labels alone do not establish schema compatibility. This is a source-reviewed adapter, not a live integration certification.

Discover the actual tools/schema through the host and read `tracker_help {}` (or the available `tracker://help` resource) before interpreting workspace conventions. Read operations may use workspace files; a success does not prove the hub can accept writes. Use the installed contract when it differs, or skip the adapter. Do not guess unsupported arguments or switch versions.

## Bounded reads and their meaning

These argument shapes match the inspected v1.1.0 source. The tool namespace may differ by host.

| Tool | Arguments | Use and limit |
|---|---|---|
| tracker_help | `{}` | Workspace contract, not permission for arbitrary actions |
| tracker_project_status | `{"slug":"example-project"}` | Snapshot of project state; record returned revision/target metadata |
| tracker_brief | `{"slug":"example-project","taskId":"T-7"}` | Bounded task claims, constraints and references |
| tracker_changed | `{"slug":"example-project","fromRev":12,"limit":20}` | Changed tasks since known project revision; limit 1–50, may be truncated |
| tracker_execute | `{"slug":"example-project","taskId":"T-7"}` | Execution guidance; it does not execute implementation |
| tracker_verify | `{"slug":"example-project","taskId":"T-7"}` | Verification guidance; it does not run tests or prove a pass |
| tracker_handoff | `{"slug":"example-project","taskId":"T-7","fromAssignee":"outgoing","toAssignee":"incoming"}` | Returns a pack and Markdown `handoffPrompt`; it does not send, assign or launch |

Assignee labels are optional descriptive text; do not invent identities. `tracker_handoff` also has `from`/`to` aliases in this source, but they add no communication capability. Use only the reads needed for the task; do not run the whole table by default.

Convert each relevant field into a claim with tool + arguments + capture + returned project revision. Keep code baseline separate. Reconcile returned “complete” or “verified” prose against actual implementation and real check output. Preserve warnings, truncation and unresolved decisions. If a newer revision exists, the older packet is historical; inspect bounded changes if permitted. If a transport call fails, stop that access path and complete a local packet with the missing data explicit. Never loop, restart, reload or fall back to direct writes to bypass failure.

## Writes are outside context recovery

Prepare a local proposal only if useful. Do not patch status, start tasks or reopen completed tasks as a recovery side effect. Do not force a completion, clear gates, infer approval, rewrite history or edit tracker JSON directly.

If a later user request separately authorizes a tracker update, use its live contract and target. The inspected `tracker_patch` schema requires `slug` and `patch`; optional outer fields include `workspace` and `mode` (`hub` or `direct`). Optimistic revision checking belongs **inside** `patch.expectedRev`, not at the outer tool level. For example, this is a documentation-only shape for an authorized note update:

```json
{
  "slug": "example-project",
  "patch": {
    "expectedRev": 12,
    "tasks": {
      "T-7": {"context": {"notes": "Partial implementation; current verification unknown. See approved recovery brief."}}
    }
  }
}
```

Read current state before proposing it. `context` merges per key; updating `notes` can replace an existing value, so preserve relevant content in any reviewed proposal. On a revision conflict, stop that write attempt and reconcile current state before a new authorized attempt. Do not use `mode: "direct"`, migration flags, status-regression overrides, permission changes or gate bypasses as recovery fallbacks. A schema admitting an override is not permission to use it. Confirm any separately authorized write with a read; until then report it as a proposal or unconfirmed attempt.
