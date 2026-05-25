import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeSessionCardSize, SessionCard } from "./SessionCard.js";
import {
  SessionGroupView,
  applyRuntimeSessionsMessage,
  connectRuntimeSessions,
  runtimeWebSocketUrl,
} from "./SessionGroup.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

function flattenRenderedNodes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => flattenRenderedNodes(item, acc));
    return acc;
  }
  if (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number"
  ) {
    return acc;
  }
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function nodesByClassName(vnode, className) {
  return flattenRenderedNodes(vnode).filter((n) => {
    const cls = n?.props?.class;
    return typeof cls === "string" && cls.split(/\s+/).includes(className);
  });
}

test("normalizeSessionCardSize permits only compact, normal, and large", () => {
  assert.equal(normalizeSessionCardSize("compact"), "compact");
  assert.equal(normalizeSessionCardSize("normal"), "normal");
  assert.equal(normalizeSessionCardSize("large"), "large");
  assert.equal(normalizeSessionCardSize("freeform"), "normal");
  assert.equal(normalizeSessionCardSize(undefined), "normal");
});

test("SessionCard renders visible warning source and evidence labels", () => {
  const vnode = SessionCard({
    size: "large",
    session: {
      id: "ses_warning",
      tier: "manual",
      warnings: [
        {
          kind: "provider_error",
          source: "provider",
          evidenceRef: "evt_123",
          message: "Provider failed",
        },
      ],
    },
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /source/i);
  assert.match(text, /provider/);
  assert.match(text, /evidence/i);
  assert.match(text, /evt_123/);
  assert.equal(vnode.props["data-card-size"], "large");
});

test("SessionGroupView exposes exactly the three card-size choices", () => {
  const vnode = SessionGroupView({
    size: "compact",
    sessions: [{ id: "ses_live", tier: "dumb_terminal" }],
  });
  const buttons = nodesByClassName(vnode, "session-group__size");
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map((button) => collectVNodeText(button).trim()), ["compact", "normal", "large"]);
  assert.equal(buttons.filter((button) => button.props["aria-pressed"] === "true").length, 1);
});

test("applyRuntimeSessionsMessage replaces sessions from runtime.snapshot", () => {
  const sessions = applyRuntimeSessionsMessage(
    [{ id: "ses_old", tier: "manual" }],
    {
      type: "runtime.snapshot",
      snapshot: {
        sessions: [
          { id: "ses_a", tier: "manual" },
          { id: "ses_b", tier: "dumb_terminal" },
        ],
      },
    },
  );
  assert.deepEqual(sessions.map((session) => session.id), ["ses_a", "ses_b"]);
});

test("applyRuntimeSessionsMessage applies runtime.event session updates without reload", () => {
  let sessions = [{ id: "ses_a", tier: "dumb_terminal", status: "running", warnings: [] }];
  sessions = applyRuntimeSessionsMessage(sessions, {
    type: "runtime.event",
    event: {
      id: "evt_warning",
      type: "session.warning",
      source: "runtime",
      ts: "2026-05-25T15:00:00.000Z",
      sessionId: "ses_a",
      warning: { kind: "provider_error", source: "provider", evidenceRef: "evt_src" },
    },
  });
  assert.equal(sessions[0].warnings.length, 1);
  sessions = applyRuntimeSessionsMessage(sessions, {
    type: "runtime.event",
    event: {
      id: "evt_status",
      type: "session.status",
      source: "runtime",
      ts: "2026-05-25T15:01:00.000Z",
      sessionId: "ses_a",
      status: "quiet",
    },
  });
  assert.equal(sessions[0].status, "quiet");
  assert.equal(sessions[0].statusSource.eventId, "evt_status");
  sessions = applyRuntimeSessionsMessage(sessions, {
    type: "runtime.event",
    event: {
      id: "evt_clear",
      type: "session.warning_cleared",
      source: "runtime",
      ts: "2026-05-25T15:02:00.000Z",
      sessionId: "ses_a",
      warningKind: "provider_error",
    },
  });
  assert.equal(sessions[0].warnings.length, 0);
});

test("runtimeWebSocketUrl resolves the runtime stream on current origin", () => {
  assert.equal(runtimeWebSocketUrl({ protocol: "http:", host: "127.0.0.1:4400" }), "ws://127.0.0.1:4400/runtime/ws");
  assert.equal(runtimeWebSocketUrl({ protocol: "https:", host: "tracker.local" }), "wss://tracker.local/runtime/ws");
});

test("connectRuntimeSessions consumes snapshot and runtime.event messages", () => {
  const sockets = [];
  const states = [];
  const connected = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const close = connectRuntimeSessions({
    WebSocketCtor: FakeWebSocket,
    runtimeWsUrl: "ws://example.test/runtime/ws",
    onConnected: (value) => connected.push(value),
    onSessions: (updater) => {
      const prev = states.length > 0 ? states[states.length - 1] : [];
      states.push(updater(prev));
    },
  });

  assert.equal(sockets[0].url, "ws://example.test/runtime/ws");
  sockets[0].onopen();
  assert.deepEqual(connected, [true]);
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "runtime.snapshot",
      snapshot: { sessions: [{ id: "ses_socket", tier: "manual", warnings: [] }] },
    }),
  });
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "runtime.event",
      event: {
        id: "evt_socket",
        type: "session.status",
        source: "runtime",
        ts: "2026-05-25T15:03:00.000Z",
        sessionId: "ses_socket",
        status: "running",
      },
    }),
  });
  assert.equal(states[1][0].status, "running");
  close();
  assert.equal(sockets[0].closed, true);
});
