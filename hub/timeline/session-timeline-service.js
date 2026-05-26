// hub/timeline/session-timeline-service.js - SH-4A-02
//
// Timeline projection over RuntimeEvents, normalized provider timeline rows,
// raw ProviderEvents, repo watcher events, and explicit human overrides. The
// timeline remains a derived view: callers inject the event arrays they have
// from RuntimeStore/provider adapters/watcher logs, and this service returns
// strict TimelineItem[] records with evidenceRef on every item.

import { assertValidTimelineItem } from "./timeline-model.js";

const VALID_PROVIDER_ITEM_KINDS = new Set([
  "message",
  "command",
  "file_change",
  "approval",
  "thread",
  "turn",
  "context_usage",
  "provider_error",
]);

const SESSION_STATUS_TYPES = new Set([
  "session.started",
  "session.status",
  "session.stopped",
  "session.stop.requested",
  "process.signal_sent",
  "process.exited",
  "session.stdio_capture_changed",
  "session.token_rotated",
  "session.token_audit",
  "session.sandbox_changed",
  "session.model_changed",
  "session.task_attached",
  "session.task_unbound",
  "session.interrupt",
  "sandbox.escape_requested",
  "sandbox.escape_resolved",
  "task.new_from_launcher",
]);

const JOB_CHECKPOINT_TYPES = new Set([
  "job.started",
  "job.checkpoint",
  "job.queued",
  "job.unblocked",
  "job.completed",
  "job.rollover_requested",
]);

const VERIFY_TYPES = new Set([
  "verify.command.started",
  "verify.command.completed",
]);

const VERIFY_APPROVAL_TYPES = new Set([
  "verify.human_approval.requested",
  "verify.human_approval.resolved",
]);

const ATTENTION_TYPES = new Set([
  "conflict.ack",
  "attention.ack",
  "attention.snoozed",
  "attention.cleared",
]);

/**
 * @typedef {object} TimelineServiceInput
 * @property {string} sessionId
 * @property {object[]} [runtimeEvents]
 * @property {object[]} [providerTimelineItems]
 * @property {object[]} [providerEvents]
 * @property {object[]} [repoEvents]
 * @property {object[]} [humanOverrides]
 * @property {string} [since]
 * @property {string[]} [kinds]
 * @property {number} [limit]
 */

export class SessionTimelineService {
  /**
   * @param {Omit<TimelineServiceInput, "sessionId"|"since"|"kinds"|"limit">} [input]
   */
  constructor(input = {}) {
    this.runtimeEvents = arrayOrEmpty(input.runtimeEvents);
    this.providerTimelineItems = arrayOrEmpty(input.providerTimelineItems);
    this.providerEvents = arrayOrEmpty(input.providerEvents);
    this.repoEvents = arrayOrEmpty(input.repoEvents);
    this.humanOverrides = arrayOrEmpty(input.humanOverrides);
  }

  /**
   * @param {string} sessionId
   * @param {Omit<TimelineServiceInput, "sessionId">} [input]
   * @returns {object[]}
   */
  buildForSession(sessionId, input = {}) {
    return buildSessionTimeline({
      sessionId,
      runtimeEvents: input.runtimeEvents || this.runtimeEvents,
      providerTimelineItems:
        input.providerTimelineItems || this.providerTimelineItems,
      providerEvents: input.providerEvents || this.providerEvents,
      repoEvents: input.repoEvents || this.repoEvents,
      humanOverrides: input.humanOverrides || this.humanOverrides,
      since: input.since,
      kinds: input.kinds,
      limit: input.limit,
    });
  }
}

/**
 * Build a strict, time-ordered TimelineItem[] for one session.
 *
 * @param {TimelineServiceInput} input
 * @returns {object[]}
 */
export function buildSessionTimeline(input) {
  const sessionId = assertNonEmptyString(input?.sessionId, "sessionId");
  const rows = [];
  let ordinal = 0;

  for (const event of arrayOrEmpty(input.runtimeEvents)) {
    const item = timelineItemFromRuntimeEvent(event, { sessionId, ordinal });
    ordinal += 1;
    if (item) rows.push({ item, ordinal });
  }

  for (const event of arrayOrEmpty(input.repoEvents)) {
    const item = timelineItemFromRuntimeEvent(event, { sessionId, ordinal });
    ordinal += 1;
    if (item) rows.push({ item, ordinal });
  }

  for (const event of arrayOrEmpty(input.humanOverrides)) {
    const item = timelineItemFromRuntimeEvent(event, { sessionId, ordinal });
    ordinal += 1;
    if (item) rows.push({ item, ordinal });
  }

  for (const event of arrayOrEmpty(input.providerEvents)) {
    const item = timelineItemFromProviderEvent(event, { sessionId, ordinal });
    ordinal += 1;
    if (item) rows.push({ item, ordinal });
  }

  for (const providerItem of arrayOrEmpty(input.providerTimelineItems)) {
    const item = timelineItemFromProviderItem(providerItem, {
      sessionId,
      ordinal,
    });
    ordinal += 1;
    if (item) rows.push({ item, ordinal });
  }

  let items = rows
    .map(({ item }, index) => ({ item, index }))
    .sort(compareTimelineRows)
    .map(({ item }) => item);

  if (input.since !== undefined) {
    const sinceMs = Date.parse(input.since);
    if (Number.isNaN(sinceMs)) {
      throw new Error("since must be an ISO-8601 timestamp when present");
    }
    items = items.filter((item) => Date.parse(item.ts) >= sinceMs);
  }

  if (input.kinds !== undefined) {
    const kinds = new Set(arrayOrEmpty(input.kinds));
    items = items.filter((item) => kinds.has(item.kind));
  }

  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 0) {
      throw new Error("limit must be a non-negative integer when present");
    }
    items = items.slice(0, input.limit);
  }

  for (const item of items) {
    assertValidTimelineItem(item);
  }
  return items;
}

/**
 * @param {object} event
 * @param {{sessionId?: string, ordinal?: number}} [options]
 * @returns {object | null}
 */
export function timelineItemFromRuntimeEvent(event, options = {}) {
  if (!isPlainObject(event)) return null;
  const eventType = stringOrNull(event.type);
  if (!eventType || !eventMatchesSession(event, options.sessionId)) return null;

  const ts = assertNonEmptyString(event.ts, "RuntimeEvent.ts");
  const evidenceRef = assertNonEmptyString(event.id, "RuntimeEvent.id");
  const sessionId = resolveSessionId(event, options.sessionId);
  if (!sessionId) return null;

  let kind = "status";
  if (eventType === "session.output") kind = "message";
  else if (eventType === "session.warning" || eventType === "session.warning_cleared") kind = "warning";
  else if (JOB_CHECKPOINT_TYPES.has(eventType)) kind = "checkpoint";
  else if (eventType === "skill.run.started" || eventType === "skill.run.finished") kind = "skill";
  else if (eventType === "repo.change" || eventType === "repo.burst") kind = "repo_change";
  else if (VERIFY_TYPES.has(eventType)) kind = "verify";
  else if (VERIFY_APPROVAL_TYPES.has(eventType)) kind = "approval";
  else if (eventType === "human.override") kind = "status";
  else if (eventType === "session.ask") kind = "handoff";
  else if (ATTENTION_TYPES.has(eventType)) kind = "status";
  else if (!SESSION_STATUS_TYPES.has(eventType)) kind = "checkpoint";

  const item = withOptionalFields({
    id: makeTimelineId("runtime", evidenceRef, eventType, options.ordinal),
    sessionId,
    kind,
    title: titleForRuntimeEvent(event),
    detail: detailForRuntimeEvent(event),
    ts,
    source: sourceForRuntimeEvent(event),
    confidence: confidenceForRuntimeEvent(event),
    evidenceRef,
    jobId: stringOrNull(event.jobId),
    taskId: stringOrNull(event.taskId) || stringOrNull(event.context?.taskId),
    projectSlug:
      stringOrNull(event.projectSlug) || stringOrNull(event.context?.projectSlug),
  });
  assertValidTimelineItem(item);
  return item;
}

/**
 * @param {object} event
 * @param {{sessionId: string, ordinal?: number}} options
 * @returns {object | null}
 */
export function timelineItemFromProviderEvent(event, options) {
  if (!isPlainObject(event)) return null;
  const providerId = stringOrNull(event.providerId);
  const ts = stringOrNull(event.ts);
  const kind = stringOrNull(event.kind);
  if (!providerId || !ts || !kind) return null;

  return timelineItemFromProviderItem(
    {
      sessionId: options.sessionId,
      providerId,
      ts,
      kind: providerItemKindFromProviderEventKind(kind),
      data: providerEventData(event),
      severity: kind === "provider.error" ? "high" : undefined,
      evidenceRef: providerEvidenceRef(event, options.ordinal),
    },
    options,
  );
}

/**
 * Normalize provider-normalizer timeline rows into the strict TimelineItem
 * model. Provider file_change rows remain provider evidence; watcher/git
 * RuntimeEvents create separate repo_change rows.
 *
 * @param {object} providerItem
 * @param {{sessionId?: string, ordinal?: number}} [options]
 * @returns {object | null}
 */
export function timelineItemFromProviderItem(providerItem, options = {}) {
  if (!isPlainObject(providerItem)) return null;
  const sessionId =
    stringOrNull(providerItem.sessionId) || stringOrNull(options.sessionId);
  if (!sessionId || (options.sessionId && sessionId !== options.sessionId)) {
    return null;
  }
  const ts = assertNonEmptyString(providerItem.ts, "providerTimelineItem.ts");
  const providerId = stringOrNull(providerItem.providerId) || "unknown-provider";
  const providerKind = stringOrNull(providerItem.kind) || "checkpoint";
  const data = isPlainObject(providerItem.data) ? providerItem.data : {};
  const evidenceRef =
    stringOrNull(providerItem.evidenceRef) ||
    makeProviderEvidenceRef(providerId, providerKind, ts, data, options.ordinal);
  const kind = timelineKindFromProviderItem(providerKind, data, providerItem);

  if (!VALID_PROVIDER_ITEM_KINDS.has(providerKind)) {
    return null;
  }

  const item = withOptionalFields({
    id: makeTimelineId("provider", evidenceRef, providerKind, options.ordinal),
    sessionId,
    kind,
    title: titleForProviderItem(providerKind, data, providerItem),
    detail: detailForProviderItem(providerKind, data),
    ts,
    source: "provider",
    confidence: "structured",
    evidenceRef,
  });
  assertValidTimelineItem(item);
  return item;
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareTimelineItems(a, b) {
  const byTs = Date.parse(a.ts) - Date.parse(b.ts);
  if (byTs !== 0) return byTs;
  return String(a.id).localeCompare(String(b.id));
}

function compareTimelineRows(a, b) {
  const byTs = Date.parse(a.item.ts) - Date.parse(b.item.ts);
  if (byTs !== 0) return byTs;
  return a.index - b.index;
}

function eventMatchesSession(event, targetSessionId) {
  if (!targetSessionId) return true;
  const ids = collectSessionIds(event);
  return ids.has(targetSessionId);
}

function resolveSessionId(event, targetSessionId) {
  if (targetSessionId) return targetSessionId;
  const ids = collectSessionIds(event);
  return ids.values().next().value || null;
}

function collectSessionIds(event) {
  const ids = new Set();
  if (event.type === "repo.change" || event.type === "repo.burst") {
    addStrings(ids, event.activeSessionIds);
    addStrings(ids, event.possibleSessionIds);
    return ids;
  }
  addString(ids, event.sessionId);
  addString(ids, event.targetSessionId);
  addString(ids, event.to);
  if (isPlainObject(event.session)) addString(ids, event.session.id);
  addStrings(ids, event.activeSessionIds);
  addStrings(ids, event.possibleSessionIds);
  if (isPlainObject(event.context)) addString(ids, event.context.sessionId);
  return ids;
}

function sourceForRuntimeEvent(event) {
  if (event.type === "human.override") return "human";
  if (event.type === "session.output" && (event.stream === "stdout" || event.stream === "stderr")) {
    return "raw_stdio";
  }
  switch (event.source) {
    case "adapter":
      return "provider";
    case "mcp":
      return "mcp";
    case "http":
      return "http";
    case "watcher":
      return "watcher_git";
    case "system":
      return "system";
    case "ui":
    case "cli":
      return "human";
    default:
      return "derived";
  }
}

function confidenceForRuntimeEvent(event) {
  if (event.type === "session.output") return "derived";
  if (event.type === "human.override") return "manual";
  if (event.source === "ui" || event.source === "cli") return "manual";
  if (event.source === "adapter" || event.source === "mcp" || event.source === "http" || event.source === "watcher" || event.source === "system") {
    return "structured";
  }
  return "unknown";
}

function titleForRuntimeEvent(event) {
  switch (event.type) {
    case "session.started":
      return "Session started";
    case "session.status":
      return `Session ${stringOrNull(event.status) || "status changed"}`;
    case "session.warning":
      return `Warning: ${stringOrNull(event.warning?.kind) || "session warning"}`;
    case "session.warning_cleared":
      return `Warning cleared: ${stringOrNull(event.warningKind) || "session warning"}`;
    case "session.output":
      return `${stringOrNull(event.stream) || "session"} output`;
    case "session.stopped":
      return "Session stopped";
    case "session.stop.requested":
      return "Stop requested";
    case "process.signal_sent":
      return `Signal sent${stringOrNull(event.signal) ? `: ${event.signal}` : ""}`;
    case "process.exited":
      return "Process exited";
    case "session.stdio_capture_changed":
      return "Stdio capture changed";
    case "session.sandbox_changed":
      return "Sandbox changed";
    case "session.model_changed":
      return "Model changed";
    case "session.task_attached":
      return "Task attached";
    case "session.task_unbound":
      return "Task unbound";
    case "job.started":
      return "Job started";
    case "job.queued":
      return "Job queued";
    case "job.checkpoint":
      return stringOrNull(event.summary) || "Job checkpoint";
    case "job.unblocked":
      return "Job unblocked";
    case "job.completed":
      return `Job ${stringOrNull(event.status) || "completed"}`;
    case "job.rollover_requested":
      return "Job rollover requested";
    case "skill.run.started":
      return `Skill started: ${stringOrNull(event.skillId) || "unknown"}`;
    case "skill.run.finished":
      return `Skill finished: ${stringOrNull(event.skillId) || "unknown"}`;
    case "repo.change":
      return `Repo ${stringOrNull(event.event) || "change"}: ${stringOrNull(event.path) || "unknown path"}`;
    case "repo.burst":
      return `Repo burst: ${Number.isInteger(event.fileCount) ? event.fileCount : 0} files`;
    case "verify.command.started":
      return "Verify command started";
    case "verify.command.completed":
      return `Verify command ${stringOrNull(event.status) || "completed"}`;
    case "verify.human_approval.requested":
      return stringOrNull(event.title) || "Verify approval requested";
    case "verify.human_approval.resolved":
      return `Verify approval ${stringOrNull(event.decision) || "resolved"}`;
    case "human.override":
      return "Human override";
    case "session.ask":
      return "Session handoff request";
    case "attention.ack":
      return "Attention acknowledged";
    case "attention.snoozed":
      return "Attention snoozed";
    case "attention.cleared":
      return "Attention cleared";
    case "conflict.ack":
      return "Conflict acknowledged";
    case "sandbox.escape_requested":
      return "Sandbox escape requested";
    case "sandbox.escape_resolved":
      return "Sandbox escape resolved";
    case "task.new_from_launcher":
      return "Task created from launcher";
    default:
      return stringOrNull(event.type) || "Runtime event";
  }
}

function detailForRuntimeEvent(event) {
  switch (event.type) {
    case "session.output":
      return preview(event.text || event.data || event.output);
    case "session.warning":
      return preview(event.warning?.message || event.warning?.source);
    case "job.checkpoint":
    case "job.completed":
      return preview(event.summary);
    case "repo.change":
      return preview(
        [
          stringOrNull(event.repoRoot),
          event.outsideAllowedPaths === true ? "outside allowed paths" : null,
        ]
          .filter(Boolean)
          .join(" | "),
      );
    case "repo.burst":
      return preview(arrayOrEmpty(event.samplePaths).join(", "));
    case "verify.command.started":
    case "verify.command.completed":
      return preview(event.command || event.stderrPreview || event.stdoutPreview);
    case "human.override":
      return preview(event.reason);
    case "session.ask":
      return preview(event.prompt);
    default:
      return undefined;
  }
}

function providerItemKindFromProviderEventKind(kind) {
  if (kind.startsWith("thread.")) return "thread";
  if (kind.startsWith("turn.")) return "turn";
  if (kind.startsWith("command.")) return "command";
  if (kind.startsWith("file_change.")) return "file_change";
  if (kind.startsWith("approval.")) return "approval";
  if (kind === "context.usage") return "context_usage";
  if (kind === "provider.error") return "provider_error";
  return kind;
}

function providerEventData(event) {
  const kind = stringOrNull(event.kind) || "";
  const phase = kind.includes(".") ? kind.split(".").at(-1) : undefined;
  const data = { ...event };
  delete data.kind;
  delete data.providerId;
  delete data.ts;
  if (phase) data.phase = phase;
  return data;
}

function providerEvidenceRef(event, ordinal) {
  return makeProviderEvidenceRef(
    stringOrNull(event.providerId) || "unknown-provider",
    stringOrNull(event.kind) || "provider",
    stringOrNull(event.ts) || "unknown-ts",
    providerEventData(event),
    ordinal,
  );
}

function timelineKindFromProviderItem(providerKind, data, providerItem) {
  switch (providerKind) {
    case "message":
    case "command":
    case "file_change":
    case "approval":
      return providerKind;
    case "thread":
    case "turn":
      return "checkpoint";
    case "context_usage":
      return data.percent >= 80 || providerItem.severity === "high" ? "warning" : "status";
    case "provider_error":
      return "warning";
    default:
      return "checkpoint";
  }
}

function titleForProviderItem(providerKind, data) {
  switch (providerKind) {
    case "message": {
      const role = stringOrNull(data.role) || "provider";
      const text = preview(data.text);
      return text ? `${role}: ${text}` : `${role} message`;
    }
    case "command": {
      const phase = stringOrNull(data.phase) || "event";
      if (phase === "started") return `Command started: ${preview(data.command) || "command"}`;
      if (phase === "output") return `Command output: ${stringOrNull(data.stream) || "stream"}`;
      if (phase === "completed") return `Command completed${Number.isInteger(data.exitCode) ? `: exit ${data.exitCode}` : ""}`;
      return `Command ${phase}`;
    }
    case "file_change": {
      const phase = stringOrNull(data.phase) || "reported";
      const files = arrayOrEmpty(data.files).slice(0, 3).join(", ");
      return files ? `File change ${phase}: ${files}` : `File change ${phase}`;
    }
    case "approval": {
      const phase = stringOrNull(data.phase) || "updated";
      if (phase === "requested") return `Approval requested: ${stringOrNull(data.title) || "provider approval"}`;
      if (phase === "resolved") return `Approval ${stringOrNull(data.decision) || "resolved"}`;
      return `Approval ${phase}`;
    }
    case "thread":
      return `Thread ${stringOrNull(data.phase) || "updated"}`;
    case "turn":
      return `Turn ${stringOrNull(data.phase) || "updated"}`;
    case "context_usage":
      return `Context usage${Number.isFinite(data.percent) ? ` ${data.percent}%` : ""}`;
    case "provider_error":
      return `Provider error: ${preview(data.message) || "unknown error"}`;
    default:
      return "Provider event";
  }
}

function detailForProviderItem(providerKind, data) {
  switch (providerKind) {
    case "message":
    case "command":
      return preview(data.text || data.command);
    case "file_change":
      return preview(data.summary || arrayOrEmpty(data.files).join(", "));
    case "approval":
      return preview(data.detail || data.title || data.decision);
    case "provider_error":
      return preview(data.code || data.message);
    default:
      return undefined;
  }
}

function makeProviderEvidenceRef(providerId, providerKind, ts, data, ordinal) {
  const ref =
    stringOrNull(data.commandId) ||
    stringOrNull(data.proposalId) ||
    stringOrNull(data.approvalId) ||
    stringOrNull(data.turnId) ||
    stringOrNull(data.threadId) ||
    stringOrNull(data.threadRef?.threadId) ||
    String(ordinal || 0);
  return `provider:${providerId}:${providerKind}:${ref}:${ts}`;
}

function makeTimelineId(scope, evidenceRef, kind, ordinal) {
  return `tl_${scope}_${stableToken(`${evidenceRef}:${kind}:${ordinal || 0}`)}`;
}

function stableToken(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function withOptionalFields(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function preview(value, max = 240) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} required`);
  }
  return value;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function addString(ids, value) {
  if (typeof value === "string" && value.length > 0) ids.add(value);
}

function addStrings(ids, value) {
  if (!Array.isArray(value)) return;
  for (const item of value) addString(ids, item);
}
