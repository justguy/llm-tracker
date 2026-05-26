import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  SESSION_CARD_SIZES,
  SessionCard,
  normalizeSessionCardSize,
} from "./SessionCard.js";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSessionList(sessions) {
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((session) => isRecord(session) && typeof session.id === "string" && session.id.length > 0);
}

function upsertSession(sessions, id, updater) {
  if (typeof id !== "string" || id.length === 0) return sessions;
  const list = normalizeSessionList(sessions);
  const index = list.findIndex((session) => session.id === id);
  if (index === -1) return list;
  const nextSession = updater(list[index]);
  if (!isRecord(nextSession)) return list;
  const next = list.slice();
  next[index] = nextSession;
  return next;
}

function sourceFromEvent(event) {
  return { kind: event.source, eventId: event.id, eventType: event.type };
}

function appendUniqueJobId(values, jobId) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === "string" && value.length > 0 && !out.includes(value)) out.push(value);
  }
  if (typeof jobId === "string" && jobId.length > 0 && !out.includes(jobId)) out.push(jobId);
  return out;
}

function removeJobId(values, jobId) {
  return appendUniqueJobId(values, null).filter((value) => value !== jobId);
}

export const TASK_DROP_MIME = "application/x-llm-tracker-task";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readTransferData(transfer, type) {
  try {
    return typeof transfer?.getData === "function" ? transfer.getData(type) : "";
  } catch {
    return "";
  }
}

function parseTaskDropPayload(value) {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        return {
          taskId: nonEmptyString(parsed.taskId || parsed.id),
          projectSlug: nonEmptyString(parsed.projectSlug || parsed.slug),
        };
      }
    } catch {
      return null;
    }
  }
  return { taskId: raw, projectSlug: null };
}

function transferTypes(transfer) {
  if (!transfer?.types) return [];
  return Array.from(transfer.types);
}

export function eventHasTaskDropData(event) {
  const types = transferTypes(event?.dataTransfer);
  return types.includes(TASK_DROP_MIME) || types.includes("application/json") || types.includes("text/plain");
}

export function taskDropPayloadFromEvent(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) return null;
  for (const type of [TASK_DROP_MIME, "application/json", "text/plain"]) {
    const payload = parseTaskDropPayload(readTransferData(transfer, type));
    if (payload?.taskId) return payload;
  }
  return null;
}

export function buildTaskDropPreflightIntent({ event, session = null, projectSlug = "" } = {}) {
  const payload = taskDropPayloadFromEvent(event);
  const taskId = payload?.taskId;
  if (!taskId) return null;
  const targetProjectSlug =
    payload.projectSlug ||
    nonEmptyString(session?.projectSlug) ||
    nonEmptyString(projectSlug) ||
    null;
  const sessionId = nonEmptyString(session?.id);
  if (sessionId) {
    return {
      kind: "attach_existing",
      source: "task_drop",
      taskId,
      projectSlug: targetProjectSlug,
      sessionId,
    };
  }
  return {
    kind: "new_session",
    source: "task_drop",
    taskId,
    projectSlug: targetProjectSlug,
    sessionId: null,
  };
}

async function parseJsonBody(response) {
  return response.json().catch(() => ({}));
}

function parseApiError(body, response) {
  return body?.error?.message || body?.error || response?.statusText || "request failed";
}

export async function previewSessionTaskDrop({
  fetcher = globalThis.fetch,
  sessionId,
  projectSlug,
  taskId,
} = {}) {
  const targetSessionId = nonEmptyString(sessionId);
  const targetTaskId = nonEmptyString(taskId);
  if (!targetSessionId) throw new Error("sessionId is required");
  if (!targetTaskId) throw new Error("taskId is required");
  const body = { taskId: targetTaskId };
  const slug = nonEmptyString(projectSlug);
  if (slug) body.projectSlug = slug;
  const response = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/attach-task/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return payload;
}

export async function requestSessionTaskUnbind({
  fetcher = globalThis.fetch,
  sessionId,
  reason,
  force = false,
  cascadeQueued = false,
} = {}) {
  const targetSessionId = nonEmptyString(sessionId);
  if (!targetSessionId) throw new Error("sessionId is required");
  const body = {};
  if (nonEmptyString(reason)) body.reason = nonEmptyString(reason);
  if (force) body.force = true;
  if (cascadeQueued) body.cascadeQueued = true;
  const response = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/unbind-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return payload;
}

export async function requestSessionTaskLedger({
  fetcher = globalThis.fetch,
  sessionId,
} = {}) {
  const targetSessionId = nonEmptyString(sessionId);
  if (!targetSessionId) throw new Error("sessionId is required");
  const response = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/task-ledger`, {
    method: "GET",
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return Array.isArray(payload.taskLedger) ? payload.taskLedger : [];
}

export async function requestJobComplete({
  fetcher = globalThis.fetch,
  jobId,
} = {}) {
  const targetJobId = nonEmptyString(jobId);
  if (!targetJobId) throw new Error("jobId is required");
  const response = await fetcher(`/api/jobs/${encodeURIComponent(targetJobId)}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return payload;
}

function gateId(gate) {
  return nonEmptyString(gate?.id);
}

function isHumanApprovalGate(gate) {
  return gate?.humanApproval === true ||
    gate?.verifyItemKind === "human_approval" ||
    gate?.itemKind === "human_approval" ||
    gate?.kind === "human_approval";
}

function runnableMissingGates(missing) {
  const out = [];
  for (const gate of Array.isArray(missing) ? missing : []) {
    const id = gateId(gate);
    if (!id || isHumanApprovalGate(gate)) continue;
    if (gate.kind === "verify_pack") out.push({ ...gate, id });
  }
  return out;
}

export async function requestRunMissingGates({
  fetcher = globalThis.fetch,
  jobId,
  missing = [],
} = {}) {
  const targetJobId = nonEmptyString(jobId);
  if (!targetJobId) throw new Error("jobId is required");
  const gates = runnableMissingGates(missing);
  const results = [];
  for (const gate of gates) {
    const response = await fetcher(`/api/jobs/${encodeURIComponent(targetJobId)}/verify-pack/items/${encodeURIComponent(gate.id)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "ui" }),
    });
    const payload = await parseJsonBody(response);
    if (!response.ok) throw new Error(parseApiError(payload, response));
    results.push(payload);
  }
  return {
    ok: results.every((result) => result?.ok !== false),
    mode: "verify_items_run",
    jobId: targetJobId,
    results,
  };
}

export async function requestResolveHumanApproval({
  fetcher = globalThis.fetch,
  jobId,
  gate,
  reason,
} = {}) {
  const targetJobId = nonEmptyString(jobId);
  const targetGateId = gateId(gate);
  if (!targetJobId) throw new Error("jobId is required");
  if (!targetGateId) throw new Error("gate id is required");
  const body = { approved: true, source: "ui" };
  const trimmedReason = nonEmptyString(reason);
  if (trimmedReason) body.reason = trimmedReason;
  const response = await fetcher(`/api/jobs/${encodeURIComponent(targetJobId)}/verify-pack/items/${encodeURIComponent(targetGateId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return payload;
}

export async function requestSpawnReviewerDraft({
  fetcher = globalThis.fetch,
  session,
  jobId,
} = {}) {
  const targetJobId = nonEmptyString(jobId);
  const projectSlug = nonEmptyString(session?.projectSlug);
  const taskId = nonEmptyString(session?.taskId);
  if (!targetJobId) throw new Error("jobId is required");
  if (!projectSlug) throw new Error("projectSlug is required");
  if (!taskId) throw new Error("taskId is required");
  const draft = {
    source: "hub_run",
    mode: "task_backed",
    projectSlug,
    taskId,
    taskLocked: false,
    runtime: "codex_app_server",
    providerId: "codex_app_server",
    profileId: "reviewer",
    sandbox: "workspace-write",
    claimMode: "join",
    refreshContext: true,
    contextPackKind: "changed_since",
    contextFromJobId: targetJobId,
  };
  const response = await fetcher("/api/run-session/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return payload;
}

export async function requestOverrideJobComplete({
  fetcher = globalThis.fetch,
  jobId,
  reason,
} = {}) {
  const targetJobId = nonEmptyString(jobId);
  const trimmedReason = nonEmptyString(reason);
  if (!targetJobId) throw new Error("jobId is required");
  if (!trimmedReason) throw new Error("Override reason is required");
  const response = await fetcher(`/api/jobs/${encodeURIComponent(targetJobId)}/complete-override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: trimmedReason }),
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return payload;
}

function mergeSessionTaskLedger(sessions, sessionId, taskLedger) {
  return upsertSession(sessions, sessionId, (session) => ({
    ...session,
    taskLedger: Array.isArray(taskLedger) ? taskLedger : [],
  }));
}

function taskLedgerRefreshKey(sessions) {
  return normalizeSessionList(sessions)
    .map((session) => [
      session.id,
      session.taskId || "",
      session.activeJobId || "",
      ...(Array.isArray(session.queuedJobIds) ? session.queuedJobIds : []),
    ].join(":"))
    .join("|");
}

function clearBoundTask(session, event) {
  const next = {
    ...session,
    mode: "untasked",
    lastActivityAt: event.ts,
  };
  delete next.taskId;
  delete next.activeJobId;
  return next;
}

export function applyRuntimeSessionEvent(sessions, event) {
  if (!isRecord(event)) return normalizeSessionList(sessions);

  if (event.type === "session.started") {
    const session = isRecord(event.session) ? event.session : {};
    if (typeof session.id !== "string" || session.id.length === 0) return normalizeSessionList(sessions);
    const existing = normalizeSessionList(sessions);
    const index = existing.findIndex((item) => item.id === session.id);
    const base = index >= 0 ? existing[index] : {};
    const nextSession = {
      ...base,
      ...session,
      status: "starting",
      statusSource: sourceFromEvent(event),
      startedAt: event.ts,
      warnings: Array.isArray(base.warnings) ? base.warnings : [],
    };
    if (index === -1) return existing.concat(nextSession);
    const next = existing.slice();
    next[index] = nextSession;
    return next;
  }

  const sessionId = event.sessionId;
  if (event.type === "session.ask") {
    const targetSessionId = typeof event.targetSessionId === "string" ? event.targetSessionId : event.to;
    if (typeof targetSessionId !== "string" || targetSessionId.length === 0) return normalizeSessionList(sessions);
    return upsertSession(sessions, targetSessionId, (session) => ({
      ...session,
      asks: (Array.isArray(session.asks) ? session.asks : []).concat({
        eventId: event.id,
        from: typeof event.from === "string" ? event.from : event.sessionId,
        to: targetSessionId,
        prompt: typeof event.prompt === "string" ? event.prompt : "",
        ts: event.ts,
      }),
    }));
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) return normalizeSessionList(sessions);

  switch (event.type) {
    case "session.status":
      return upsertSession(sessions, sessionId, (session) => ({
        ...session,
        status: event.status,
        statusSource: sourceFromEvent(event),
        lastActivityAt: event.ts,
      }));
    case "session.output":
      return upsertSession(sessions, sessionId, (session) => ({
        ...session,
        lastActivityAt: event.ts,
        ...(event.stream === "stdout" || event.stream === "stderr" ? { lastOutputAt: event.ts } : {}),
        ...(event.stream === "structured" ? { lastStructuredEventAt: event.ts } : {}),
      }));
    case "session.warning":
      if (!isRecord(event.warning)) return normalizeSessionList(sessions);
      return upsertSession(sessions, sessionId, (session) => ({
        ...session,
        warnings: (Array.isArray(session.warnings) ? session.warnings : []).concat({ ...event.warning }),
      }));
    case "session.warning_cleared":
      return upsertSession(sessions, sessionId, (session) => ({
        ...session,
        warnings: Array.isArray(session.warnings)
          ? session.warnings.filter((warning) => warning?.kind !== event.warningKind)
          : [],
      }));
    case "session.task_attached":
      return upsertSession(sessions, sessionId, (session) => {
        if (Array.isArray(event.queuedJobIds)) {
          return {
            ...session,
            queuedJobIds: event.queuedJobIds.filter((jobId) => typeof jobId === "string" && jobId.length > 0),
            lastActivityAt: event.ts,
          };
        }
        if (event.mode === "queued" || typeof event.predecessorJobId === "string") {
          return {
            ...session,
            queuedJobIds: appendUniqueJobId(session.queuedJobIds, event.jobId),
            lastActivityAt: event.ts,
          };
        }
        return {
          ...session,
          ...(typeof event.projectSlug === "string" && event.projectSlug.length > 0 ? { projectSlug: event.projectSlug } : {}),
          ...(typeof event.taskId === "string" && event.taskId.length > 0 ? { taskId: event.taskId } : {}),
          ...(typeof event.jobId === "string" && event.jobId.length > 0 ? { activeJobId: event.jobId } : {}),
          queuedJobIds: removeJobId(session.queuedJobIds, event.jobId),
          lastActivityAt: event.ts,
        };
      });
    case "session.task_unbound":
      return upsertSession(sessions, sessionId, (session) => clearBoundTask(session, event));
    case "session.stdio_capture_changed":
      return upsertSession(sessions, sessionId, (session) => ({
        ...session,
        stdioCapture: isRecord(event.capture) ? { ...event.capture } : session.stdioCapture,
      }));
    case "session.stopped":
      return upsertSession(sessions, sessionId, (session) => ({
        ...session,
        status: "stopped",
        statusSource: sourceFromEvent(event),
        stoppedAt: event.ts,
        ...(typeof event.reason === "string" ? { stopReason: event.reason } : {}),
        ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}),
      }));
    default:
      return normalizeSessionList(sessions);
  }
}

export function applyRuntimeSessionsMessage(sessions, message) {
  const msg = typeof message === "string" ? JSON.parse(message) : message;
  if (!isRecord(msg)) return normalizeSessionList(sessions);
  if (msg.type === "runtime.snapshot") {
    return normalizeSessionList(msg.snapshot?.sessions);
  }
  if (msg.type === "runtime.event") {
    return applyRuntimeSessionEvent(sessions, msg.event);
  }
  return normalizeSessionList(sessions);
}

export function runtimeWebSocketUrl(locationLike = globalThis.location) {
  const protocol = locationLike?.protocol === "https:" ? "wss" : "ws";
  const host = locationLike?.host || "localhost";
  return `${protocol}://${host}/runtime/ws`;
}

export function connectRuntimeSessions({
  WebSocketCtor = globalThis.WebSocket,
  runtimeWsUrl = runtimeWebSocketUrl(),
  reconnectMs = 1000,
  onSessions,
  onConnected,
  onError,
  scheduleReconnect = setTimeout,
  clearReconnect = clearTimeout,
} = {}) {
  if (typeof WebSocketCtor !== "function") {
    if (typeof onError === "function") onError("Runtime WebSocket unavailable");
    return () => {};
  }

  let ws;
  let retryTimer;
  let closing = false;

  const connect = () => {
    ws = new WebSocketCtor(runtimeWsUrl);
    ws.onopen = () => {
      if (typeof onConnected === "function") onConnected(true);
      if (typeof onError === "function") onError(null);
    };
    ws.onclose = () => {
      if (typeof onConnected === "function") onConnected(false);
      if (!closing) retryTimer = scheduleReconnect(connect, reconnectMs);
    };
    ws.onerror = () => {
      if (typeof onError === "function") onError("Runtime WebSocket disconnected");
      try {
        ws.close();
      } catch {}
    };
    ws.onmessage = (event) => {
      try {
        if (typeof onSessions === "function") {
          onSessions((prev) => applyRuntimeSessionsMessage(prev, event.data));
        }
      } catch {
        if (typeof onError === "function") onError("Runtime WebSocket message was invalid");
      }
    };
  };

  connect();
  return () => {
    closing = true;
    clearReconnect(retryTimer);
    try {
      ws?.close();
    } catch {}
  };
}

export function SessionGroupView({
  sessions = [],
  size = "normal",
  connected = false,
  error = null,
  projectSlug = "",
  dropPreflight = null,
  completionPanels = {},
  onSizeChange,
  onAttach,
  onUnbindTask,
  onCompleteJob,
  onCloseCompletionGates,
  onRunMissingGates,
  onResolveHumanApproval,
  onSpawnReviewer,
  onOverrideComplete,
  onCompletionPanelValidationError,
  onTaskDropPreflight,
  onDismissDropPreflight,
} = {}) {
  const cardSize = normalizeSessionCardSize(size);
  const list = normalizeSessionList(sessions);
  const handleTaskDragOver = (event) => {
    if (!eventHasTaskDropData(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleTaskDrop = (event, session = null) => {
    const intent = buildTaskDropPreflightIntent({ event, session, projectSlug });
    if (!intent) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof onTaskDropPreflight === "function") onTaskDropPreflight(intent);
  };

  return html`
    <section class="session-group" data-connected=${connected ? "true" : "false"}>
      <header class="session-group__header">
        <div>
          <h2 class="session-group__title">Sessions</h2>
          <span class="session-group__count">${list.length}</span>
        </div>
        <div class="session-group__controls">
          ${typeof onAttach === "function"
            ? html`<button class="session-group__attach" type="button" onClick=${onAttach}>[ATTACH]</button>`
            : null}
          <div class="session-group__sizes" role="group" aria-label="Session card size">
            ${SESSION_CARD_SIZES.map((option) => html`
              <button
                key=${option}
                type="button"
                class=${`session-group__size ${option === cardSize ? "session-group__size--active" : ""}`}
                aria-pressed=${option === cardSize ? "true" : "false"}
                onClick=${() => {
                  if (typeof onSizeChange === "function") onSizeChange(option);
                }}
              >
                ${option}
              </button>
            `)}
          </div>
        </div>
      </header>
      ${error ? html`<div class="session-group__error" role="status">${error}</div>` : null}
      <div
        class="session-group__drop-zone"
        data-drop-zone="new-session"
        onDragOver=${handleTaskDragOver}
        onDrop=${(event) => handleTaskDrop(event)}
      >
        <span>New session preflight</span>
      </div>
      <${SessionDropPreflightPanel} preflight=${dropPreflight} onClose=${onDismissDropPreflight} />
      ${list.length === 0
        ? html`<div class="session-group__empty">No sessions</div>`
        : html`
            <div class=${`session-group__cards session-group__cards--${cardSize}`} role="list">
              ${list.map((session) => html`
                <div
                  key=${session.id}
                  role="listitem"
                  class="session-group__card-drop-target"
                  data-session-id=${session.id}
                  onDragOver=${handleTaskDragOver}
                  onDrop=${(event) => handleTaskDrop(event, session)}
                >
                  <${SessionCard}
                    session=${session}
                    size=${cardSize}
                    onUnbindTask=${onUnbindTask}
                    completionPanel=${session.activeJobId ? completionPanels[session.activeJobId] : null}
                    onCompleteJob=${onCompleteJob}
                    onCloseCompletionGates=${onCloseCompletionGates}
                    onRunMissingGates=${onRunMissingGates}
                    onResolveHumanApproval=${onResolveHumanApproval}
                    onSpawnReviewer=${onSpawnReviewer}
                    onOverrideComplete=${onOverrideComplete}
                    onCompletionPanelValidationError=${onCompletionPanelValidationError}
                  />
                </div>
              `)}
            </div>
          `}
    </section>
  `;
}

export function SessionDropPreflightPanel({ preflight = null, onClose } = {}) {
  if (!preflight) return null;
  const checks = Array.isArray(preflight.preview?.checks) ? preflight.preview.checks : [];
  const title = preflight.kind === "attach_existing" ? "Attach preflight" : "Run preflight";
  const status = preflight.status || "ready";
  return html`
    <section class=${`session-group__drop-preflight session-group__drop-preflight--${status}`} role="status">
      <div class="session-group__drop-preflight-head">
        <strong>${title}</strong>
        <button class="session-group__drop-preflight-close" type="button" onClick=${onClose}>[CLOSE]</button>
      </div>
      <div class="session-group__drop-preflight-meta">
        <span>${preflight.projectSlug || "project unknown"}</span>
        <span>${preflight.taskId || "task unknown"}</span>
        ${preflight.sessionId ? html`<span>${preflight.sessionId}</span>` : null}
      </div>
      ${status === "loading" ? html`<div class="session-group__drop-preflight-note">Loading</div>` : null}
      ${preflight.error ? html`<div class="session-group__drop-preflight-error">${preflight.error}</div>` : null}
      ${checks.length
        ? html`
            <ul class="session-group__drop-preflight-checks">
              ${checks.map((check) => html`
                <li key=${check.id || check.label} data-status=${check.status || "unknown"}>
                  <span>${check.status || "unknown"}</span>
                  <strong>${check.label || check.id || "check"}</strong>
                  <em>${check.detail || ""}</em>
                </li>
              `)}
            </ul>
          `
        : null}
    </section>
  `;
}

export function SessionGroup({
  initialSessions = [],
  size = "normal",
  onSizeChange,
  WebSocketCtor = globalThis.WebSocket,
  runtimeWsUrl = runtimeWebSocketUrl(),
  reconnectMs = 1000,
  fetcher = globalThis.fetch,
  onAttach,
  onUnbindTask = null,
  projectSlug,
  dropPreflight,
  onTaskDropPreflight,
  onDismissDropPreflight,
} = {}) {
  const [sessions, setSessions] = useState(() => normalizeSessionList(initialSessions));
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [completionPanels, setCompletionPanels] = useState({});
  const cardSize = useMemo(() => normalizeSessionCardSize(size), [size]);
  const ledgerKey = useMemo(() => taskLedgerRefreshKey(sessions), [sessions]);
  const handleUnbindTask = useMemo(
    () => (
      typeof onUnbindTask === "function"
        ? onUnbindTask
        : (payload) => requestSessionTaskUnbind({ fetcher, ...payload })
    ),
    [fetcher, onUnbindTask],
  );
  const setCompletionPanel = useMemo(
    () => (jobId, patch) => {
      const targetJobId = nonEmptyString(jobId);
      if (!targetJobId) return;
      setCompletionPanels((prev) => {
        const current = prev[targetJobId] || {};
        const nextPanel = typeof patch === "function" ? patch(current) : { ...current, ...patch };
        return { ...prev, [targetJobId]: nextPanel };
      });
    },
    [],
  );
  const handleCompleteJob = useMemo(
    () => async ({ jobId }) => {
      const targetJobId = nonEmptyString(jobId);
      if (!targetJobId) return;
      setCompletionPanel(targetJobId, { busyAction: "complete", error: null, message: null });
      try {
        const result = await requestJobComplete({ fetcher, jobId: targetJobId });
        if (result?.mode === "gates_pending") {
          setCompletionPanel(targetJobId, { result, busyAction: null, error: null, message: null });
          return;
        }
        setCompletionPanels((prev) => {
          const next = { ...prev };
          delete next[targetJobId];
          return next;
        });
      } catch (err) {
        setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "complete failed" });
      }
    },
    [fetcher, setCompletionPanel],
  );
  const handleCloseCompletionGates = useMemo(
    () => ({ jobId }) => {
      const targetJobId = nonEmptyString(jobId);
      if (!targetJobId) return;
      setCompletionPanels((prev) => {
        const next = { ...prev };
        delete next[targetJobId];
        return next;
      });
    },
    [],
  );
  const handleRunMissingGates = useMemo(
    () => async ({ jobId, missing }) => {
      const targetJobId = nonEmptyString(jobId);
      if (!targetJobId) return;
      setCompletionPanel(targetJobId, { busyAction: "run_missing", error: null, message: null });
      try {
        const result = await requestRunMissingGates({ fetcher, jobId: targetJobId, missing });
        setCompletionPanel(targetJobId, {
          busyAction: null,
          error: null,
          message: `${result.results.length} verify item${result.results.length === 1 ? "" : "s"} run`,
        });
      } catch (err) {
        setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "verify run failed" });
      }
    },
    [fetcher, setCompletionPanel],
  );
  const handleResolveHumanApproval = useMemo(
    () => async ({ jobId, gate, reason }) => {
      const targetJobId = nonEmptyString(jobId);
      if (!targetJobId) return;
      setCompletionPanel(targetJobId, { busyAction: "resolve_human_approval", error: null, message: null });
      try {
        await requestResolveHumanApproval({ fetcher, jobId: targetJobId, gate, reason });
        setCompletionPanel(targetJobId, { busyAction: null, error: null, message: "Human approval resolved" });
      } catch (err) {
        setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "approval resolve failed" });
      }
    },
    [fetcher, setCompletionPanel],
  );
  const handleSpawnReviewer = useMemo(
    () => async ({ jobId, session }) => {
      const targetJobId = nonEmptyString(jobId);
      if (!targetJobId) return;
      setCompletionPanel(targetJobId, { busyAction: "spawn_reviewer", error: null, message: null });
      try {
        const result = await requestSpawnReviewerDraft({ fetcher, session, jobId: targetJobId });
        const draftId = result?.draft?.id || "draft";
        setCompletionPanel(targetJobId, { busyAction: null, error: null, message: `Reviewer ${draftId} created` });
      } catch (err) {
        setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "reviewer draft failed" });
      }
    },
    [fetcher, setCompletionPanel],
  );
  const handleOverrideComplete = useMemo(
    () => async ({ jobId, reason }) => {
      const targetJobId = nonEmptyString(jobId);
      if (!targetJobId) return;
      setCompletionPanel(targetJobId, { busyAction: "override_complete", error: null, message: null });
      try {
        await requestOverrideJobComplete({ fetcher, jobId: targetJobId, reason });
        setCompletionPanels((prev) => {
          const next = { ...prev };
          delete next[targetJobId];
          return next;
        });
      } catch (err) {
        setCompletionPanel(targetJobId, { busyAction: null, error: err?.message || "override complete failed" });
      }
    },
    [fetcher, setCompletionPanel],
  );
  const handleCompletionPanelValidationError = useMemo(
    () => (message, payload = {}) => {
      const targetJobId = nonEmptyString(payload.jobId);
      if (targetJobId) setCompletionPanel(targetJobId, { busyAction: null, error: message });
      else setError(message);
    },
    [setCompletionPanel],
  );

  useEffect(() => {
    return connectRuntimeSessions({
      WebSocketCtor,
      runtimeWsUrl,
      reconnectMs,
      onSessions: setSessions,
      onConnected: setConnected,
      onError: setError,
    });
  }, [WebSocketCtor, runtimeWsUrl, reconnectMs]);

  useEffect(() => {
    if (typeof fetcher !== "function") return undefined;
    const list = normalizeSessionList(sessions);
    if (list.length === 0) return undefined;
    let cancelled = false;
    Promise.allSettled(
      list.map((session) => requestSessionTaskLedger({ fetcher, sessionId: session.id })
        .then((taskLedger) => ({ sessionId: session.id, taskLedger }))),
    ).then((results) => {
      if (cancelled) return;
      const fulfilled = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      if (fulfilled.length === 0) return;
      setSessions((prev) => fulfilled.reduce(
        (next, item) => mergeSessionTaskLedger(next, item.sessionId, item.taskLedger),
        prev,
      ));
    });
    return () => {
      cancelled = true;
    };
  }, [fetcher, ledgerKey]);

  return html`
    <${SessionGroupView}
      sessions=${sessions}
      size=${cardSize}
      connected=${connected}
      error=${error}
      projectSlug=${projectSlug}
      dropPreflight=${dropPreflight}
      completionPanels=${completionPanels}
      onSizeChange=${onSizeChange}
      onAttach=${onAttach}
      onUnbindTask=${handleUnbindTask}
      onCompleteJob=${handleCompleteJob}
      onCloseCompletionGates=${handleCloseCompletionGates}
      onRunMissingGates=${handleRunMissingGates}
      onResolveHumanApproval=${handleResolveHumanApproval}
      onSpawnReviewer=${handleSpawnReviewer}
      onOverrideComplete=${handleOverrideComplete}
      onCompletionPanelValidationError=${handleCompletionPanelValidationError}
      onTaskDropPreflight=${onTaskDropPreflight}
      onDismissDropPreflight=${onDismissDropPreflight}
    />
  `;
}
