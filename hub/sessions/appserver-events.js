// hub/sessions/appserver-events.js
//
// Codex App Server JSON-RPC notification router. This layer accepts server
// push notifications, maps the known App Server shapes into provider-neutral
// events and optional RuntimeEvent bundles, and drops unknown notifications
// with a log line instead of throwing.

import { normalize as normalizeProviderEvent } from "../providers/normalizer.js";

export const CODEX_APP_SERVER_PROVIDER_ID = "codex_app_server";

export const TDD_APP_SERVER_EVENT_METHODS = Object.freeze([
  "thread.message",
  "thread.status",
  "thread.approval",
  "thread.approval_resolved",
  "thread.context_usage",
  "thread.error",
]);

export const SCHEMA_ALIAS_APP_SERVER_EVENT_METHODS = Object.freeze([
  "thread.created",
  "thread.item",
  "thread.completed",
  "thread.failed",
  "provider.warning",
]);

export const DEFAULT_APP_SERVER_EVENT_METHODS = Object.freeze([
  ...TDD_APP_SERVER_EVENT_METHODS,
  ...SCHEMA_ALIAS_APP_SERVER_EVENT_METHODS,
]);

export const APP_SERVER_EVENT_NORMALIZATION_TABLE = Object.freeze([
  Object.freeze({ method: "thread.message", runtimeEvent: "session.output", note: "structured chat output" }),
  Object.freeze({ method: "thread.status", status: "running", runtimeEvent: "session.status", value: "active" }),
  Object.freeze({ method: "thread.status", status: "idle", runtimeEvent: "session.status", value: "idle" }),
  Object.freeze({ method: "thread.status", status: "blocked", runtimeEvent: "session.status", value: "blocked" }),
  Object.freeze({ method: "thread.status", status: "completed", runtimeEvent: "session.status", value: "done" }),
  Object.freeze({ method: "thread.approval", runtimeEvent: "session.status", value: "waiting_for_approval" }),
  Object.freeze({ method: "thread.approval", runtimeEvent: "session.warning", value: "approval_needed" }),
  Object.freeze({ method: "thread.approval_resolved", runtimeEvent: "session.warning_cleared", value: "approval_needed" }),
  Object.freeze({ method: "thread.context_usage", condition: "percent >= threshold", runtimeEvent: "session.status", value: "context_high" }),
  Object.freeze({ method: "thread.context_usage", condition: "percent >= threshold", runtimeEvent: "session.warning", value: "context_high" }),
  Object.freeze({ method: "thread.error", runtimeEvent: "provider.error", note: "provider warning/timeline only; activity state unchanged" }),
]);

const STATUS_TO_SESSION_STATUS = Object.freeze({
  running: "active",
  idle: "idle",
  blocked: "blocked",
  completed: "done",
});

export function createAppServerEventRouter(opts = {}) {
  return new AppServerEventRouter(opts);
}

export class AppServerEventRouter {
  constructor({
    schemaValidator,
    eventMethods,
    providerId = CODEX_APP_SERVER_PROVIDER_ID,
    sessionResolver,
    emit,
    log,
    runtime,
    now = () => new Date(),
    contextHighPercent,
  } = {}) {
    this.providerId = text(providerId) || CODEX_APP_SERVER_PROVIDER_ID;
    this.sessionResolver = typeof sessionResolver === "function" ? sessionResolver : defaultSessionResolver;
    this.emit = typeof emit === "function" ? emit : null;
    this.log = loggerOrConsole(log);
    this.runtime = runtime || null;
    this.now = typeof now === "function" ? now : () => new Date();
    this.contextHighPercent = Number.isFinite(contextHighPercent) ? contextHighPercent : undefined;
    this.schemaEventMethods = new Set(arrayOfStrings(schemaValidator?.events));
    this.methods = new Set([
      ...DEFAULT_APP_SERVER_EVENT_METHODS,
      ...arrayOfStrings(eventMethods),
    ]);
  }

  handles(method) {
    return this.methods.has(method);
  }

  route(notification, overrides = {}) {
    const method = notificationMethod(notification);
    if (!this.handles(method)) {
      this._logUnknown(notification);
      return {
        ok: true,
        handled: false,
        ignored: true,
        reason: "unknown_event",
        method,
        providerEvents: [],
        runtimeEvents: [],
        attentionIntents: [],
        timelineItems: [],
      };
    }

    const normalized = normalizeAppServerNotification(notification, {
      providerId: this.providerId,
      sessionResolver: overrides.sessionResolver || this.sessionResolver,
      runtime: overrides.runtime || this.runtime,
      now: overrides.now || this.now,
      contextHighPercent: overrides.contextHighPercent ?? this.contextHighPercent,
    });

    if (this.emit) this.emit(normalized);
    return normalized;
  }

  _logUnknown(notification) {
    const method = notificationMethod(notification) || "(missing)";
    const message = `Codex App Server notification ignored: unknown method '${method}'`;
    if (typeof this.log.warn === "function") {
      this.log.warn(message, { method, notification });
    }
  }
}

export function normalizeAppServerNotification(notification, {
  providerId = CODEX_APP_SERVER_PROVIDER_ID,
  sessionResolver = defaultSessionResolver,
  runtime,
  now = () => new Date(),
  contextHighPercent,
} = {}) {
  const method = notificationMethod(notification);
  const params = record(notification?.params);
  const ts = stringOr(params.ts, isoNow(now));
  const threadId = stringOr(params.threadId || params.id || params.thread?.id);
  const sessionId = stringOr(sessionResolver({ method, params, notification }));
  const providerEvents = providerEventsForNotification(method, params, { providerId, ts, threadId });
  const runtimeEvents = directRuntimeEventsForNotification(method, params, {
    providerId,
    ts,
    threadId,
    sessionId,
    runtime,
  });
  const normalized = normalizeProviderEvents(providerEvents, {
    runtime,
    sessionId,
    contextHighPercent,
  });
  const directAttentionIntents = directAttentionIntentsForNotification(method, params, {
    providerId,
    ts,
    threadId,
    sessionId,
  });

  return {
    ok: true,
    handled: true,
    ignored: false,
    method,
    threadId,
    sessionId,
    mappingRows: normalizationRowsForNotification(method, params),
    providerEvents,
    runtimeEvents: [...runtimeEvents, ...normalized.runtimeEvents],
    attentionIntents: [...directAttentionIntents, ...normalized.attentionIntents],
    timelineItems: normalized.timelineItems,
  };
}

export function providerEventsForNotification(method, params, { providerId, ts, threadId } = {}) {
  switch (method) {
    case "thread.message":
      return [{
        kind: "message",
        providerId,
        ts,
        threadId,
        role: messageRole(params.role),
        text: stringOr(params.content),
      }];
    case "thread.approval":
      if (isSandboxApproval(params)) return [];
      return [{
        kind: "approval.requested",
        providerId,
        ts,
        threadId,
        approvalId: stringOr(params.approvalId),
        title: approvalTitle(params),
        ...(params.action ? { detail: JSON.stringify(params.action) } : {}),
      }];
    case "thread.approval_resolved":
      if (isSandboxApproval(params)) return [];
      return [{
        kind: "approval.resolved",
        providerId,
        ts,
        threadId,
        approvalId: stringOr(params.approvalId),
        decision: approvalDecision(params.decision),
      }];
    case "thread.context_usage":
      return [{
        kind: "context.usage",
        providerId,
        ts,
        threadId,
        used: numberOr(params.used, 0),
        total: positiveNumberOr(params.total, 1),
        percent: boundedPercent(params.percent),
      }];
    case "thread.error":
      return [{
        kind: "provider.error",
        providerId,
        ts,
        threadId,
        code: stringOr(params.code),
        message: stringOr(params.message, "Codex App Server thread error"),
        retryable: params.retryable === true,
      }];
    case "thread.created":
      return [{
        kind: "thread.started",
        providerId,
        ts,
        threadRef: { ...params, threadId },
      }];
    case "thread.item":
      return providerEventsForItem(params, { providerId, ts, threadId });
    case "thread.completed":
      return turnId(params)
        ? [{
            kind: "turn.completed",
            providerId,
            ts,
            threadId,
            turnId: turnId(params),
            status: "succeeded",
          }]
        : [];
    case "thread.failed":
      return [{
        kind: "provider.error",
        providerId,
        ts,
        threadId,
        code: stringOr(params.code, "thread_failed"),
        message: stringOr(params.message, "Codex App Server thread failed"),
        retryable: params.retryable === true,
      }];
    case "provider.warning":
      return [{
        kind: "provider.error",
        providerId,
        ts,
        code: stringOr(params.code, "provider_warning"),
        message: stringOr(params.message, "Codex App Server provider warning"),
        retryable: params.retryable === true,
      }];
    default:
      return [];
  }
}

function directRuntimeEventsForNotification(method, params, { providerId, ts, threadId, sessionId, runtime } = {}) {
  if (!sessionId || !runtime?.workspace) return [];
  const base = (type, extra) => ({
    schemaVersion: 1,
    ts,
    type,
    source: "adapter",
    workspace: runtime.workspace,
    sessionId,
    providerId,
    threadId,
    ...extra,
  });

  switch (method) {
    case "thread.message":
      return [base("session.output", {
        stream: "structured",
        preview: stringOr(params.content),
        role: messageRole(params.role),
      })];
    case "thread.status": {
      const status = STATUS_TO_SESSION_STATUS[params.status];
      if (!status) return [];
      return [base("session.status", {
        status,
        ...(params.reason ? { reason: String(params.reason) } : {}),
      })];
    }
    case "thread.approval":
      if (!isSandboxApproval(params)) return [];
      return [base("sandbox.escape_requested", {
        approvalId: stringOr(params.approvalId),
        action: record(params.action),
        message: approvalTitle(params),
        sandbox: sandboxApprovalMode(params),
      })];
    case "thread.approval_resolved":
      if (!isSandboxApproval(params)) return [];
      return [base("sandbox.escape_resolved", {
        approvalId: stringOr(params.approvalId),
        decision: approvalDecision(params.decision),
        sandbox: sandboxApprovalMode(params),
      })];
    case "thread.completed":
      return [base("session.status", { status: "done" })];
    case "thread.failed":
      return [base("session.status", {
        status: "blocked",
        reason: stringOr(params.message || params.code, "Codex App Server thread failed"),
      })];
    default:
      return [];
  }
}

function directAttentionIntentsForNotification(method, params, { providerId, ts, threadId, sessionId } = {}) {
  if (method === "thread.approval" && isSandboxApproval(params)) {
    return [{
      kind: "sandbox_escape_requested",
      action: "raise",
      sessionId,
      providerId,
      threadId,
      refId: stringOr(params.approvalId),
      severity: "critical",
      title: approvalTitle(params),
      ts,
      warning: sandboxEscapeWarning(params, { providerId, threadId, sessionId }),
    }];
  }
  if (method === "thread.approval_resolved" && isSandboxApproval(params)) {
    return [{
      kind: "sandbox_escape_requested",
      action: "clear",
      sessionId,
      providerId,
      threadId,
      refId: stringOr(params.approvalId),
      ts,
    }];
  }
  if (method !== "thread.error" && method !== "thread.failed" && method !== "provider.warning") return [];
  if (!sessionId) return [];
  return [{
    kind: "provider_error",
    action: "raise",
    sessionId,
    providerId,
    threadId,
    refId: stringOr(params.code || params.errorId || params.id),
    severity: params.retryable === true ? "low" : "medium",
    title: stringOr(params.message || params.code, "Codex App Server provider warning"),
    ts,
  }];
}

function normalizationRowsForNotification(method, params = {}) {
  if (method === "thread.status") {
    return APP_SERVER_EVENT_NORMALIZATION_TABLE.filter((row) => row.method === method && row.status === params.status);
  }
  if (method === "thread.context_usage") {
    const percent = boundedPercent(params.percent);
    return APP_SERVER_EVENT_NORMALIZATION_TABLE.filter((row) => {
      if (row.method !== method) return false;
      if (!row.condition) return true;
      return percent >= 0;
    });
  }
  return APP_SERVER_EVENT_NORMALIZATION_TABLE.filter((row) => row.method === method);
}

function normalizeProviderEvents(providerEvents, { runtime, sessionId, contextHighPercent } = {}) {
  const out = {
    runtimeEvents: [],
    attentionIntents: [],
    timelineItems: [],
  };
  if (!runtime?.workspace || typeof runtime.makeRuntimeId !== "function" || !sessionId) {
    return out;
  }
  for (const event of providerEvents) {
    const result = normalizeProviderEvent(event, {
      sessionId,
      workspace: runtime.workspace,
      makeRuntimeId: runtime.makeRuntimeId,
      ...(runtime.now ? { now: runtime.now } : {}),
      ...(contextHighPercent !== undefined ? { contextHighPercent } : {}),
    });
    out.runtimeEvents.push(...result.runtimeEvents);
    out.attentionIntents.push(...result.attentionIntents);
    out.timelineItems.push(...result.timelineItems);
  }
  return out;
}

function providerEventsForItem(params, { providerId, ts, threadId }) {
  const item = record(params.item || params);
  const content = stringOr(item.content || item.text || params.content);
  if (content) {
    return [{
      kind: "message",
      providerId,
      ts,
      threadId,
      role: messageRole(item.role || params.role),
      text: content,
    }];
  }
  return [];
}

function notificationMethod(notification) {
  return typeof notification?.method === "string" ? notification.method : "";
}

function defaultSessionResolver({ params } = {}) {
  return stringOr(params?.sessionId);
}

function approvalTitle(params) {
  const action = record(params.action);
  return stringOr(action.summary || params.summary || params.title, "Codex approval requested");
}

function isSandboxApproval(params) {
  const action = record(params.action);
  const kind = stringOr(action.kind || params.kind || params.actionKind || params.type);
  return kind === "sandbox" || kind === "sandbox_escape" || kind === "sandbox_escape_requested";
}

function sandboxApprovalMode(params) {
  const action = record(params.action);
  return stringOr(action.sandbox || action.mode || params.sandbox || params.mode, "escalated");
}

function sandboxEscapeWarning(params, { providerId, threadId, sessionId } = {}) {
  return {
    kind: "sandbox_escape_requested",
    source: providerId,
    actionId: stringOr(params.approvalId),
    approvalId: stringOr(params.approvalId),
    threadId,
    sessionId,
    message: approvalTitle(params),
    sandbox: sandboxApprovalMode(params),
  };
}

function approvalDecision(value) {
  if (value === "approved" || value === "denied" || value === "cancelled") return value;
  return "cancelled";
}

function messageRole(value) {
  if (value === "assistant" || value === "tool" || value === "user" || value === "system") return value;
  return "assistant";
}

function turnId(params) {
  return stringOr(params.turnId || params.id);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function stringOr(value, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveNumberOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function isoNow(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function loggerOrConsole(log) {
  return log && typeof log === "object" ? log : console;
}
