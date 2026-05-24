// hub/runtime/__tests__/coverage-gaps.test.js
//
// SH-1-10 coverage-gap fillers. The Phase 1 modules already enjoy 90%+ line
// coverage from per-module unit tests, but a few error-path branches in
// atomic.js are unexercised. This file adds the minimal targeted tests
// needed to lift atomic.js above the 85% line-coverage threshold required
// by the SH-1-10 DoD.
//
// Each test focuses on a single uncovered branch — no broad assertions, no
// scenario coverage (the §20.1 scenarios live in phase1-acceptance.test.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { atomicWriteJson } from "../atomic.js";

async function makeTmp() {
  return await mkdtemp(path.join(tmpdir(), "lt-cov-"));
}

// --- atomic.js line 42-48: JSON.stringify(undefined) returns undefined ----
// The circular-ref test in test/runtime-atomic.test.js covers the THROW path
// inside JSON.stringify, but not the case where the stringifier returns
// undefined (which happens for `undefined`, raw functions, and symbols).
test("atomicWriteJson throws when JSON.stringify returns undefined (raw undefined value)", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "snap.json");
    await assert.rejects(
      async () => atomicWriteJson(target, undefined),
      /did not produce JSON output/,
    );
    // No .tmp residue — we throw before opening the tmp file.
    const entries = await readdir(dir);
    assert.deepEqual(
      entries.filter((e) => e.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson throws when JSON.stringify returns undefined (raw function)", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "snap.json");
    await assert.rejects(
      async () => atomicWriteJson(target, () => {}),
      /did not produce JSON output/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- atomic.js lines 51-66: error during write/rename cleans up tmp ------
// Forcing a real I/O failure cross-platform: make `target` itself an
// existing directory. `rename(tmp, target)` then fails with EISDIR / EACCES
// and the catch block must unlink the tmp file.
test("atomicWriteJson cleans up tmp file when rename fails (target is a directory)", async () => {
  const dir = await makeTmp();
  try {
    const target = path.join(dir, "snap.json");
    // Pre-create `target` as a directory so rename(tmp, target) fails.
    await mkdir(target, { recursive: true });
    await assert.rejects(async () => atomicWriteJson(target, { ok: true }));
    // The catch block must have cleaned up the .tmp sibling.
    const entries = await readdir(dir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));
    assert.deepEqual(tmps, [], `expected no .tmp leftovers, got ${JSON.stringify(tmps)}`);
    // The pre-existing directory still exists.
    const s = await stat(target);
    assert.equal(s.isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
