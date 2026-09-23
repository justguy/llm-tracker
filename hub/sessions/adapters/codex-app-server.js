// hub/sessions/adapters/codex-app-server.js
//
// Codex App Server session adapter for schema-driven RPC calls plus
// event-subscription routing.

import { CodexRpcSessionAdapter } from "./codex-rpc.js";
import {
  CODEX_APP_SERVER_PROVIDER_ID,
  createAppServerEventRouter,
} from "../appserver-events.js";

export const CODEX_RPC_EVENTS_SUBSCRIBE_METHOD = "events.subscribe";
export const DEFAULT_CODEX_RPC_EVENT_FILTER = Object.freeze(["thread.*", "approval.*", "context.*"]);
export const CODEX_APP_SERVER_THREAD_METHODS = Object.freeze({
  create: Object.freeze(["threads.create", "thread/start", "thread.start"]),
  resume: Object.freeze(["threads.resume", "thread/resume", "thread.resume"]),
  list: Object.freeze(["threads.list", "thread/list", "thread.list"]),
  send: Object.freeze(["threads.send", "turn/start", "turn.start"]),
  cancel: Object.freeze(["threads.cancel", "turn/cancel", "turn.cancel", "turn.interrupt"]),
  contextUsage: Object.freeze(["threads.context_usage", "threads.contextUsage", "thread/context_usage", "thread.context_usage"]),
  approvalResolve: Object.freeze(["approvals.resolve", "approvals.respond", "approval/resolve", "approval/respond"]),
});

export function createCodexAppServerSessionAdapter(opts = {}) {
  return new CodexAppServerSessionAdapter(opts);
}

export class CodexAppServerSessionAdapter extends CodexRpcSessionAdapter {
  constructor({
    eventFilter = DEFAULT_CODEX_RPC_EVENT_FILTER,
    subscribeMethod,
    router,
    routerOptions,
    log,
    ...baseOptions
  } = {}) {
    super(baseOptions);
    this.kind = "codex_app_server";
    this.eventFilter = Object.freeze(arrayOfStrings(eventFilter));
    this.availableMethods = Object.freeze(arrayOfStrings(baseOptions.schemaValidator?.methods || baseOptions.rpcClient?.methods || []));
    this.threadMethods = Object.freeze(selectThreadMethods(this.availableMethods));
    this.subscribeMethod = subscribeMethod || selectEventsSubscribeMethod({
      methods: this.availableMethods,
    });
    this.log = log || null;
    this.router = router || createAppServerEventRouter({
      schemaValidator: baseOptions.schemaValidator,
      providerId: CODEX_APP_SERVER_PROVIDER_ID,
      log,
      ...routerOptions,
    });
    this._eventUnsubscribe = null;
    this._subscription = null;
    this._lastReconciliation = null;
  }

  async connect(params = {}) {
    const hello = await this.hello(params);
    const subscription = await this.subscribeEvents();
    return { hello, subscription };
  }

  async subscribeEvents(params = {}) {
    const client = this._client();
    this._wireEvents(client);
    const response = await client.call(this.subscribeMethod, {
      filter: this.eventFilter,
      ...(isRecord(params) ? params : {}),
    });
    this._subscription = Object.freeze({
      method: this.subscribeMethod,
      filter: [...this.eventFilter],
      response: clonePlain(response),
    });
    return this._subscription;
  }

  async createThread(params = {}) {
    return this._callThreadMethod("create", recordParams(params));
  }

  async resumeThread(threadRef, params = {}) {
    const ref = normalizeThreadRef(threadRef, "resumeThread");
    const extra = recordParams(params);
    if (this.hasCapability("threadResume") && this.threadMethods.resume) {
      return this._callThreadMethod("resume", {
        ...extra,
        ...ref,
      });
    }
    return this._callThreadMethod("create", {
      ...extra,
      resumeOf: ref,
      fallbackMode: "successor_spawn",
    });
  }

  async listThreads(params = {}) {
    return this._callThreadMethod("list", recordParams(params));
  }

  async reconnect(params = {}) {
    const client = this._client();
    if (typeof client.connect === "function") await client.connect();
    return this.reconcileThreads(params);
  }

  async reconcileThreads({
    sessions = [],
    knownThreads,
    runtime,
    now = this.now,
    ...listParams
  } = {}) {
    const response = await this.listThreads(recordParams(listParams));
    const liveThreadIds = new Set(extractThreadRefs(response).map((thread) => thread.threadId));
    const sessionBindings = normalizeSessionBindings(sessions, knownThreads);
    const unknownSessions = sessionBindings.filter((binding) => !liveThreadIds.has(binding.threadId));
    const ts = isoFromNow(now);
    const result = Object.freeze({
      response: clonePlain(response),
      liveThreadIds: Object.freeze([...liveThreadIds]),
      unknownSessions: Object.freeze(unknownSessions.map((binding) => Object.freeze({ ...binding }))),
      runtimeEvents: Object.freeze(unknownSessions.map((binding) => sessionUnknownEvent(binding, { runtime, ts }))),
      attentionIntents: Object.freeze(unknownSessions.map((binding) => unboundSessionIntent(binding, { ts }))),
    });
    this._lastReconciliation = result;
    return result;
  }

  async sendThread(threadId, message = {}) {
    return this._callThreadMethod("send", {
      ...messageParams(message),
      threadId: requiredString(threadId, "sendThread: threadId required"),
    });
  }

  async cancelThread(threadId, params = {}) {
    return this._callThreadMethod("cancel", {
      ...recordParams(params),
      threadId: requiredString(threadId, "cancelThread: threadId required"),
    });
  }

  async contextUsage(threadId, params = {}) {
    return this._callThreadMethod("contextUsage", {
      ...recordParams(params),
      threadId: requiredString(threadId, "contextUsage: threadId required"),
    });
  }

  async resolveApproval(approvalId, decision, params = {}) {
    return this._callThreadMethod("approvalResolve", {
      ...recordParams(params),
      approvalId: requiredString(approvalId, "resolveApproval: approvalId required"),
      decision: requiredString(decision, "resolveApproval: decision required"),
    });
  }

  methodAvailable(method) {
    return this.availableMethods.includes(method);
  }

  handleNotification(notification, overrides = {}) {
    return this.router.route(notification, overrides);
  }

  lastSubscription() {
    return this._subscription;
  }

  lastReconciliation() {
    return this._lastReconciliation;
  }

  async close() {
    if (this._eventUnsubscribe) {
      this._eventUnsubscribe();
      this._eventUnsubscribe = null;
    }
    await super.close();
  }

  async _callThreadMethod(key, params = {}) {
    const method = this.threadMethods[key];
    if (!method) {
      throw adapterError(
        `Codex RPC schema does not expose a ${key} method`,
        "CODEX_RPC_METHOD_UNAVAILABLE",
        { key, methods: this.availableMethods },
      );
    }
    return this._client().call(method, params);
  }

  _wireEvents(client) {
    if (this._eventUnsubscribe) return;
    if (!client || typeof client.onEvent !== "function") {
      throw new TypeError("CodexAppServerSessionAdapter: rpcClient.onEvent required");
    }
    this._eventUnsubscribe = client.onEvent((notification) => {
      this.handleNotification(notification);
    });
  }
}

export function selectEventsSubscribeMethod({ methods = [] } = {}) {
  const candidates = arrayOfStrings(methods);
  if (candidates.includes(CODEX_RPC_EVENTS_SUBSCRIBE_METHOD)) return CODEX_RPC_EVENTS_SUBSCRIBE_METHOD;
  const dotted = candidates.find((method) => method.endsWith(".events.subscribe") || method.endsWith("events.subscribe"));
  if (dotted) return dotted;
  throw adapterError(
    "Codex RPC schema does not expose an events.subscribe method",
    "CODEX_RPC_EVENTS_SUBSCRIBE_UNAVAILABLE",
    { methods: candidates },
  );
}

export function selectThreadMethods(methods = []) {
  const candidates = arrayOfStrings(methods);
  return {
    create: selectAppServerMethod(candidates, CODEX_APP_SERVER_THREAD_METHODS.create),
    resume: selectAppServerMethod(candidates, CODEX_APP_SERVER_THREAD_METHODS.resume),
    list: selectAppServerMethod(candidates, CODEX_APP_SERVER_THREAD_METHODS.list),
    send: selectAppServerMethod(candidates, CODEX_APP_SERVER_THREAD_METHODS.send),
    cancel: selectAppServerMethod(candidates, CODEX_APP_SERVER_THREAD_METHODS.cancel),
    contextUsage: selectAppServerMethod(candidates, CODEX_APP_SERVER_THREAD_METHODS.contextUsage),
    approvalResolve: selectAppServerMethod(candidates, CODEX_APP_SERVER_THREAD_METHODS.approvalResolve),
  };
}

function selectAppServerMethod(methods, aliases) {
  for (const alias of aliases) {
    if (methods.includes(alias)) return alias;
  }
  return null;
}

function recordParams(value) {
  return isRecord(value) ? { ...value } : {};
}

function normalizeThreadRef(value, caller) {
  if (typeof value === "string") return { threadId: requiredString(value, `${caller}: threadId required`) };
  if (!isRecord(value)) throw new TypeError(`${caller}: threadRef required`);
  const out = { ...value };
  const id = out.threadId || out.id;
  if (typeof id === "string" && id) out.threadId = id;
  if (!out.threadId) throw new TypeError(`${caller}: threadId required`);
  return out;
}

function messageParams(value) {
  if (typeof value === "string") return { content: value };
  return recordParams(value);
}

function extractThreadRefs(response) {
  const candidates = Array.isArray(response)
    ? response
    : Array.isArray(response?.threads)
      ? response.threads
      : Array.isArray(response?.items)
        ? response.items
        : Array.isArray(response?.result?.threads)
          ? response.result.threads
          : [];
  return candidates
    .map((thread) => normalizeThreadListEntry(thread))
    .filter((thread) => thread.threadId);
}

function normalizeThreadListEntry(thread) {
  if (typeof thread === "string") return { threadId: thread };
  if (!isRecord(thread)) return { threadId: "" };
  const id = thread.threadId || thread.id || thread.thread?.id;
  return {
    ...thread,
    threadId: typeof id === "string" ? id : "",
  };
}

function normalizeSessionBindings(sessions, knownThreads) {
  const source = Array.isArray(knownThreads) ? knownThreads : sessions;
  return source.map((entry) => {
    const session = isRecord(entry) ? entry : {};
    const threadRef = isRecord(session.threadRef) ? session.threadRef : {};
    const threadId = session.threadId || session.providerThreadId || threadRef.threadId || threadRef.id;
    const sessionId = session.sessionId || session.id;
    return {
      sessionId: typeof sessionId === "string" ? sessionId : "",
      threadId: typeof threadId === "string" ? threadId : "",
      projectSlug: typeof session.projectSlug === "string" ? session.projectSlug : undefined,
      taskId: typeof session.taskId === "string" ? session.taskId : undefined,
    };
  }).filter((binding) => binding.sessionId && binding.threadId);
}

function sessionUnknownEvent(binding, { runtime, ts }) {
  return {
    schemaVersion: 1,
    ts,
    type: "session.status",
    source: "adapter",
    workspace: runtime?.workspace || "",
    sessionId: binding.sessionId,
    status: "unknown",
    reason: `Codex App Server thread '${binding.threadId}' missing after reconnect`,
    threadId: binding.threadId,
  };
}

function unboundSessionIntent(binding, { ts }) {
  return {
    kind: "unbound_session",
    action: "raise",
    sessionId: binding.sessionId,
    refId: binding.threadId,
    severity: "high",
    title: "Session thread missing after reconnect",
    ts,
    ...(binding.projectSlug ? { projectSlug: binding.projectSlug } : {}),
    ...(binding.taskId ? { taskId: binding.taskId } : {}),
  };
}

function isoFromNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  return new Date(value || Date.now()).toISOString();
}

function requiredString(value, message) {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(message);
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clonePlain(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function adapterError(message, code, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}
