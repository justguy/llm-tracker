// test/runtime-snapshots.test.js — sh-1-04 (TDD v0.5 §5.2, §5.4)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, appendFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJsonlLine, readJsonlLines } from "../hub/runtime/snapshots.js";

async function makeTmp() {
  return await mkdtemp(path.join(tmpdir(), "lt-jsonl-"));
}

test("appendJsonlLine on empty/new file writes one line ending in \\n", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "events.jsonl");
    await appendJsonlLine(target, { id: "evt_1", type: "session.started" });
    const raw = await readFile(target, "utf8");
    assert.ok(raw.endsWith("\n"), `file should end in newline, got ${JSON.stringify(raw)}`);
    assert.equal(raw.split("\n").filter(Boolean).length, 1);
    assert.deepEqual(JSON.parse(raw.trim()), { id: "evt_1", type: "session.started" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendJsonlLine creates the parent directory if missing", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "nested", "events.jsonl");
    await appendJsonlLine(target, { ok: true });
    const raw = await readFile(target, "utf8");
    assert.equal(raw, JSON.stringify({ ok: true }) + "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("three appendJsonlLine calls yield exactly three parseable lines", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "events.jsonl");
    const events = [
      { id: "evt_1", n: 1 },
      { id: "evt_2", n: 2, nested: { ok: true } },
      { id: "evt_3", n: 3, arr: [1, 2, 3] },
    ];
    for (const e of events) await appendJsonlLine(target, e);
    const raw = await readFile(target, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed, events);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonlLines round-trips a sequence of appends", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "events.jsonl");
    const events = [
      { id: "evt_1", type: "a" },
      { id: "evt_2", type: "b" },
      { id: "evt_3", type: "c" },
    ];
    for (const e of events) await appendJsonlLine(target, e);
    const res = await readJsonlLines(target);
    assert.deepEqual(res.events, events);
    assert.equal(res.corruptedAt, null);
    assert.equal(res.recoveryWarning, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonlLines stops at the first corrupt line and reports it (§5.4 step 4)", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "events.jsonl");
    // Valid, valid, BROKEN, valid — should yield 2 events with corruptedAt=3.
    await appendJsonlLine(target, { id: "evt_1", n: 1 });
    await appendJsonlLine(target, { id: "evt_2", n: 2 });
    await appendFile(target, "{not-json,broken\n", "utf8");
    await appendJsonlLine(target, { id: "evt_4", n: 4 });

    const res = await readJsonlLines(target);
    assert.equal(res.events.length, 2);
    assert.deepEqual(res.events.map((e) => e.id), ["evt_1", "evt_2"]);
    assert.equal(res.corruptedAt, 3);
    assert.match(res.recoveryWarning, /JSONL corrupt/);
    assert.match(res.recoveryWarning, /:3:/);
    assert.match(res.recoveryWarning, /halted at last valid event/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonlLines treats a missing file as an empty log (ENOENT → empty result)", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "does-not-exist.jsonl");
    const res = await readJsonlLines(target);
    assert.deepEqual(res, { events: [], corruptedAt: null, recoveryWarning: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonlLines on a totally empty file returns empty result", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "empty.jsonl");
    await writeFile(target, "", "utf8");
    const res = await readJsonlLines(target);
    assert.deepEqual(res, { events: [], corruptedAt: null, recoveryWarning: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonlLines flags a partial trailing write as corruption", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "partial.jsonl");
    await appendJsonlLine(target, { id: "evt_1", n: 1 });
    // Simulate a torn write: bytes flushed but no terminating newline.
    await appendFile(target, '{"id":"evt_2","n":2', "utf8");
    const res = await readJsonlLines(target);
    assert.equal(res.events.length, 1);
    assert.equal(res.corruptedAt, 2);
    assert.match(res.recoveryWarning, /JSONL corrupt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendJsonlLine rejects values whose JSON would embed a raw newline (sanity guard)", async () => {
  // JSON.stringify normally escapes \n inside strings so it shouldn't fire
  // for legitimate inputs; verify by mocking toJSON to inject one.
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "events.jsonl");
    const bad = {
      toJSON() {
        // Return a string literal that JSON.stringify will quote, then
        // splice in a raw newline by returning a pre-built JSON fragment.
        // Because toJSON returns a string, JSON.stringify will quote it
        // and escape the \n — so to actually trip the guard we wrap that
        // returned string in a hand-rolled object whose top-level
        // JSON.stringify result contains \n. Easiest path: have toJSON
        // return an object whose key contains a newline (keys are
        // emitted between quotes and JSON.stringify DOES escape \n there
        // too) — so use a sentinel detector below instead.
        return { ok: true };
      },
    };
    // Above shows it's hard to naturally hit the guard. Force it by
    // patching JSON.stringify briefly to return a newline-bearing string.
    const orig = JSON.stringify;
    JSON.stringify = () => 'bad\nvalue';
    try {
      await assert.rejects(
        async () => appendJsonlLine(target, bad),
        /raw newline/,
      );
    } finally {
      JSON.stringify = orig;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendJsonlLine rejects values that JSON.stringify cannot serialize", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "events.jsonl");
    const orig = JSON.stringify;
    // Force stringify to return undefined (mirrors top-level functions/undefined).
    JSON.stringify = () => undefined;
    try {
      await assert.rejects(
        async () => appendJsonlLine(target, { whatever: true }),
        /did not produce JSON output/,
      );
    } finally {
      JSON.stringify = orig;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendJsonlLine rejects empty/invalid targets", async () => {
  await assert.rejects(async () => appendJsonlLine("", { a: 1 }), /target/);
  await assert.rejects(async () => appendJsonlLine(undefined, { a: 1 }), /target/);
});

test("1000 sequential appendJsonlLine calls produce exactly 1000 valid lines", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "many.jsonl");
    const N = 1000;
    for (let i = 0; i < N; i++) {
      await appendJsonlLine(target, { i, p: `payload-${i}` });
    }
    const raw = await readFile(target, "utf8");
    assert.ok(raw.endsWith("\n"));
    const lines = raw.split("\n");
    // trailing newline produces an empty trailing entry — drop it.
    if (lines[lines.length - 1] === "") lines.pop();
    assert.equal(lines.length, N);

    const res = await readJsonlLines(target);
    assert.equal(res.events.length, N);
    assert.equal(res.corruptedAt, null);
    assert.equal(res.events[0].i, 0);
    assert.equal(res.events[N - 1].i, N - 1);

    // Sanity: total bytes equal sum of (line + "\n") byte lengths.
    const expected = res.events.reduce(
      (sum, e) => sum + Buffer.byteLength(JSON.stringify(e) + "\n", "utf8"),
      0,
    );
    const s = await stat(target);
    assert.equal(s.size, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
