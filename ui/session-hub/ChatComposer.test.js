import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChatComposer,
  messageCapability,
  postSessionMessage,
} from "./ChatComposer.js";

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
  if (typeof node.type === "function") return flattenRenderedNodes(node.type(node.props || {}), acc);
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

test("messageCapability allows structured or stdin-backed sessions", () => {
  const providerThread = { threadId: "thread_1" };
  assert.equal(messageCapability({ provider: "codex", providerThread, providerCapabilities: { turnSteer: true } }).enabled, true);
  assert.equal(messageCapability({ provider: "terminal", providerThread, providerCapabilities: { stdinWrite: true } }).enabled, true);
  assert.equal(messageCapability({ tier: "manual" }).enabled, false);
});

test("messageCapability accepts provider id from providerThread", () => {
  assert.equal(
    messageCapability({
      providerThread: { providerId: "codex_app_server", threadId: "thread_1" },
      providerCapabilities: { turnSteer: true },
    }).enabled,
    true,
  );
});

test("messageCapability requires a provider thread instead of trusting tier alone", () => {
  const noThread = messageCapability({
    provider: "codex",
    tier: "codex_app_server",
    providerCapabilities: { turnSteer: true },
  });
  assert.equal(noThread.enabled, false);
  assert.equal(noThread.disabledReason, "Provider thread required for chat");
  assert.equal(messageCapability({ provider: "codex", tier: "codex_app_server" }).enabled, false);
});

test("ChatComposer makes unavailable chat visibly disabled", () => {
  const vnode = ChatComposer({
    session: {
      id: "ses_dead_chat",
      provider: "codex",
      providerCapabilities: { turnSteer: true },
    },
    draft: "hello",
  });
  const nodes = flattenRenderedNodes(vnode);
  const textarea = nodes.find((node) => node.type === "textarea");
  const send = nodes.find((node) => node.type === "button" && collectVNodeText(node).includes("SEND"));
  const text = collectVNodeText(vnode);
  assert.equal(textarea.props.disabled, true);
  assert.equal(send.props.disabled, true);
  assert.match(text, /Chat unavailable: Provider thread required for chat/);
});

test("ChatComposer renders send failures in status text", () => {
  const vnode = ChatComposer({
    session: {
      id: "ses_chat",
      providerThread: { providerId: "codex_app_server", threadId: "thread_1" },
      providerCapabilities: { turnSteer: true },
    },
    draft: "hello",
    sendError: "provider message dispatch unavailable",
  });
  assert.match(collectVNodeText(vnode), /Chat error: provider message dispatch unavailable/);
});

test("postSessionMessage sends operator text to the session message endpoint", async () => {
  const calls = [];
  const result = await postSessionMessage({
    sessionId: "ses_123",
    message: "hello agent",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, message: { text: "hello agent" } };
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "/api/sessions/ses_123/message");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: "hello agent" });
});

test("ChatComposer renders a real Send control and clears draft after success", async () => {
  let draft = "ship it";
  let sent = null;
  const vnode = ChatComposer({
    session: {
      id: "ses_chat",
      provider: "terminal",
      providerThread: { threadId: "pty_1" },
      providerCapabilities: { stdinWrite: true },
    },
    draft,
    onDraftChange: (value) => {
      draft = value;
    },
    onSend: (result) => {
      sent = result;
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true, message: { text: "ship it" } };
      },
    }),
  });

  const buttons = flattenRenderedNodes(vnode).filter((node) => node.type === "button");
  const send = buttons.find((button) => collectVNodeText(button).includes("SEND"));
  assert.equal(send.props.disabled, false);
  await send.props.onClick();
  assert.equal(draft, "");
  assert.equal(sent.ok, true);
});
