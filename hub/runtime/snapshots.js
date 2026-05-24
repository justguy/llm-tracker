// hub/runtime/snapshots.js — Session Hub Phase 1 (TDD v0.5 §5.2, §5.4)
//
// JSONL append + recovery for the runtime event log. Distinct from the
// existing hub/snapshots.js, which handles tracker snapshots under
// `<workspace>/.snapshots/<slug>/<rev>.json`. The functions here operate
// on `<workspace>/.runtime/runtime-events.jsonl` (and friends) per §5.1.
//
//   - appendJsonlLine(target, value):
//       single newline-terminated write + fsync + close. One JSON object
//       per call; defensively rejects any stringified payload that would
//       embed a raw newline (JSON.stringify normally escapes them inside
//       strings, but the guard keeps the file format strict).
//
//   - readJsonlLines(target):
//       parses the log line-by-line. On the first invalid JSON line the
//       reader STOPS, returns events parsed so far, the 1-indexed line
//       number that failed, and a human-readable recovery warning per
//       §5.4 step 4. Missing files yield an empty result (not an error)
//       so the startup rebuild can treat "no log yet" as a cold start.

import { open, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {Object} ReadJsonlResult
 * @property {object[]} events                Events parsed up to first failure (or EOF).
 * @property {number|null} corruptedAt        1-indexed line number of first invalid line, else null.
 * @property {string|null} recoveryWarning    Human-readable warning, else null.
 */

/**
 * Append a single JSON-encoded event to a JSONL file. Creates the parent
 * directory if missing. Each call writes exactly one line terminated by
 * `"\n"` in a single `writeFile` syscall under the open file descriptor,
 * then fsyncs and closes. Designed to be called from inside the
 * RuntimeStore async write queue so concurrent appends are serialized.
 *
 * @param {string} target  Absolute path to a `.jsonl` file.
 * @param {unknown} value  JSON-serialisable event.
 * @returns {Promise<void>}
 */
export async function appendJsonlLine(target, value) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("appendJsonlLine: target must be a non-empty string");
  }
  const line = JSON.stringify(value);
  if (typeof line !== "string") {
    throw new TypeError(
      `appendJsonlLine: value did not produce JSON output (got ${typeof line})`,
    );
  }
  if (line.includes("\n") || line.includes("\r")) {
    // JSON.stringify escapes newlines inside strings, so this only fires
    // if a caller hand-rolled a bogus stringifier — keep it loud.
    throw new Error("appendJsonlLine: stringified value contains a raw newline");
  }
  await mkdir(path.dirname(target), { recursive: true });
  const buf = Buffer.from(line + "\n", "utf8");
  const fh = await open(target, "a", 0o644);
  try {
    await fh.writeFile(buf);
    await fh.sync();
  } finally {
    try { await fh.close(); } catch { /* swallow close errors after sync */ }
  }
}

/**
 * Read a JSONL file line-by-line. Stops at the first invalid line per
 * TDD v0.5 §5.4 step 4 and returns recovery metadata so callers can log a
 * warning and continue with the partial log. A missing file is treated as
 * an empty log (no error).
 *
 * @param {string} target  Absolute path to a `.jsonl` file.
 * @returns {Promise<ReadJsonlResult>}
 */
export async function readJsonlLines(target) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("readJsonlLines: target must be a non-empty string");
  }
  let raw;
  try {
    raw = await readFile(target, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { events: [], corruptedAt: null, recoveryWarning: null };
    }
    throw err;
  }
  // Empty file — common right after first open before any append succeeds.
  if (raw.length === 0) {
    return { events: [], corruptedAt: null, recoveryWarning: null };
  }
  const lines = raw.split("\n");
  // Final newline produces a trailing "" — drop it so we don't report
  // a phantom corrupt empty line at EOF.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      // A blank line mid-file indicates a partial write or manual edit.
      return {
        events,
        corruptedAt: i + 1,
        recoveryWarning: `JSONL corrupt at ${target}:${i + 1}: blank line; halted at last valid event`,
      };
    }
    try {
      events.push(JSON.parse(line));
    } catch (parseErr) {
      return {
        events,
        corruptedAt: i + 1,
        recoveryWarning: `JSONL corrupt at ${target}:${i + 1}: ${parseErr.message}; halted at last valid event`,
      };
    }
  }
  return { events, corruptedAt: null, recoveryWarning: null };
}
