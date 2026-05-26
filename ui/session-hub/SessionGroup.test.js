import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JOB_ACTION_UNBOUND_REASON,
  UNBIND_ACTIVE_CONFIRMATION,
  normalizeSessionCardSize,
  SessionCard,
} from "./SessionCard.js";
import {
  SessionGroupView,
  TASK_DROP_MIME,
  applyRuntimeSessionsMessage,
  buildTaskDropPreflightIntent,
  connectRuntimeSessions,
  requestJobComplete,
  requestOverrideJobComplete,
  requestResolveHumanApproval,
  requestRunMissingGates,
  requestSpawnReviewerDraft,
  requestSessionTaskLedger,
  previewSessionTaskDrop,
  requestSessionTaskUnbind,
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

test("SessionCard disables job-only actions when no active job is bound", () => {
  const vnode = SessionCard({
    session: { id: "ses_unbound", name: "Untasked", tier: "manual" },
  });
  const buttons = nodesByClassName(vnode, "session-card__job-action");
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map((button) => collectVNodeText(button).trim()), ["VERIFY", "COMPLETE", "SKILLS"]);
  assert.ok(buttons.every((button) => button.props.disabled === true));
  assert.ok(buttons.every((button) => button.props.title === JOB_ACTION_UNBOUND_REASON));
  assert.match(collectVNodeText(vnode), /session has no active job; bind a task first/);
});

test("SessionCard enables job-only actions when activeJobId is present", () => {
  const vnode = SessionCard({
    session: { id: "ses_bound", name: "Bound", tier: "manual", activeJobId: "job_active" },
  });
  const buttons = nodesByClassName(vnode, "session-card__job-action");
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((button) => button.props.disabled === false));
  assert.ok(buttons.every((button) => button.props.title === "job_active"));
  assert.doesNotMatch(collectVNodeText(vnode), /bind a task first/);
});

test("SessionCard COMPLETE action calls active job completion handler", () => {
  let payload = null;
  const vnode = SessionCard({
    session: { id: "ses_bound", name: "Bound", tier: "manual", activeJobId: "job_active" },
    onCompleteJob: (next) => {
      payload = next;
    },
  });
  const complete = nodesByClassName(vnode, "session-card__job-action")
    .find((button) => collectVNodeText(button).trim() === "COMPLETE");
  complete.props.onClick();
  assert.equal(payload.sessionId, "ses_bound");
  assert.equal(payload.jobId, "job_active");
});

test("SessionCard renders completion gates panel for active job", () => {
  const vnode = SessionCard({
    session: { id: "ses_bound", activeJobId: "job_active" },
    completionPanel: {
      result: {
        mode: "gates_pending",
        missing: [{ id: "cmd.ok", kind: "verify_pack", required: true, status: "pending" }],
      },
    },
  });
  assert.match(collectVNodeText(vnode), /Completion gates/);
  assert.match(collectVNodeText(vnode), /cmd\.ok/);
});

test("SessionCard renders unbind chips and confirms active job unbind", () => {
  let confirmed = null;
  let unbound = null;
  const vnode = SessionCard({
    session: {
      id: "ses_bound",
      activeJobId: "job_active",
      taskLedger: [
        { taskId: "t-active", title: "Active", jobId: "job_active", relation: "active_job" },
        { taskId: "t-next", title: "Next", jobId: "job_next", relation: "queued_next" },
      ],
    },
    confirmUnbind: (message, context) => {
      confirmed = { message, context };
      return true;
    },
    onUnbindTask: (payload) => {
      unbound = payload;
    },
  });
  const chips = nodesByClassName(vnode, "session-card__unbind-chip");
  assert.equal(chips.length, 2);
  assert.match(collectVNodeText(vnode), /Active/);
  assert.match(collectVNodeText(vnode), /queued_next/);
  chips[0].props.onClick();
  assert.equal(confirmed.message, UNBIND_ACTIVE_CONFIRMATION);
  assert.equal(confirmed.context.item.taskId, "t-active");
  assert.deepEqual(unbound, {
    sessionId: "ses_bound",
    taskId: "t-active",
    jobId: "job_active",
    relation: "active_job",
    force: true,
  });
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

test("requestSessionTaskUnbind posts force payload to unbind endpoint", async () => {
  const calls = [];
  const result = await requestSessionTaskUnbind({
    sessionId: "ses_target",
    reason: "change task",
    force: true,
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ ok: true, mode: "untasked" }),
      };
    },
  });
  assert.equal(result.mode, "untasked");
  assert.equal(calls[0][0], "/api/sessions/ses_target/unbind-task");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), { reason: "change task", force: true });
});

test("requestSessionTaskLedger reads derived ledger rows", async () => {
  const calls = [];
  const taskLedger = await requestSessionTaskLedger({
    sessionId: "ses_target",
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({
          taskLedger: [{ taskId: "t-active", relation: "active_job" }],
        }),
      };
    },
  });
  assert.deepEqual(taskLedger, [{ taskId: "t-active", relation: "active_job" }]);
  assert.equal(calls[0][0], "/api/sessions/ses_target/task-ledger");
  assert.equal(calls[0][1].method, "GET");
});

test("job completion helpers call the Session Hub lifecycle endpoints", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push([url, options]);
    return {
      ok: true,
      json: async () => ({ ok: false, mode: "gates_pending", missing: [] }),
    };
  };
  const result = await requestJobComplete({ jobId: "job_123", fetcher });
  assert.equal(result.mode, "gates_pending");
  assert.equal(calls[0][0], "/api/jobs/job_123/complete");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), {});
});

test("requestRunMissingGates runs only runnable verify-pack gates", async () => {
  const calls = [];
  await requestRunMissingGates({
    jobId: "job_123",
    missing: [
      { id: "cmd.ok", kind: "verify_pack", status: "pending" },
      { id: "approve.ship", kind: "verify_pack", humanApproval: true, verifyItemKind: "human_approval" },
    ],
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ ok: true, mode: "command_completed" }),
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/jobs/job_123/verify-pack/items/cmd.ok/run");
  assert.deepEqual(JSON.parse(calls[0][1].body), { source: "ui" });
});

test("requestResolveHumanApproval resolves human approval through verify-pack endpoint", async () => {
  const calls = [];
  const result = await requestResolveHumanApproval({
    jobId: "job_123",
    gate: { id: "approve.ship", humanApproval: true },
    reason: "ship it",
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ ok: true, mode: "verify_item_resolved", status: "satisfied" }),
      };
    },
  });
  assert.equal(result.status, "satisfied");
  assert.equal(calls[0][0], "/api/jobs/job_123/verify-pack/items/approve.ship/resolve");
  assert.deepEqual(JSON.parse(calls[0][1].body), { approved: true, source: "ui", reason: "ship it" });
});

test("requestSpawnReviewerDraft creates reviewer draft from active session and job", async () => {
  const calls = [];
  const result = await requestSpawnReviewerDraft({
    jobId: "job_123",
    session: { projectSlug: "demo", taskId: "t-1" },
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ draft: { id: "draft_123" } }),
      };
    },
  });
  assert.equal(result.draft.id, "draft_123");
  assert.equal(calls[0][0], "/api/run-session/draft");
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.profileId, "reviewer");
  assert.equal(body.contextPackKind, "changed_since");
  assert.equal(body.contextFromJobId, "job_123");
});

test("requestOverrideJobComplete requires a reason and posts override endpoint", async () => {
  await assert.rejects(
    requestOverrideJobComplete({ jobId: "job_123", reason: "" }),
    /Override reason is required/,
  );
  const calls = [];
  await requestOverrideJobComplete({
    jobId: "job_123",
    reason: "operator accepted",
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ ok: true, mode: "completed_via_override" }),
      };
    },
  });
  assert.equal(calls[0][0], "/api/jobs/job_123/complete-override");
  assert.deepEqual(JSON.parse(calls[0][1].body), { reason: "operator accepted" });
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

test("applyRuntimeSessionsMessage projects session.task_attached onto the card model", () => {
  let sessions = [{
    id: "ses_a",
    tier: "manual",
    status: "active",
    queuedJobIds: ["job_queued"],
  }];
  sessions = applyRuntimeSessionsMessage(sessions, {
    type: "runtime.event",
    event: {
      id: "evt_attach",
      type: "session.task_attached",
      source: "http",
      ts: "2026-05-25T15:03:00.000Z",
      sessionId: "ses_a",
      projectSlug: "demo",
      taskId: "t-1",
      jobId: "job_active",
      mode: "started",
    },
  });
  assert.equal(sessions[0].projectSlug, "demo");
  assert.equal(sessions[0].taskId, "t-1");
  assert.equal(sessions[0].activeJobId, "job_active");
  assert.deepEqual(sessions[0].queuedJobIds, ["job_queued"]);

  sessions = applyRuntimeSessionsMessage(sessions, {
    type: "runtime.event",
    event: {
      id: "evt_queue",
      type: "session.task_attached",
      source: "http",
      ts: "2026-05-25T15:04:00.000Z",
      sessionId: "ses_a",
      taskId: "t-2",
      jobId: "job_next",
      predecessorJobId: "job_active",
      mode: "queued",
    },
  });
  assert.equal(sessions[0].activeJobId, "job_active");
  assert.deepEqual(sessions[0].queuedJobIds, ["job_queued", "job_next"]);
});

test("applyRuntimeSessionsMessage projects session.task_unbound onto the card model", () => {
  const sessions = applyRuntimeSessionsMessage(
    [{
      id: "ses_a",
      tier: "manual",
      status: "active",
      projectSlug: "demo",
      taskId: "t-1",
      activeJobId: "job_active",
      queuedJobIds: ["job_queued"],
    }],
    {
      type: "runtime.event",
      event: {
        id: "evt_unbind",
        type: "session.task_unbound",
        source: "http",
        ts: "2026-05-25T15:05:00.000Z",
        sessionId: "ses_a",
        previousTaskId: "t-1",
        previousActiveJobId: "job_active",
        force: true,
      },
    },
  );
  assert.equal(sessions[0].mode, "untasked");
  assert.equal(sessions[0].taskId, undefined);
  assert.equal(sessions[0].activeJobId, undefined);
  assert.deepEqual(sessions[0].queuedJobIds, ["job_queued"]);
  assert.equal(sessions[0].lastActivityAt, "2026-05-25T15:05:00.000Z");
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
