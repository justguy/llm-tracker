// test/runtime-atomic.test.js — sh-1-04 (TDD v0.5 §5.5)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteJson } from "../hub/runtime/atomic.js";

async function makeTmp() {
  return await mkdtemp(path.join(tmpdir(), "lt-atomic-"));
}

test("atomicWriteJson writes JSON to the target path (minified by default)", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "snapshot.json");
    const obj = { a: 1, b: [2, 3], c: { d: "hello" } };
    await atomicWriteJson(target, obj);
    const raw = await readFile(target, "utf8");
    assert.equal(raw, JSON.stringify(obj));
    assert.deepEqual(JSON.parse(raw), obj);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson creates the parent directory if missing", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "nested", "deep", "snapshot.json");
    await atomicWriteJson(target, { ok: true });
    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson leaves no .tmp files behind on the happy path", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "snap.json");
    for (let i = 0; i < 5; i++) {
      await atomicWriteJson(target, { i });
    }
    const entries = await readdir(dir);
    const tmps = entries.filter((e) => e.includes(".tmp"));
    assert.deepEqual(tmps, [], `expected no .tmp leftovers, got ${JSON.stringify(tmps)}`);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { i: 4 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson cleans up temp and rethrows on serialization failure", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "snap.json");
    // Seed a known-good file so we can verify it stays untouched.
    await atomicWriteJson(target, { before: true });

    const circular = { x: 1 };
    circular.self = circular;

    await assert.rejects(
      async () => atomicWriteJson(target, circular),
      /circular|cyclic|JSON/i,
    );

    // Original target file remains intact and parseable.
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { before: true });

    // No .tmp residue.
    const entries = await readdir(dir);
    const tmps = entries.filter((e) => e.includes(".tmp"));
    assert.deepEqual(tmps, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson overwrites an existing target atomically", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "snap.json");
    await writeFile(target, "garbage-not-json", "utf8");
    await atomicWriteJson(target, { fresh: true });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { fresh: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent atomicWriteJson calls leave a valid final JSON file (last writer wins)", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "race.json");
    const N = 20;
    const writes = [];
    for (let i = 0; i < N; i++) {
      writes.push(atomicWriteJson(target, { i, payload: "x".repeat(64) }));
    }
    await Promise.all(writes);

    // Whichever rename wins, the file must always be valid JSON — never
    // a partial write — and the contents must equal one of the inputs.
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(Number.isInteger(parsed.i) && parsed.i >= 0 && parsed.i < N);
    assert.equal(parsed.payload, "x".repeat(64));

    // No leftover .tmp files after the storm settles.
    const entries = await readdir(dir);
    const tmps = entries.filter((e) => e.includes(".tmp"));
    assert.deepEqual(tmps, [], `expected no .tmp leftovers, got ${JSON.stringify(tmps)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson with { pretty: true } emits multi-line JSON", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "pretty.json");
    const obj = { a: 1, b: { c: 2 } };
    await atomicWriteJson(target, obj, { pretty: true });
    const raw = await readFile(target, "utf8");
    assert.ok(raw.includes("\n"), "pretty output should contain newlines");
    assert.ok(raw.includes("  "), "pretty output should contain indent spaces");
    assert.deepEqual(JSON.parse(raw), obj);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson default output is single-line", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "min.json");
    const obj = { a: 1, b: { c: 2 } };
    await atomicWriteJson(target, obj);
    const raw = await readFile(target, "utf8");
    assert.ok(!raw.includes("\n"), `minified output should have no newlines, got ${JSON.stringify(raw)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson rejects empty/invalid target paths", async () => {
  await assert.rejects(async () => atomicWriteJson("", { a: 1 }), /target/);
  await assert.rejects(async () => atomicWriteJson(undefined, { a: 1 }), /target/);
});

test("atomicWriteJson written file is at least the size of the encoded payload", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "size.json");
    const obj = { msg: "hello world" };
    await atomicWriteJson(target, obj);
    const s = await stat(target);
    assert.equal(s.size, Buffer.byteLength(JSON.stringify(obj), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
