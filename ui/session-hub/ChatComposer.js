// ui/session-hub/ChatComposer.js — SH-9-18

import { html } from "htm/preact";

export function interruptCapability(session = {}) {
  const caps = session.providerCapabilities || session.capabilities || {};
  if (caps.turnInterrupt === true) return { enabled: true, disabledReason: "" };
  return {
    enabled: false,
    disabledReason: "Provider capability 'turnInterrupt' required",
  };
}

export function messageCapability(session = {}, capabilities = null) {
  const sessionCaps = session.providerCapabilities || session.capabilities || {};
  const overrideCaps = capabilities && typeof capabilities === "object" ? capabilities : {};
  const caps = { ...sessionCaps, ...overrideCaps };
  const hasMessageCapability =
    caps.structuredChat === true ||
    caps.turnSteer === true ||
    caps.stdinWrite === true;
  if (!hasMessageCapability) {
    return {
      enabled: false,
      disabledReason: "Provider capability 'structuredChat', 'turnSteer', or 'stdinWrite' required",
    };
  }
  if (!providerIdForSession(session)) {
    return { enabled: false, disabledReason: "Provider id required for chat" };
  }
  if (!threadRefForSession(session)) {
    return { enabled: false, disabledReason: "Provider thread required for chat" };
  }
  return { enabled: true, disabledReason: "" };
}

function providerIdForSession(session) {
  if (!session || typeof session !== "object") return "";
  if (typeof session.providerId === "string" && session.providerId.length > 0) return session.providerId;
  if (typeof session.provider === "string" && session.provider.length > 0) return session.provider;
  if (
    session.threadRef &&
    typeof session.threadRef === "object" &&
    !Array.isArray(session.threadRef) &&
    typeof session.threadRef.providerId === "string" &&
    session.threadRef.providerId.length > 0
  ) {
    return session.threadRef.providerId;
  }
  if (
    session.providerThread &&
    typeof session.providerThread === "object" &&
    !Array.isArray(session.providerThread) &&
    typeof session.providerThread.providerId === "string" &&
    session.providerThread.providerId.length > 0
  ) {
    return session.providerThread.providerId;
  }
  return "";
}

function threadRefForSession(session) {
  if (!session || typeof session !== "object") return null;
  const rawRef =
    session.threadRef && typeof session.threadRef === "object" && !Array.isArray(session.threadRef)
      ? session.threadRef
      : session.providerThread && typeof session.providerThread === "object" && !Array.isArray(session.providerThread)
        ? session.providerThread
        : {};
  const threadId =
    (typeof rawRef.threadId === "string" && rawRef.threadId.length > 0 ? rawRef.threadId : "") ||
    (typeof rawRef.id === "string" && rawRef.id.length > 0 ? rawRef.id : "") ||
    (typeof session.threadId === "string" && session.threadId.length > 0 ? session.threadId : "") ||
    (typeof session.providerThreadId === "string" && session.providerThreadId.length > 0 ? session.providerThreadId : "");
  return threadId ? { ...rawRef, threadId } : null;
}

export function queueDraftAfterInterrupt(draft, queue = []) {
  const text = typeof draft === "string" ? draft : "";
  if (!text) return Array.isArray(queue) ? [...queue] : [];
  return [text, ...(Array.isArray(queue) ? queue : [])];
}

export async function postSessionInterrupt({
  fetch: fetchFn = typeof fetch === "function" ? fetch : null,
  sessionId,
  reason,
  draft,
  queuedDrafts = [],
} = {}) {
  if (typeof fetchFn !== "function") {
    return { ok: false, disabledReason: "Fetch API unavailable", queuedDrafts };
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, disabledReason: "sessionId required", queuedDrafts };
  }
  const response = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  const body = typeof response.json === "function" ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body,
      disabledReason: body?.error?.details?.disabledReason || body?.error?.message || response.statusText,
      queuedDrafts,
    };
  }
  return {
    ok: true,
    status: response.status,
    body,
    queuedDrafts: queueDraftAfterInterrupt(draft, queuedDrafts),
  };
}

export async function postSessionMessage({
  fetch: fetchFn = typeof fetch === "function" ? fetch : null,
  sessionId,
  message,
} = {}) {
  if (typeof fetchFn !== "function") {
    return { ok: false, disabledReason: "Fetch API unavailable" };
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, disabledReason: "sessionId required" };
  }
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return { ok: false, disabledReason: "message required" };
  const response = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
  const body = typeof response.json === "function" ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body,
      disabledReason: body?.error?.details?.disabledReason || body?.error?.message || response.statusText,
    };
  }
  return { ok: true, status: response.status, body };
}

export function ChatComposer({
  session,
  draft = "",
  queuedDrafts = [],
  capabilities = null,
  sendError = "",
  onDraftChange,
  onQueuedDraftsChange,
  onInterrupt,
  onSend,
  fetch,
} = {}) {
  const interrupt = interruptCapability(session);
  const message = messageCapability(session, capabilities);
  const sessionId = session?.id || session?.sessionId || "";
  const draftText = typeof draft === "string" ? draft : "";
  const canSend = message.enabled && draftText.trim().length > 0;
  const disabledNotices = [
    typeof sendError === "string" && sendError ? `Chat error: ${sendError}` : "",
    message.enabled ? "" : `Chat unavailable: ${message.disabledReason}`,
    interrupt.enabled ? "" : `Interrupt unavailable: ${interrupt.disabledReason}`,
  ].filter(Boolean);
  const sendClick = async () => {
    const result = await postSessionMessage({
      fetch,
      sessionId,
      message: draftText,
    });
    if (result.ok && typeof onDraftChange === "function") onDraftChange("");
    if (typeof onSend === "function") onSend(result);
  };
  const interruptClick = async () => {
    const result = await postSessionInterrupt({
      fetch,
      sessionId,
      reason: "operator interrupt from composer",
      draft,
      queuedDrafts,
    });
    if (result.ok && typeof onQueuedDraftsChange === "function") {
      onQueuedDraftsChange(result.queuedDrafts);
    }
    if (typeof onInterrupt === "function") onInterrupt(result);
  };
  return html`
    <div class="chat-composer">
      <textarea
        class="chat-composer__input"
        value=${draft}
        disabled=${!message.enabled}
        placeholder=${message.enabled ? "Message this session" : message.disabledReason}
        onInput=${(event) => {
          if (typeof onDraftChange === "function") onDraftChange(event.currentTarget.value);
        }}
      />
      <button
        class="chat-composer__send"
        type="button"
        disabled=${!canSend}
        title=${message.disabledReason || (draftText.trim() ? "Send message" : "Write a message")}
        onClick=${sendClick}
      >
        SEND
      </button>
      <button
        class="chat-composer__interrupt"
        type="button"
        disabled=${!interrupt.enabled}
        title=${interrupt.disabledReason || "Interrupt current turn"}
        onClick=${interruptClick}
      >
        INTERRUPT
      </button>
      ${disabledNotices.length > 0
        ? html`<div class="chat-composer__status" role="status">${disabledNotices.join(" · ")}</div>`
        : null}
    </div>
  `;
}
