// hub/sessions/stdio/rotation.js — SH-2-04 (TDD v0.5 §19.3, §25, §5.1)
//
// Stdio capture controller — pairs the in-memory live ring (always on) with
// optional disk capture (default OFF). The disk side writes a live log and
// rolls it to numbered segments when it exceeds maxBytes.
//
// Rotation convention:
//   `<sessionId>.log` is the live log. When it exceeds maxBytes, it is renamed
//   to `<sessionId>.1.log`; any pre-existing `.1.log` shifts to `.2.log`, etc.
//   Segments beyond `rotatedSegments` are deleted. So `.1.log` is always the
//   most-recently-rotated segment; the highest n is the oldest survivor.
//
// First-capture ack gate (TDD §19.3 secrets caveat): if promptOnFirstCapture
// is true and the workspace has not yet acked the secrets caveat for this
// session, bytes are NOT written to disk until ackProvided=true is supplied.
// The caller is responsible for showing the UI prompt.
//
// This module intentionally does NOT emit RuntimeEvents. A rotation-pressure
// signal (`rotated: true`, segmentCount) is returned from `append()` so the
// adapter wiring (a separate task) can map it onto `stdio_capture_oversized`.

import { promises as fsp } from "node:fs";
import { join } from "node:path";

import { createMemoryRing } from "./ring.js";

/**
 * @typedef {object} SessionStdioState
 * @property {boolean} liveTail              Always true per §25 defaults.
 * @property {boolean} captureToDisk         Whether disk capture is enabled.
 * @property {number}  memoryRingBytes       Ring capacity.
 * @property {number}  maxBytes              Per-segment disk cap.
 * @property {number}  rotatedSegments       Number of rotated segments retained.
 * @property {number}  [currentLogBytes]     Live log size (capture on only).
 * @property {number}  [rotatedSegmentCount] Rotated segments on disk (capture on only).
 */

/**
 * @typedef {object} AppendResult
 * @property {boolean} rotated
 * @property {number}  segmentCount       Rotated segments on disk after the call.
 * @property {number}  currentLogBytes    Live log size after the call.
 */

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.baseDir               Workspace runtime root; logs live in `${baseDir}/session-stdio/`.
 * @param {boolean} [opts.captureToDisk]      Default false.
 * @param {number}  [opts.memoryRingBytes]    Default 262144.
 * @param {number}  [opts.maxBytes]           Default 5242880.
 * @param {number}  [opts.rotatedSegments]    Default 3.
 * @param {boolean} [opts.promptOnFirstCapture] Default true.
 * @param {boolean} [opts.ackProvided]        Default false.
 */
export function createStdioCapture({
  sessionId,
  baseDir,
  captureToDisk = false,
  memoryRingBytes = 262144,
  maxBytes = 5242880,
  rotatedSegments = 3,
  promptOnFirstCapture = true,
  ackProvided = false,
} = {}) {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new TypeError("createStdioCapture: sessionId required");
  }
  if (typeof baseDir !== "string" || !baseDir) {
    throw new TypeError("createStdioCapture: baseDir required");
  }
  if (!Number.isInteger(memoryRingBytes) || memoryRingBytes <= 0) {
    throw new TypeError("createStdioCapture: memoryRingBytes must be a positive integer");
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("createStdioCapture: maxBytes must be a positive integer");
  }
  if (!Number.isInteger(rotatedSegments) || rotatedSegments < 0) {
    throw new TypeError("createStdioCapture: rotatedSegments must be a non-negative integer");
  }

  const ring = createMemoryRing({ maxBytes: memoryRingBytes });
  const logDir = join(baseDir, "session-stdio");
  const livePath = join(logDir, `${sessionId}.log`);
  const segPath = (n) => join(logDir, `${sessionId}.${n}.log`);

  let _captureToDisk = !!captureToDisk;
  let _ack = !!ackProvided;
  let currentLogBytes = 0;
  let segmentCount = 0;
  let dirReady = false;
  let closed = false;
  let appendQueue = Promise.resolve();

  // Whether capture is *effectively* writing to disk (i.e. ack gate cleared).
  function canWriteDisk() {
    if (!_captureToDisk) return false;
    if (promptOnFirstCapture && !_ack) return false;
    return true;
  }

  async function ensureDir() {
    if (dirReady) return;
    await fsp.mkdir(logDir, { recursive: true });
    dirReady = true;
  }

  // Shift `.{rotatedSegments-1}.log` → `.{rotatedSegments}.log`, ..., live → `.1.log`.
  // Anything that would land beyond `rotatedSegments` is unlinked.
  async function rotate() {
    // Unlink any segment that would be pushed off the end.
    if (rotatedSegments === 0) {
      // No retention — just discard the live log.
      await safeUnlink(livePath);
    } else {
      // Drop the oldest survivor if present.
      await safeUnlink(segPath(rotatedSegments));
      // Shift remaining segments down: n → n+1 for n in [rotatedSegments-1 .. 1].
      for (let n = rotatedSegments - 1; n >= 1; n--) {
        await safeRename(segPath(n), segPath(n + 1));
      }
      // Move live → .1.log.
      await safeRename(livePath, segPath(1));
    }
    // Recompute segmentCount from disk to stay honest.
    segmentCount = await countSegments();
    currentLogBytes = 0;
  }

  async function countSegments() {
    let n = 0;
    for (let i = 1; i <= rotatedSegments; i++) {
      // eslint-disable-next-line no-await-in-loop
      if (await exists(segPath(i))) n++;
    }
    return n;
  }

  async function appendDisk(data) {
    await ensureDir();
    let rotated = false;

    let offset = 0;
    while (offset < data.length) {
      const remaining = data.length - offset;
      if (currentLogBytes > 0 && currentLogBytes + remaining > maxBytes) {
        await rotate();
        rotated = true;
      }

      const available = currentLogBytes === 0 ? maxBytes : maxBytes - currentLogBytes;
      const take = Math.min(remaining, available);
      await fsp.appendFile(livePath, data.subarray(offset, offset + take));
      currentLogBytes += take;
      offset += take;
    }

    return { rotated, segmentCount, currentLogBytes };
  }

  function enqueueDiskAppend(data) {
    const run = appendQueue.then(() => appendDisk(data));
    appendQueue = run.catch(() => {});
    return run;
  }

  async function append(chunk) {
    if (closed) throw new Error("createStdioCapture: append after close");
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    ring.append(data);
    const shouldWriteDisk = canWriteDisk() && data.length > 0;
    if (!shouldWriteDisk) {
      return { rotated: false, segmentCount, currentLogBytes };
    }
    return enqueueDiskAppend(data);
  }

  function snapshot() {
    return ring.snapshot();
  }

  function state() {
    /** @type {SessionStdioState} */
    const s = {
      liveTail: true,
      captureToDisk: _captureToDisk,
      memoryRingBytes,
      maxBytes,
      rotatedSegments,
    };
    if (_captureToDisk) {
      s.currentLogBytes = currentLogBytes;
      s.rotatedSegmentCount = segmentCount;
    }
    return s;
  }

  function setCaptureToDisk(on, { ackProvided: ack } = {}) {
    if (closed) throw new Error("createStdioCapture: setCaptureToDisk after close");
    _captureToDisk = !!on;
    if (typeof ack === "boolean") _ack = ack;
    return state();
  }

  function needsAck() {
    return !!(promptOnFirstCapture && _captureToDisk && !_ack);
  }

  async function close() {
    if (closed) return;
    closed = true;
    await appendQueue;
    // No long-lived fd — appendFile opens/closes per call — so nothing to flush.
  }

  return {
    state,
    append,
    snapshot,
    setCaptureToDisk,
    needsAck,
    close,
  };
}

// -- fs helpers -------------------------------------------------------------

async function exists(path) {
  try {
    await fsp.stat(path);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function safeUnlink(path) {
  try {
    await fsp.unlink(path);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
}

async function safeRename(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
}
