// test/providers-capabilities.test.js — SH-2-16 (addendum §5)
//
// ProviderCapabilities shape + toSessionCapabilities mapping acceptance tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_CAPABILITY_KEYS,
  SESSION_CAPABILITY_KEYS,
  defaultProviderCapabilities,
  validateProviderCapabilities,
  toSessionCapabilities,
} from "../hub/providers/capabilities.js";

// The 20 ProviderCapabilities flag names in addendum §5 order — pinned here
// as a literal so any future drift in capabilities.js trips this test.
const EXPECTED_PROVIDER_KEYS = [
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

// The 11 SessionCapabilities flag names in TDD §6.2 order.
const EXPECTED_SESSION_KEYS = [
  "rawStdio",
  "stdinWrite",
  "processLifecycle",
  "structuredEvents",
  "structuredApprovals",
  "structuredChat",
  "structuredCommands",
  "structuredMcpCalls",
  "explicitTrackerMcp",
  "appServerChat",
  "directContextInjection",
];

function allTrueProviderCaps() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const key of PROVIDER_CAPABILITY_KEYS) out[key] = true;
  return out;
}

// -- shape constants --------------------------------------------------------

test("PROVIDER_CAPABILITY_KEYS: length 20 and matches addendum §5 order exactly", () => {
  assert.equal(PROVIDER_CAPABILITY_KEYS.length, 20);
  assert.deepEqual([...PROVIDER_CAPABILITY_KEYS], EXPECTED_PROVIDER_KEYS);
});

test("SESSION_CAPABILITY_KEYS: length 11 and matches TDD §6.2 order exactly", () => {
  assert.equal(SESSION_CAPABILITY_KEYS.length, 11);
  assert.deepEqual([...SESSION_CAPABILITY_KEYS], EXPECTED_SESSION_KEYS);
});

// -- defaultProviderCapabilities -------------------------------------------

test("defaultProviderCapabilities: returns 20 keys all false; fresh object each call", () => {
  const a = defaultProviderCapabilities();
  assert.deepEqual(Object.keys(a).sort(), [...EXPECTED_PROVIDER_KEYS].sort());
  for (const key of EXPECTED_PROVIDER_KEYS) {
    assert.equal(a[key], false, `${key} should default to false`);
  }
  // Mutation isolation: tweaking one result must not affect the next.
  a.rawStdio = true;
  const b = defaultProviderCapabilities();
  assert.equal(b.rawStdio, false);
  assert.notEqual(a, b);
});

// -- validateProviderCapabilities -------------------------------------------

test("validateProviderCapabilities: rejects non-object", () => {
  assert.throws(() => validateProviderCapabilities(null), /must be an object/);
  assert.throws(() => validateProviderCapabilities("nope"), /must be an object/);
  assert.throws(() => validateProviderCapabilities([]), /must be an object/);
});

test("validateProviderCapabilities: rejects unknown key", () => {
  assert.throws(
    () => validateProviderCapabilities({ ...defaultProviderCapabilities(), bogus: true }),
    /unknown key 'bogus'/,
  );
});

test("validateProviderCapabilities: rejects non-boolean value at known key", () => {
  assert.throws(
    () => validateProviderCapabilities({ ...defaultProviderCapabilities(), rawStdio: "yes" }),
    /rawStdio must be boolean/,
  );
});

test("validateProviderCapabilities: accepts fully-false object", () => {
  const caps = defaultProviderCapabilities();
  assert.equal(validateProviderCapabilities(caps), caps);
});

test("validateProviderCapabilities: accepts fully-true object", () => {
  const caps = allTrueProviderCaps();
  assert.equal(validateProviderCapabilities(caps), caps);
});

// -- toSessionCapabilities mapping ------------------------------------------

test("toSessionCapabilities: all-false provider yields all-false session with exactly 11 keys", () => {
  const out = toSessionCapabilities(defaultProviderCapabilities());
  assert.deepEqual(Object.keys(out).sort(), [...EXPECTED_SESSION_KEYS].sort());
  for (const key of EXPECTED_SESSION_KEYS) {
    assert.equal(out[key], false, `${key} should be false for all-false input`);
  }
});

test("toSessionCapabilities: all-true provider obeys every §5 rule", () => {
  const out = toSessionCapabilities(allTrueProviderCaps());
  // pass-throughs
  assert.equal(out.rawStdio, true);
  assert.equal(out.stdinWrite, true);
  assert.equal(out.processLifecycle, true);
  assert.equal(out.structuredApprovals, true);
  assert.equal(out.directContextInjection, true);
  // OR-of-three thread flags
  assert.equal(out.structuredEvents, true);
  // structuredChat = structuredTurns
  assert.equal(out.structuredChat, true);
  // structuredCommands = structuredCommandEvents
  assert.equal(out.structuredCommands, true);
  // appServerChat = structuredTurns
  assert.equal(out.appServerChat, true);
  // ALWAYS false regardless of input
  assert.equal(out.structuredMcpCalls, false);
  assert.equal(out.explicitTrackerMcp, false);
});

test("toSessionCapabilities: structuredEvents is OR of (thread, turns, items)", () => {
  // Only items set → structuredEvents true
  const onlyItems = { ...defaultProviderCapabilities(), structuredItems: true };
  assert.equal(toSessionCapabilities(onlyItems).structuredEvents, true);

  // Only thread set → structuredEvents true
  const onlyThread = { ...defaultProviderCapabilities(), structuredThread: true };
  assert.equal(toSessionCapabilities(onlyThread).structuredEvents, true);

  // Only turns set → structuredEvents true
  const onlyTurns = { ...defaultProviderCapabilities(), structuredTurns: true };
  assert.equal(toSessionCapabilities(onlyTurns).structuredEvents, true);

  // All three false → structuredEvents false (even with other flags set)
  const noneOfThree = {
    ...defaultProviderCapabilities(),
    structuredApprovals: true,
    structuredFileChanges: true,
    structuredCommandEvents: true,
  };
  assert.equal(toSessionCapabilities(noneOfThree).structuredEvents, false);
});

test("toSessionCapabilities: structuredMcpCalls and explicitTrackerMcp are ALWAYS false", () => {
  // Even with everything on, these two stay false (not provider-derivable).
  const allTrue = toSessionCapabilities(allTrueProviderCaps());
  assert.equal(allTrue.structuredMcpCalls, false);
  assert.equal(allTrue.explicitTrackerMcp, false);

  // And with everything off.
  const allFalse = toSessionCapabilities(defaultProviderCapabilities());
  assert.equal(allFalse.structuredMcpCalls, false);
  assert.equal(allFalse.explicitTrackerMcp, false);
});
