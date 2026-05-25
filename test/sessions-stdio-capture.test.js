// test/sessions-stdio-capture.test.js — SH-2-04 (TDD v0.5 §19.3, §25)
//
// Acceptance tests for the in-memory stdio ring + on-disk rotation modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryRing } from "../hub/sessions/stdio/ring.js";
import { createStdioCapture } from "../hub/sessions/stdio/rotation.js";

function makeTmp(label) {
  return mkdtempSync(join(tmpdir(), `lt-stdio-${label}-`));
}

function logDir(baseDir) {
  return join(baseDir, "session-stdio");
}

// -- memory ring ------------------------------------------------------------

test("ring: append → snapshot returns appended bytes in order", () => {
  const ring = createMemoryRing({ maxBytes: 64 });
  ring.append("hello ");
  ring.append(Buffer.from("world"));
  assert.equal(ring.snapshot().toString("utf8"), "hello world");
  assert.equal(ring.bytes, 11);
  assert.equal(ring.drop, 0);
});

test("ring: overflow drops oldest bytes FIFO and counts dropped", () => {
  const ring = createMemoryRing({ maxBytes: 8 });
  ring.append("ABCDEFGH"); // exactly fills
  assert.equal(ring.snapshot().toString("utf8"), "ABCDEFGH");
  assert.equal(ring.drop, 0);
  ring.append("IJ"); // drops "AB"
  assert.equal(ring.snapshot().toString("utf8"), "CDEFGHIJ");
  assert.equal(ring.drop, 2);
  ring.append("KLMNOPQRSTU"); // 11 bytes; only trailing 8 survive
  assert.equal(ring.snapshot().toString("utf8"), "NOPQRSTU");
  // Dropped: prior 2 + remaining 8 from this batch (CDEFGHIJ all evicted,
  // plus the leading 3 of this chunk that fell off the back of the ring).
  assert.equal(ring.drop, 2 + 8 + 3);
});

// -- capture OFF (default) --------------------------------------------------

test("capture OFF: no log file is created; ring still populates", async () => {
  const baseDir = makeTmp("off");
  try {
    const cap = createStdioCapture({ sessionId: "ses_x", baseDir });
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      await cap.append(`chunk-${i}\n`);
    }
    assert.equal(existsSync(logDir(baseDir)), false, "no session-stdio dir");
    assert.ok(cap.snapshot().length > 0, "ring populated");
    const s = cap.state();
    assert.equal(s.liveTail, true);
    assert.equal(s.captureToDisk, false);
    assert.equal(s.memoryRingBytes, 262144);
    assert.equal(s.maxBytes, 5242880);
    assert.equal(s.rotatedSegments, 3);
    assert.equal(s.currentLogBytes, undefined);
    assert.equal(s.rotatedSegmentCount, undefined);
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// -- capture ON, under cap --------------------------------------------------

test("capture ON, under cap: writes to live log; state tracks currentLogBytes", async () => {
  const baseDir = makeTmp("on-under");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_a",
      baseDir,
      captureToDisk: true,
      maxBytes: 1024,
      rotatedSegments: 3,
      promptOnFirstCapture: false,
    });
    const res = await cap.append("hello\n");
    assert.equal(res.rotated, false);
    assert.equal(res.segmentCount, 0);
    assert.equal(res.currentLogBytes, 6);
    const live = join(logDir(baseDir), "ses_a.log");
    assert.equal(statSync(live).size, 6);
    assert.equal(cap.state().currentLogBytes, 6);
    assert.equal(cap.state().rotatedSegmentCount, 0);
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// -- capture ON, over cap: rotation -----------------------------------------

test("capture ON, over cap: rotates and starts a fresh live log", async () => {
  const baseDir = makeTmp("rotate");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_r",
      baseDir,
      captureToDisk: true,
      maxBytes: 100,
      rotatedSegments: 3,
      promptOnFirstCapture: false,
    });
    // Fill below cap.
    let res = await cap.append(Buffer.alloc(80, 0x41)); // 80 'A'
    assert.equal(res.rotated, false);
    assert.equal(res.currentLogBytes, 80);
    // Next append (50 bytes) pushes 80+50=130 > 100 → rotate.
    res = await cap.append(Buffer.alloc(50, 0x42)); // 50 'B'
    assert.equal(res.rotated, true);
    assert.equal(res.segmentCount, 1);
    assert.equal(res.currentLogBytes, 50, "live log is fresh after rotation");
    const dir = logDir(baseDir);
    assert.equal(statSync(join(dir, "ses_r.1.log")).size, 80, ".1.log holds prior bytes");
    assert.equal(statSync(join(dir, "ses_r.log")).size, 50, "live log freshly started");
    assert.equal(cap.state().rotatedSegmentCount, 1);
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("capture ON, first oversized append is split into bounded live/rotated segments", async () => {
  const baseDir = makeTmp("oversized-first");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_big",
      baseDir,
      captureToDisk: true,
      maxBytes: 100,
      rotatedSegments: 3,
      promptOnFirstCapture: false,
    });
    const res = await cap.append(Buffer.alloc(250, 0x58));
    assert.equal(res.rotated, true);
    assert.equal(res.segmentCount, 2);
    assert.equal(res.currentLogBytes, 50);

    const dir = logDir(baseDir);
    assert.equal(statSync(join(dir, "ses_big.log")).size, 50, "live log stays under cap");
    assert.equal(statSync(join(dir, "ses_big.1.log")).size, 100, ".1.log is a capped segment");
    assert.equal(statSync(join(dir, "ses_big.2.log")).size, 100, ".2.log is a capped segment");
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("capture ON: concurrent appends serialize disk rotation state", async () => {
  const baseDir = makeTmp("concurrent");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_q",
      baseDir,
      captureToDisk: true,
      maxBytes: 100,
      rotatedSegments: 3,
      promptOnFirstCapture: false,
    });
    const results = await Promise.all([
      cap.append(Buffer.alloc(80, 0x41)),
      cap.append(Buffer.alloc(80, 0x42)),
      cap.append(Buffer.alloc(80, 0x43)),
      cap.append(Buffer.alloc(80, 0x44)),
    ]);
    assert.equal(results.some((r) => r.rotated), true, "at least one append reports rotation");
    assert.equal(cap.state().rotatedSegmentCount, 3);

    const dir = logDir(baseDir);
    const files = readdirSync(dir).filter((f) => f.startsWith("ses_q"));
    assert.equal(files.length, 4, "1 live + 3 rotated files");
    for (const file of files) {
      assert.ok(statSync(join(dir, file)).size <= 100, `${file} must stay under maxBytes`);
    }
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// -- capture ON, exceeds rotatedSegments cap --------------------------------

test("capture ON: oldest rotated segment is deleted when retention cap exceeded", async () => {
  const baseDir = makeTmp("retention");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_k",
      baseDir,
      captureToDisk: true,
      maxBytes: 100,
      rotatedSegments: 3,
      promptOnFirstCapture: false,
    });
    // Drive 5 rotations: each cycle fills the live log past 100 bytes.
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await cap.append(Buffer.alloc(90, 0x30 + i));
      // eslint-disable-next-line no-await-in-loop
      await cap.append(Buffer.alloc(90, 0x30 + i)); // forces rotate next call
    }
    // Force one more rotation by appending past cap.
    await cap.append(Buffer.alloc(90, 0x5a));
    const dir = logDir(baseDir);
    const files = readdirSync(dir).filter((f) => f.startsWith("ses_k"));
    // 1 live + at most 3 rotated = 4 files.
    assert.equal(files.length, 1 + 3);
    assert.ok(files.includes("ses_k.log"));
    assert.ok(files.includes("ses_k.1.log"));
    assert.ok(files.includes("ses_k.2.log"));
    assert.ok(files.includes("ses_k.3.log"));
    assert.equal(cap.state().rotatedSegmentCount, 3);
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// -- first-capture ack gate -------------------------------------------------

test("ack gate: capture-on without ack does not write to disk; flips on ack", async () => {
  const baseDir = makeTmp("ack");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_g",
      baseDir,
      captureToDisk: false,
      promptOnFirstCapture: true,
      maxBytes: 1024,
    });
    cap.setCaptureToDisk(true, { ackProvided: false });
    assert.equal(cap.needsAck(), true, "needsAck flagged after toggle without ack");
    await cap.append("secret-payload\n");
    const dir = logDir(baseDir);
    assert.equal(existsSync(join(dir, "ses_g.log")), false, "no disk write while needsAck");
    assert.ok(cap.snapshot().length > 0, "ring still receives bytes");

    cap.setCaptureToDisk(true, { ackProvided: true });
    assert.equal(cap.needsAck(), false);
    await cap.append("after-ack\n");
    assert.ok(existsSync(join(dir, "ses_g.log")), "live log appears after ack");
    const live = await fsp.readFile(join(dir, "ses_g.log"), "utf8");
    assert.equal(live, "after-ack\n", "only post-ack bytes hit disk");
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// -- toggling capture off mid-session ---------------------------------------

test("toggle off → on: existing live log is preserved; new bytes resume to disk", async () => {
  const baseDir = makeTmp("toggle");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_t",
      baseDir,
      captureToDisk: true,
      maxBytes: 10_000,
      rotatedSegments: 3,
      promptOnFirstCapture: false,
    });
    await cap.append("first\n");
    const live = join(logDir(baseDir), "ses_t.log");
    assert.equal((await fsp.readFile(live, "utf8")), "first\n");

    // Turn capture OFF; new bytes go only to ring.
    cap.setCaptureToDisk(false);
    await cap.append("ring-only\n");
    assert.equal((await fsp.readFile(live, "utf8")), "first\n", "live log untouched while off");
    assert.equal(cap.state().captureToDisk, false);

    // Turn back ON (ack already provided implicitly: promptOnFirstCapture=false);
    // new bytes append to the SAME live log without resetting the segment counter.
    cap.setCaptureToDisk(true);
    const segmentCountBefore = cap.state().rotatedSegmentCount;
    await cap.append("resumed\n");
    assert.equal((await fsp.readFile(live, "utf8")), "first\nresumed\n");
    assert.equal(cap.state().rotatedSegmentCount, segmentCountBefore, "segment counter unchanged");
    await cap.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// -- close() idempotency ----------------------------------------------------

test("close() is idempotent", async () => {
  const baseDir = makeTmp("close");
  try {
    const cap = createStdioCapture({
      sessionId: "ses_c",
      baseDir,
      captureToDisk: true,
      promptOnFirstCapture: false,
    });
    await cap.append("x");
    await cap.close();
    await cap.close(); // must not throw
    await assert.rejects(() => cap.append("y"), /append after close/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
