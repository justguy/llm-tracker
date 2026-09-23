import { test } from "node:test";
import assert from "node:assert/strict";

import { createCodexAppServerProvider } from "../hub/providers/codex-app-server.js";
import {
  CODEX_SCHEMA_FILENAME,
  DEFAULT_CODEX_SCHEMA_VERSION,
  codexSchemaPath,
  createCodexSchemaValidator,
  loadVendoredCodexSchema,
} from "../hub/providers/codex-schema/index.js";

function codexSchema() {
  return {
    protocolVersion: "0.0.0",
    methods: [{ name: "threads.create" }],
    events: [{ name: "thread.created" }],
    $defs: {
      OutgoingCall: {
        type: "object",
        additionalProperties: true,
        required: ["jsonrpc", "id", "method", "params"],
        properties: {
          jsonrpc: { const: "2.0" },
          id: { type: "string" },
          method: { enum: ["threads.create"] },
          params: {
            type: "object",
            required: ["prompt"],
            properties: {
              prompt: { type: "string", minLength: 1 },
            },
            additionalProperties: true,
          },
        },
      },
      IncomingEvent: {
        type: "object",
        additionalProperties: true,
        required: ["jsonrpc", "method", "params"],
        properties: {
          jsonrpc: { const: "2.0" },
          method: { enum: ["thread.created"] },
          params: { type: "object" },
        },
      },
    },
  };
}

function codexReviewSchema() {
  return {
    protocolVersion: "0.0.0",
    methods: [{ name: "review/start" }],
    events: [{ name: "review/started" }],
    $defs: {
      OutgoingCall: {
        type: "object",
        additionalProperties: true,
        required: ["jsonrpc", "id", "method", "params"],
        properties: {
          jsonrpc: { const: "2.0" },
          id: { type: "string" },
          method: { enum: ["review/start"] },
          params: {
            type: "object",
            required: ["threadId", "target"],
            properties: {
              threadId: { type: "string" },
              target: {
                type: "object",
                required: ["type", "instructions"],
                properties: {
                  type: { enum: ["custom"] },
                  instructions: { type: "string" },
                },
                additionalProperties: true,
              },
            },
            additionalProperties: true,
          },
        },
      },
      IncomingEvent: {
        type: "object",
        additionalProperties: true,
        required: ["jsonrpc", "method", "params"],
        properties: {
          jsonrpc: { const: "2.0" },
          method: { enum: ["review/started"] },
          params: { type: "object" },
        },
      },
    },
  };
}

function createFakeTransport() {
  const messageListeners = [];
  return {
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
    onMessage(listener) {
      messageListeners.push(listener);
      return () => {};
    },
    onClose() {
      return () => {};
    },
    emitMessage(message) {
      for (const listener of messageListeners) listener(JSON.stringify(message));
    },
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForSent(transport, index = 0) {
  for (let i = 0; i < 200; i += 1) {
    await flushMicrotasks();
    if (transport.sent.length > index) return transport.sent[index];
  }
  throw new Error("timed out waiting for fake Codex RPC request");
}

test("Codex App Server provider loads vendored schema during probe and validates RPC traffic", async () => {
  const transport = createFakeTransport();
  let loaded = false;
  const provider = createCodexAppServerProvider({
    loadSchema: async () => {
      loaded = true;
      return codexSchema();
    },
    runCommand: async (args) => ({
      exitCode: 0,
      stdout: args[0] === "--version" ? "codex 0.0.0" : "structured_thread provider_diffs",
      stderr: "",
    }),
    transportFactory: () => transport,
  });

  assert.throws(
    () => provider.createRpcClient(),
    (err) => err.code === "CODEX_APP_SERVER_SCHEMA_UNAVAILABLE",
  );

  const probe = await provider.probe();
  assert.equal(probe.ok, true);
  assert.equal(loaded, true);
  assert.equal(probe.details.schemaProtocolVersion, "0.0.0");

  const client = provider.createRpcClient();
  await assert.rejects(
    client.call("threads.create", {}),
    (err) => err.code === "CODEX_SCHEMA_VALIDATION_FAILED",
  );

  const pending = client.call("threads.create", { prompt: "start" }, { id: "call-1" });
  await flushMicrotasks();
  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: "call-1",
    method: "threads.create",
    params: { prompt: "start" },
  });
  transport.emitMessage({ jsonrpc: "2.0", id: "call-1", result: { threadId: "thread-1" } });
  assert.deepEqual(await pending, { threadId: "thread-1" });

  const events = [];
  client.onEvent((event) => events.push(event));
  transport.emitMessage({ jsonrpc: "2.0", method: "thread.created", params: { threadId: "thread-1" } });
  assert.equal(events[0].method, "thread.created");
  assert.throws(
    () => transport.emitMessage({ jsonrpc: "2.0", method: "thread.unknown", params: {} }),
    (err) => err.code === "CODEX_RPC_UNKNOWN_NAME",
  );
});

test("Codex App Server provider starts native review through review/start", async () => {
  const transport = createFakeTransport();
  const provider = createCodexAppServerProvider({
    loadSchema: async () => codexReviewSchema(),
    runCommand: async (args) => ({
      exitCode: 0,
      stdout: args[0] === "--version" ? "codex 0.0.0" : "provider_review",
      stderr: "",
    }),
    transportFactory: () => transport,
  });

  await provider.probe();
  const pending = provider.review(
    { threadId: "thread-1" },
    {
      prompt: "Review these changes",
      scope: { diffReviewId: "diff:1" },
      idempotencyKey: "review-1",
    },
  );
  await flushMicrotasks();

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: transport.sent[0].id,
    method: "review/start",
    params: {
      threadId: "thread-1",
      target: { type: "custom", instructions: "Review these changes" },
      scope: { diffReviewId: "diff:1" },
      idempotencyKey: "review-1",
    },
  });
  transport.emitMessage({ jsonrpc: "2.0", id: transport.sent[0].id, result: { reviewId: "review-1" } });
  assert.deepEqual(await pending, { reviewId: "review-1" });
});

test("Codex App Server provider starts native threads through thread/start", async () => {
  const transport = createFakeTransport();
  const provider = createCodexAppServerProvider({
    loadSchema: async () => loadVendoredCodexSchema(),
    runCommand: async (args) => ({
      exitCode: 0,
      stdout: args[0] === "--version" ? "codex 0.135.0" : "structured_thread thread_resume provider_review",
      stderr: "",
    }),
    transportFactory: () => transport,
  });

  await provider.probe();
  const pending = provider.start({
    cwd: "/tmp/demo",
    model: "gpt-5.4",
    sandbox: "workspace-write",
    serviceName: "llm-tracker",
    ephemeral: false,
    sessionStartSource: "startup",
    threadSource: "user",
  });
  const init = await waitForSent(transport);

  assert.equal(init.method, "initialize");
  assert.deepEqual(init.params, {
    clientInfo: {
      name: "llm-project-tracker",
      title: "LLM Project Tracker",
      version: "0.135.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  transport.emitMessage({ jsonrpc: "2.0", id: init.id, result: { serverInfo: { name: "codex", version: "0.135.0" } } });
  const start = await waitForSent(transport, 1);

  assert.equal(start.method, "thread/start");
  assert.deepEqual(start.params, {
    cwd: "/tmp/demo",
    model: "gpt-5.4",
    sandbox: "workspace-write",
    serviceName: "llm-tracker",
    ephemeral: false,
    sessionStartSource: "startup",
    threadSource: "user",
  });
  transport.emitMessage({
    jsonrpc: "2.0",
    id: start.id,
    result: {
      thread: {
        id: "thread-1",
        sessionId: "codex-session-1",
        cwd: "/tmp/demo",
      },
    },
  });
  assert.deepEqual(await pending, {
    providerId: "codex_app_server",
    transport: "stdio",
    threadId: "thread-1",
    providerSessionId: "codex-session-1",
    cwd: "/tmp/demo",
    model: "gpt-5.4",
    schemaVersion: "0.135.0",
  });
});

test("Codex App Server provider sends operator messages through turn/start", async () => {
  const transport = createFakeTransport();
  const provider = createCodexAppServerProvider({
    loadSchema: async () => loadVendoredCodexSchema(),
    runCommand: async (args) => ({
      exitCode: 0,
      stdout: args[0] === "--version" ? "codex 0.135.0" : "structured_thread structured_turns",
      stderr: "",
    }),
    transportFactory: () => transport,
  });

  await provider.probe();
  const pending = provider.send({ threadId: "thread-1" }, { text: "hello agent", userInitiated: true });
  const init = await waitForSent(transport);
  assert.equal(init.method, "initialize");
  transport.emitMessage({ jsonrpc: "2.0", id: init.id, result: { serverInfo: { name: "codex", version: "0.135.0" } } });
  const send = await waitForSent(transport, 1);

  assert.equal(send.method, "turn/start");
  assert.deepEqual(send.params, {
    input: [{ type: "text", text: "hello agent" }],
    threadId: "thread-1",
  });
  transport.emitMessage({ jsonrpc: "2.0", id: send.id, result: { turnId: "turn-1" } });
  assert.deepEqual(await pending, { turnId: "turn-1" });
});

test("Codex App Server provider clears native capabilities when probe fails", async () => {
  const provider = createCodexAppServerProvider({
    loadSchema: async () => codexSchema(),
    runCommand: async (args) => ({
      exitCode: args[0] === "--version" ? 0 : 1,
      stdout: args[0] === "--version" ? "codex 0.0.0" : "",
      stderr: "app-server unavailable",
    }),
  });

  const beforeProbe = provider.capabilities();
  assert.equal(beforeProbe.providerReview, false);
  assert.equal(beforeProbe.structuredThread, false);

  const probe = await provider.probe();
  assert.equal(probe.ok, false);
  const caps = provider.capabilities();
  assert.equal(caps.providerReview, false);
  assert.equal(caps.structuredThread, false);
  assert.equal(caps.threadResume, false);
});

test("vendored Codex App Server schema lives at the versioned stable path", async () => {
  const schemaPath = codexSchemaPath();
  assert.match(
    schemaPath,
    new RegExp(`hub/providers/codex-schema/${escapeRegex(DEFAULT_CODEX_SCHEMA_VERSION)}/stable/${CODEX_SCHEMA_FILENAME}$`),
  );

  const schema = await loadVendoredCodexSchema();
  assert.equal(schema.protocolVersion, DEFAULT_CODEX_SCHEMA_VERSION.slice(1));
  assert.equal(schema.metadata.source, "codex app-server generate-json-schema");
  assert.ok(schema.methods.some((method) => method.name === "thread/start"));
  assert.ok(schema.events.some((event) => event.name === "thread/started"));

  const validator = createCodexSchemaValidator(schema);
  validator.validateOutgoingCall({ jsonrpc: "2.0", id: "call-1", method: "thread/start", params: {} });
  assert.throws(
    () => validator.validateIncomingEvent({ jsonrpc: "2.0", method: "thread/unknown", params: {} }),
    (err) => err.code === "CODEX_SCHEMA_VALIDATION_FAILED",
  );
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
