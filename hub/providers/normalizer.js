// hub/providers/normalizer.js — SH-2-19 (addendum §8)
//
// ProviderEventNormalizer — turns provider-neutral ProviderEvents into
// downstream domain outputs:
//
//   - `runtimeEvents`    fully-shaped RuntimeEvent payloads (caller strips
//                        the placeholder id before runtime store append).
//   - `attentionIntents` raise/clear intents the AttentionEngine (SH-4-01)
//                        consumes to manage AttentionItems.
//   - `timelineItems`    timeline rows the SessionTimelineService (SH-4A-02)
//                        renders into the session detail timeline.
//
// Mapping table (addendum §8 normalization rules, abbreviated):
//
//   approval.requested
//     → session.status=waiting_for_approval (RuntimeEvent)
//     → session.warning kind=approval_needed (RuntimeEvent)
//     → AttentionIntent kind=approval_needed action=raise
//     → TimelineItem kind=approval phase=requested
//
//   approval.resolved
//     → session.warning_cleared kind=approval_needed (RuntimeEvent)
//     → AttentionIntent kind=approval_needed action=clear
//     → TimelineItem kind=approval phase=resolved
//     (status-return-to-prior-state is deferred to a higher layer that
//      has the prior-state memory; we emit warning_cleared only.)
//
//   context.usage at-or-above threshold
//     → session.status=context_high
//     → session.warning kind=context_high (percent)
//     → AttentionIntent kind=context_high action=raise
//     → TimelineItem kind=context_usage
//
//   context.usage below threshold
//     → TimelineItem kind=context_usage (visibility only; no warnings)
//
//   file_change.proposed
//     → TimelineItem kind=file_change phase=proposed
//     (DiffReview provider annotation hand-off lives in SH-7A; we just
//      surface the proposal — NO conflict cleared, NO git truth assumed.)
//
//   file_change.applied
//     → TimelineItem kind=file_change phase=applied
//     (Crucially, this does NOT emit session.warning_cleared file_conflict.
//      Conflict-clearing requires watcher/git evidence per addendum §8 /
//      TDD §7. The normalizer enforces this invariant — see test
//      `file_change.applied never clears conflict warnings`.)
//
//   command.started / command.output / command.completed
//     → TimelineItem kind=command (phase + stream)
//     (verify-gate satisfaction needs a stamped VerifyPackItem from
//      Phase 5; not in this task's scope.)
//
//   message
//     → TimelineItem kind=message
//
//   thread.started / .resumed / .forked
//     → TimelineItem kind=thread (visibility only)
//
//   turn.started / turn.completed
//     → TimelineItem kind=turn (visibility only)
//
//   provider.error
//     → TimelineItem kind=provider_error
//     (We do NOT emit a session.warning here; provider_error is not in
//      the SessionWarning enum. Higher-level analytics can promote it.)

import { assertValidProviderEvent } from "./provider-events.js";

/** Default percent at which context.usage promotes to context_high. */
export const DEFAULT_CONTEXT_HIGH_PERCENT = 80;

/**
 * @typedef {object} AttentionIntent
 * @property {string} kind                 attention kind (approval_needed, context_high, …)
 * @property {"raise" | "clear"} action
 * @property {string} sessionId
 * @property {string} [providerId]
 * @property {string} [threadId]
 * @property {string} [refId]              correlation id (approvalId, etc.)
 * @property {"low" | "medium" | "high"} [severity]
 * @property {string} [title]
 * @property {string} ts
 */

/**
 * @typedef {object} TimelineItem
 * @property {string} sessionId
 * @property {string} providerId
 * @property {string} ts
 * @property {string} kind
 * @property {"low" | "medium" | "high"} [severity]
 * @property {object} [data]               kind-specific payload
 */

/**
 * @typedef {object} NormalizeResult
 * @property {object[]} runtimeEvents      partial RuntimeEvents with placeholder id
 * @property {AttentionIntent[]} attentionIntents
 * @property {TimelineItem[]} timelineItems
 */

/**
 * @typedef {object} NormalizeDeps
 * @property {string} sessionId
 * @property {string} workspace
 * @property {(prefix: string) => string} makeRuntimeId
 * @property {() => string} [now]                          ISO-8601 source; defaults to `new Date().toISOString()`
 * @property {number} [contextHighPercent=DEFAULT_CONTEXT_HIGH_PERCENT]
 */

/**
 * Map a ProviderEvent into the downstream output bundle.
 *
 * @param {object} event       a ProviderEvent (validated against the addendum §8 union)
 * @param {NormalizeDeps} deps
 * @returns {NormalizeResult}
 */
export function normalize(event, deps) {
  assertValidProviderEvent(event);
  const {
    sessionId,
    workspace,
    makeRuntimeId,
    now,
    contextHighPercent = DEFAULT_CONTEXT_HIGH_PERCENT,
  } = deps || {};

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("normalize: sessionId required");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("normalize: workspace required");
  }
  if (typeof makeRuntimeId !== "function") {
    throw new Error("normalize: makeRuntimeId required");
  }
  const tsNow = typeof now === "function" ? now : () => new Date().toISOString();

  const out = /** @type {NormalizeResult} */ ({
    runtimeEvents: [],
    attentionIntents: [],
    timelineItems: [],
  });

  const baseEvent = (type, extra) => ({
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: event.ts || tsNow(),
    type,
    source: "adapter",
    workspace,
    sessionId,
    ...extra,
  });

  const timelineBase = (kind, extra) => ({
    sessionId,
    providerId: event.providerId,
    ts: event.ts,
    kind,
    ...(extra ? { data: extra } : {}),
  });

  switch (event.kind) {
    case "thread.started":
    case "thread.resumed":
    case "thread.forked": {
      out.timelineItems.push(timelineBase("thread", {
        phase: event.kind.split(".")[1], // started | resumed | forked
        threadRef: event.threadRef,
        ...(event.parentThreadId ? { parentThreadId: event.parentThreadId } : {}),
      }));
      break;
    }
    case "turn.started":
      out.timelineItems.push(timelineBase("turn", {
        phase: "started",
        threadId: event.threadId,
        turnId: event.turnId,
      }));
      break;
    case "turn.completed":
      out.timelineItems.push(timelineBase("turn", {
        phase: "completed",
        threadId: event.threadId,
        turnId: event.turnId,
        status: event.status,
      }));
      break;
    case "message":
      out.timelineItems.push(timelineBase("message", {
        threadId: event.threadId,
        role: event.role,
        text: event.text,
      }));
      break;
    case "command.started":
      out.timelineItems.push(timelineBase("command", {
        phase: "started",
        threadId: event.threadId,
        commandId: event.commandId,
        command: event.command,
        ...(event.cwd ? { cwd: event.cwd } : {}),
      }));
      break;
    case "command.output":
      out.timelineItems.push(timelineBase("command", {
        phase: "output",
        threadId: event.threadId,
        commandId: event.commandId,
        stream: event.stream,
        text: event.text,
      }));
      break;
    case "command.completed":
      out.timelineItems.push(timelineBase("command", {
        phase: "completed",
        threadId: event.threadId,
        commandId: event.commandId,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      }));
      break;
    case "file_change.proposed":
      out.timelineItems.push(timelineBase("file_change", {
        phase: "proposed",
        threadId: event.threadId,
        proposalId: event.proposalId,
        files: [...event.files],
        ...(event.summary ? { summary: event.summary } : {}),
      }));
      // Per addendum §8: no conflict cleared, no git truth assumed.
      break;
    case "file_change.applied":
      out.timelineItems.push(timelineBase("file_change", {
        phase: "applied",
        threadId: event.threadId,
        proposalId: event.proposalId,
        files: [...event.files],
      }));
      // NOTE: deliberately does NOT emit session.warning_cleared
      // file_conflict here. Conflict-clearing is gated on watcher/git
      // evidence per TDD §7 — provider-reported paths annotate but never
      // clear conflict warnings.
      break;
    case "approval.requested": {
      out.runtimeEvents.push(baseEvent("session.status", { status: "waiting_for_approval" }));
      out.runtimeEvents.push(baseEvent("session.warning", {
        warning: {
          kind: "approval_needed",
          source: event.providerId,
          message: event.title,
          actionId: event.approvalId,
        },
      }));
      out.attentionIntents.push({
        kind: "approval_needed",
        action: "raise",
        sessionId,
        providerId: event.providerId,
        threadId: event.threadId,
        refId: event.approvalId,
        severity: "high",
        title: event.title,
        ts: event.ts,
      });
      out.timelineItems.push(timelineBase("approval", {
        phase: "requested",
        threadId: event.threadId,
        approvalId: event.approvalId,
        title: event.title,
        ...(event.detail ? { detail: event.detail } : {}),
      }));
      break;
    }
    case "approval.resolved": {
      out.runtimeEvents.push(baseEvent("session.warning_cleared", { warningKind: "approval_needed" }));
      out.attentionIntents.push({
        kind: "approval_needed",
        action: "clear",
        sessionId,
        providerId: event.providerId,
        threadId: event.threadId,
        refId: event.approvalId,
        ts: event.ts,
      });
      out.timelineItems.push(timelineBase("approval", {
        phase: "resolved",
        threadId: event.threadId,
        approvalId: event.approvalId,
        decision: event.decision,
      }));
      break;
    }
    case "context.usage": {
      if (event.percent >= contextHighPercent) {
        out.runtimeEvents.push(baseEvent("session.status", { status: "context_high" }));
        out.runtimeEvents.push(baseEvent("session.warning", {
          warning: {
            kind: "context_high",
            source: event.providerId,
            percent: event.percent,
          },
        }));
        out.attentionIntents.push({
          kind: "context_high",
          action: "raise",
          sessionId,
          providerId: event.providerId,
          threadId: event.threadId,
          severity: "medium",
          ts: event.ts,
        });
      }
      out.timelineItems.push(timelineBase("context_usage", {
        threadId: event.threadId,
        used: event.used,
        total: event.total,
        percent: event.percent,
      }));
      break;
    }
    case "provider.error":
      out.timelineItems.push({
        ...timelineBase("provider_error", {
          ...(event.threadId ? { threadId: event.threadId } : {}),
          ...(event.code ? { code: event.code } : {}),
          message: event.message,
          ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
        }),
        severity: "high",
      });
      break;
  }

  return out;
}
