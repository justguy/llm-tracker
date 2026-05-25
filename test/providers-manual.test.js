// test/providers-manual.test.js — SH-2-18 (PRD §6.3 / §7, addendum §6)
//
// ManualProvider acceptance tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createManualProvider,
  manualCapabilities,
  MANUAL_PROVIDER_ID,
  MANUAL_PROVIDER_LABEL,
} from "../hub/providers/manual.js";

const CAPABILITY_FLAGS = [
  "structuredThread",
  "structuredTurns",
  "structuredItems",
  "structuredApprovals",
  "structuredFileChanges",
  "structuredCommandEvents",
  "structuredContextUsage",
  "providerTimeline",
  "providerDiffs",
  "providerReview",
  "modelList",
  "skillList",
  "threadResume",
  "threadFork",
  "turnSteer",
  "turnInterrupt",
  "rawStdio",
  "stdinWrite",
  "processLifecycle",
  "directContextInjection",
];

test("createManualProvider: id and label", () => {
  const p = createManualProvider();
  assert.equal(p.id, "manual");
  assert.equal(p.id, MANUAL_PROVIDER_ID);
  assert.equal(p.label, "Manual (advisory)");
  assert.equal(p.label, MANUAL_PROVIDER_LABEL);
});

test("createManualProvider.probe: always ok", async () => {
  const p = createManualProvider();
  const result = await p.probe();
  assert.equal(result.ok, true);
  assert.equal(typeof result.reason, "string");
});

test("createManualProvider.capabilities: all 20 flags strictly false", () => {
  const p = createManualProvider();
  const caps = p.capabilities();
  // every required flag present and === false
  for (const flag of CAPABILITY_FLAGS) {
    assert.equal(caps[flag], false, `capability '${flag}' must be strictly false`);
  }
  // no extra keys (this catches typos or accidental additions)
  assert.deepEqual(Object.keys(caps).sort(), [...CAPABILITY_FLAGS].sort());
});

test("createManualProvider.capabilities: returns a fresh object each call", () => {
  const p = createManualProvider();
  const a = p.capabilities();
  const b = p.capabilities();
  assert.notEqual(a, b);
  a.rawStdio = true;
  assert.equal(b.rawStdio, false);
  // manualCapabilities() (the named export) also returns a fresh object
  const c = manualCapabilities();
  c.processLifecycle = true;
  assert.equal(manualCapabilities().processLifecycle, false);
});

test("createManualProvider.start: returns advisory handle with required shape", async () => {
  const p = createManualProvider();
  const h = await p.start({ cwd: "/x", repoRoot: "/r" });
  assert.equal(h.providerId, "manual");
  assert.equal(h.transport, "manual");
  assert.equal(h.cwd, "/x");
  assert.equal(h.repoRoot, "/r");
  assert.equal(typeof h.threadId, "string");
  assert.ok(h.threadId.startsWith("man_"), `threadId should start with 'man_', got '${h.threadId}'`);
  assert.equal(typeof h.createdAt, "string");
  // createdAt parses as a valid ISO date
  assert.ok(!Number.isNaN(Date.parse(h.createdAt)));
});

test("createManualProvider.start: two calls produce distinct threadIds", async () => {
  const p = createManualProvider();
  const h1 = await p.start({});
  const h2 = await p.start({});
  assert.notEqual(h1.threadId, h2.threadId);
});

test("createManualProvider.start: throws TypeError on null / non-object", async () => {
  const p = createManualProvider();
  await assert.rejects(() => p.start(null), TypeError);
  await assert.rejects(() => p.start("notobject"), TypeError);
});

test("createManualProvider.streamEvents: yields zero events and completes cleanly", async () => {
  const p = createManualProvider();
  const h = await p.start({});
  let count = 0;
  for await (const _e of p.streamEvents(h)) {
    count += 1;
  }
  assert.equal(count, 0);
});

test("createManualProvider.streamEvents: validates threadRef shape and providerId", async () => {
  const p = createManualProvider();
  const h = await p.start({});
  assert.throws(() => p.streamEvents(null), TypeError);
  assert.throws(() => p.streamEvents("notobject"), TypeError);
  assert.throws(() => p.streamEvents({ providerId: "wrong", threadId: h.threadId }), TypeError);
  assert.throws(() => p.streamEvents({ providerId: "manual" }), TypeError); // missing threadId
  assert.throws(() => p.streamEvents({ providerId: "manual", threadId: "" }), TypeError);
});

test("createManualProvider: optional lifecycle methods are all undefined", () => {
  const p = createManualProvider();
  for (const op of [
    "stop",
    "send",
    "attach",
    "resume",
    "fork",
    "steer",
    "interrupt",
    "approve",
    "deny",
    "listModels",
    "listSkills",
  ]) {
    assert.equal(p[op], undefined, `optional method '${op}' must be omitted (broker raises NOT_SUPPORTED)`);
  }
});

test("createManualProvider: injectable now() drives createdAt deterministically", async () => {
  const fixed = 1717171717000;
  const p = createManualProvider({ now: () => fixed });
  const h = await p.start({});
  assert.equal(Date.parse(h.createdAt), fixed);
  // threadId should embed the same epoch
  assert.ok(h.threadId.startsWith(`man_${fixed}_`));
});
