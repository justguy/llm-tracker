import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeSessionCardSize, SessionCard } from "./SessionCard.js";
import {
  SessionGroupView,
  TASK_DROP_MIME,
  applyRuntimeSessionsMessage,
  buildTaskDropPreflightIntent,
  connectRuntimeSessions,
  previewSessionTaskDrop,
  runtimeWebSocketUrl,
  taskDropPayloadFromEvent,
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

function makeDragEvent(dataByType = {}) {
  const event = {
    prevented: false,
    stopped: false,
    dataTransfer: {
      types: Object.keys(dataByType),
      dropEffect: "",
      getData(type) {
        return dataByType[type] || "";
      },
    },
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  return event;
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

test("SessionCard renders repo unknown when repoRoot is absent", () => {
  const vnode = SessionCard({
    session: { id: "ses_unknown_repo", name: "Manual", tier: "manual" },
  });
  assert.match(collectVNodeText(vnode), /repo unknown/);
});

test("SessionCard renders ask notifications on the target card", () => {
  const vnode = SessionCard({
    session: {
      id: "ses_target",
      name: "Target",
      tier: "mcp_tracked",
      asks: [
        {
          eventId: "evt_ask",
          from: "ses_sender",
          prompt: "Please verify the handoff.",
        },
      ],
    },
  });
  const text = collectVNodeText(vnode);
  assert.match(text, /ask/i);
  assert.match(text, /ses_sender/);
  assert.match(text, /Please verify the handoff/);
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

test("SessionGroupView exposes attach action when supplied", () => {
  let opened = false;
  const vnode = SessionGroupView({
    size: "compact",
    sessions: [],
    onAttach: () => {
      opened = true;
    },
  });
  const buttons = flattenRenderedNodes(vnode).filter((node) => node.type === "button");
  const attach = buttons.find((button) => collectVNodeText(button).includes("[ATTACH]"));
  assert.ok(attach, "attach button is rendered");
  attach.props.onClick();
  assert.equal(opened, true);
});

test("task drop payload accepts structured and plain drag data", () => {
  assert.deepEqual(
    taskDropPayloadFromEvent(makeDragEvent({
      [TASK_DROP_MIME]: JSON.stringify({ taskId: "t1", projectSlug: "demo" }),
    })),
    { taskId: "t1", projectSlug: "demo" },
  );
  assert.deepEqual(taskDropPayloadFromEvent(makeDragEvent({ "text/plain": "t2" })), {
    taskId: "t2",
    projectSlug: null,
  });
});

test("SessionGroupView routes drop-zone task drops to new-session preflight", () => {
  let intent = null;
  const vnode = SessionGroupView({
    projectSlug: "demo",
    sessions: [],
    onTaskDropPreflight: (next) => {
      intent = next;
    },
  });
  const dropZone = nodesByClassName(vnode, "session-group__drop-zone")[0];
  const event = makeDragEvent({ "text/plain": "t1" });
  dropZone.props.onDragOver(event);
  assert.equal(event.prevented, true);
  assert.equal(event.dataTransfer.dropEffect, "copy");
  dropZone.props.onDrop(event);
  assert.deepEqual(intent, {
    kind: "new_session",
    source: "task_drop",
    taskId: "t1",
    projectSlug: "demo",
    sessionId: null,
  });
  assert.equal(event.stopped, true);
});

test("SessionGroupView routes session-card task drops to attach preflight", () => {
  let intent = null;
  const vnode = SessionGroupView({
    projectSlug: "demo",
    sessions: [{ id: "ses_target", projectSlug: "demo", tier: "manual" }],
    onTaskDropPreflight: (next) => {
      intent = next;
    },
  });
  const target = nodesByClassName(vnode, "session-group__card-drop-target")[0];
  target.props.onDrop(makeDragEvent({ [TASK_DROP_MIME]: JSON.stringify({ taskId: "t1" }) }));
  assert.deepEqual(intent, {
    kind: "attach_existing",
    source: "task_drop",
    taskId: "t1",
    projectSlug: "demo",
    sessionId: "ses_target",
  });
});

test("buildTaskDropPreflightIntent prefers payload project over fallback", () => {
  const intent = buildTaskDropPreflightIntent({
    event: makeDragEvent({
      [TASK_DROP_MIME]: JSON.stringify({ taskId: "t1", projectSlug: "from-payload" }),
    }),
    session: { id: "ses_target", projectSlug: "from-session" },
    projectSlug: "from-prop",
  });
  assert.equal(intent.projectSlug, "from-payload");
  assert.equal(intent.sessionId, "ses_target");
});

test("previewSessionTaskDrop uses the pure attach preview endpoint only", async () => {
  const calls = [];
  const preview = await previewSessionTaskDrop({
    sessionId: "ses_target",
    projectSlug: "demo",
    taskId: "t1",
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ checks: [{ id: "task_not_already_bound", status: "ok" }] }),
      };
    },
  });
  assert.deepEqual(preview.checks.map((check) => check.id), ["task_not_already_bound"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/sessions/ses_target/attach-task/preview");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), { taskId: "t1", projectSlug: "demo" });
  assert.notEqual(calls[0][0], "/api/sessions");
  assert.notEqual(calls[0][0], "/api/run-session/launch");
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

test("applyRuntimeSessionsMessage applies session.ask to the target session", () => {
  let sessions = [
    { id: "ses_sender", tier: "manual", warnings: [] },
    { id: "ses_target", tier: "manual", warnings: [] },
  ];
  sessions = applyRuntimeSessionsMessage(sessions, {
    type: "runtime.event",
    event: {
      id: "evt_ask",
      type: "session.ask",
      source: "http",
      ts: "2026-05-25T15:04:00.000Z",
      sessionId: "ses_sender",
      targetSessionId: "ses_target",
      from: "ses_sender",
      to: "ses_target",
      prompt: "Can you check the patch?",
    },
  });
  assert.equal(sessions[0].asks, undefined);
  assert.deepEqual(sessions[1].asks, [
    {
      eventId: "evt_ask",
      from: "ses_sender",
      to: "ses_target",
      prompt: "Can you check the patch?",
      ts: "2026-05-25T15:04:00.000Z",
    },
  ]);
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
