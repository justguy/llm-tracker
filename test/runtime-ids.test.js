// test/runtime-ids.test.js — sh-1-01 (TDD v0.5 §6.10, §23.2 #9)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeRuntimeId,
  makeUlid,
  isSessionId,
  isJobId,
  isRuntimeEventId,
  isSkillRunId,
  isContextPackId,
  isAttentionItemId,
  isRuntimeId,
  SESSION_ID_RE,
  JOB_ID_RE,
  RUNTIME_EVENT_ID_RE,
  SKILL_RUN_ID_RE,
  CONTEXT_PACK_ID_RE,
  ATTENTION_ITEM_ID_RE,
  RUNTIME_ID_ALPHABET,
  RUNTIME_ID_PREFIXES,
} from "../hub/runtime/ids.js";

const PREFIX_TABLE = [
  { prefix: "ses", re: SESSION_ID_RE, guard: isSessionId },
  { prefix: "job", re: JOB_ID_RE, guard: isJobId },
  { prefix: "evt", re: RUNTIME_EVENT_ID_RE, guard: isRuntimeEventId },
  { prefix: "skr", re: SKILL_RUN_ID_RE, guard: isSkillRunId },
  { prefix: "ctx", re: CONTEXT_PACK_ID_RE, guard: isContextPackId },
  { prefix: "att", re: ATTENTION_ITEM_ID_RE, guard: isAttentionItemId },
];

test("makeRuntimeId produces 3-char prefix + underscore + 26-char Crockford body for every prefix", () => {
  for (const { prefix, re, guard } of PREFIX_TABLE) {
    const id = makeRuntimeId(prefix);
    assert.equal(id.length, 30, `len for ${prefix}`);
    assert.equal(id.slice(0, 4), `${prefix}_`);
    assert.equal(id.slice(4).length, 26);
    assert.ok(re.test(id), `${prefix} regex did not match: ${id}`);
    assert.ok(guard(id), `${prefix} guard returned false for ${id}`);
  }
});

test("RUNTIME_ID_PREFIXES exposes the canonical 6 prefixes", () => {
  assert.deepEqual([...RUNTIME_ID_PREFIXES], ["ses", "job", "evt", "skr", "ctx", "att"]);
});

test("makeRuntimeId rejects unknown prefixes", () => {
  assert.throws(() => makeRuntimeId("xxx"), /invalid prefix/);
  assert.throws(() => makeRuntimeId(""), /invalid prefix/);
  assert.throws(() => makeRuntimeId(undefined), /invalid prefix/);
  assert.throws(() => makeRuntimeId(123), /invalid prefix/);
});

test("ID body uses only Crockford lower-case alphabet (no i, l, o, u)", () => {
  // Generate enough IDs to surface any byte → char encoding leak.
  const forbidden = new Set(["i", "l", "o", "u"]);
  for (let i = 0; i < 2000; i++) {
    const id = makeRuntimeId("evt");
    const body = id.slice(4);
    for (const ch of body) {
      assert.ok(!forbidden.has(ch), `forbidden char ${ch} in ${id}`);
      assert.ok(RUNTIME_ID_ALPHABET.includes(ch), `char ${ch} not in alphabet (${id})`);
    }
  }
});

test("IDs are all lower-case", () => {
  for (let i = 0; i < 200; i++) {
    const id = makeRuntimeId("ses");
    assert.equal(id, id.toLowerCase(), `id should be lower-case: ${id}`);
  }
});

test("IDs are URL/JSON/MCP-arg safe — only [a-z0-9_]", () => {
  const safe = /^[a-z0-9_]+$/;
  for (const { prefix } of PREFIX_TABLE) {
    for (let i = 0; i < 100; i++) {
      const id = makeRuntimeId(prefix);
      assert.ok(safe.test(id), `not URL-safe: ${id}`);
      // Round-trip through JSON unchanged.
      assert.equal(JSON.parse(JSON.stringify(id)), id);
      // Round-trip through encodeURIComponent unchanged (no escaping needed).
      assert.equal(encodeURIComponent(id), id);
    }
  }
});

test("IDs are filename-safe (no separators, no leading dot, no Windows-reserved chars)", () => {
  const bad = /[\\/:*?"<>|]/;
  for (let i = 0; i < 500; i++) {
    const id = makeRuntimeId("job");
    assert.ok(!bad.test(id), `bad filename char in ${id}`);
    assert.notEqual(id[0], ".", `leading dot in ${id}`);
    assert.notEqual(id[0], "-", `leading dash in ${id}`);
  }
});

test("100k generated IDs are unique (smoke test)", () => {
  const seen = new Set();
  for (let i = 0; i < 100_000; i++) {
    const id = makeRuntimeId("evt");
    if (seen.has(id)) {
      throw new Error(`duplicate ID generated: ${id} on iter ${i}`);
    }
    seen.add(id);
  }
  assert.equal(seen.size, 100_000);
});

test("isSessionId / isJobId / ... reject mismatched prefixes", () => {
  const ses = makeRuntimeId("ses");
  const job = makeRuntimeId("job");
  const evt = makeRuntimeId("evt");
  assert.ok(isSessionId(ses));
  assert.ok(!isSessionId(job));
  assert.ok(!isSessionId(evt));
  assert.ok(isJobId(job));
  assert.ok(!isJobId(ses));
  assert.ok(isRuntimeEventId(evt));
  assert.ok(!isRuntimeEventId(ses));
});

test("guards reject non-strings and malformed strings", () => {
  for (const guard of [
    isSessionId,
    isJobId,
    isRuntimeEventId,
    isSkillRunId,
    isContextPackId,
    isAttentionItemId,
    isRuntimeId,
  ]) {
    assert.equal(guard(undefined), false);
    assert.equal(guard(null), false);
    assert.equal(guard(""), false);
    assert.equal(guard(123), false);
    assert.equal(guard({}), false);
    assert.equal(guard([]), false);
    assert.equal(guard("ses_"), false);
    assert.equal(guard("ses_TOOSHORT"), false);
    assert.equal(guard("SES_01jv8q9f4x8y7z6w5v4t3s2r1q"), false); // upper-case
    assert.equal(guard("ses_01jv8q9f4x8y7z6w5v4t3s2r1q "), false); // trailing space
  }
});

test("guards reject Crockford-forbidden chars in body", () => {
  // 26-char bodies containing i, l, o, u — must fail the regex.
  for (const ch of ["i", "l", "o", "u"]) {
    const bad = "ses_" + ch.repeat(26);
    assert.equal(isSessionId(bad), false, `should reject ${bad}`);
  }
});

test("isRuntimeId accepts every prefix flavour and rejects others", () => {
  for (const { prefix } of PREFIX_TABLE) {
    assert.ok(isRuntimeId(makeRuntimeId(prefix)), prefix);
  }
  assert.equal(isRuntimeId("foo_01jv8q9f4x8y7z6w5v4t3s2r1q"), false);
  assert.equal(isRuntimeId("ses01jv8q9f4x8y7z6w5v4t3s2r1q"), false);
});

test("makeUlid encoder reproduces a known timestamp prefix deterministically", () => {
  // ULID timestamp encodes ms since epoch into the first 10 base-32 chars,
  // so two ULIDs minted with the same `now` share their 10-char prefix.
  const fixedNow = 1700000000000;
  const a = makeUlid(fixedNow);
  const b = makeUlid(fixedNow);
  assert.equal(a.length, 26);
  assert.equal(b.length, 26);
  assert.equal(a.slice(0, 10), b.slice(0, 10), "timestamp prefix should be stable");
  assert.notEqual(a.slice(10), b.slice(10), "random suffix should differ");
});

test("makeUlid timestamp is monotonic across increasing `now`", () => {
  // Lexicographic ordering of Crockford base32 matches numeric order, so a
  // larger `now` MUST produce a body that sorts after a smaller `now`.
  const a = makeUlid(1000);
  const b = makeUlid(2000);
  assert.ok(b.slice(0, 10) > a.slice(0, 10), `${b} should sort after ${a}`);
});

test("makeUlid rejects malformed timestamps", () => {
  assert.throws(() => makeUlid(-1), /non-negative/);
  assert.throws(() => makeUlid(1.5), /non-negative/);
  assert.throws(() => makeUlid(Number.NaN), /non-negative/);
  assert.throws(() => makeUlid(0xffffffffffff + 1), /48-bit/);
});
