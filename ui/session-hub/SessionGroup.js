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
  onSizeChange,
  onAttach,
} = {}) {
  const cardSize = normalizeSessionCardSize(size);
  const list = normalizeSessionList(sessions);

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
      ${list.length === 0
        ? html`<div class="session-group__empty">No sessions</div>`
        : html`
            <div class=${`session-group__cards session-group__cards--${cardSize}`} role="list">
              ${list.map((session) => html`
                <div key=${session.id} role="listitem">
                  <${SessionCard} session=${session} size=${cardSize} />
                </div>
              `)}
            </div>
          `}
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
  onAttach,
} = {}) {
  const [sessions, setSessions] = useState(() => normalizeSessionList(initialSessions));
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const cardSize = useMemo(() => normalizeSessionCardSize(size), [size]);

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

  return html`
    <${SessionGroupView}
      sessions=${sessions}
      size=${cardSize}
      connected=${connected}
      error=${error}
      onSizeChange=${onSizeChange}
      onAttach=${onAttach}
    />
  `;
}
