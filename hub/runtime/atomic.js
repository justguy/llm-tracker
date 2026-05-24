// hub/runtime/atomic.js — Session Hub Phase 1 (TDD v0.5 §5.5)
//
// atomicWriteJson(target, value, { pretty }) performs the crash-safe write
// dance required by §5.5:
//
//   1. mkdir -p parent dir
//   2. write to a sibling `<target>.<rand>.tmp`
//   3. fsync the temp file
//   4. close, then rename(temp, target)  — POSIX-atomic on the same FS
//   5. fsync the parent directory where supported (POSIX). Errors swallowed
//      on Windows where directory fsync is not exposed.
//
// On any error the temp file is unlinked (best-effort) and the original
// error is re-thrown so callers see the underlying I/O fault.
//
// The temp file lives next to the target so `rename` stays on a single
// filesystem; otherwise rename can fall back to copy+unlink and lose
// atomicity. Pretty mode is opt-in — durable snapshot writes prefer
// minified output to keep payloads small.

import { open, rename, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Crash-safe JSON write per TDD v0.5 §5.5.
 *
 * @param {string} target              Absolute or relative path of final file.
 * @param {unknown} value              JSON-serialisable value.
 * @param {{ pretty?: boolean }} [opts]
 *   - `pretty`: emit 2-space indented JSON (default `false`, minified).
 * @returns {Promise<void>}
 */
export async function atomicWriteJson(target, value, { pretty = false } = {}) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("atomicWriteJson: target must be a non-empty string");
  }
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  const data = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  if (typeof data !== "string") {
    // Mirrors JSON.stringify returning undefined for unsupported values
    // (e.g. raw `undefined`, functions). Treat as a programmer error.
    throw new TypeError(
      `atomicWriteJson: value did not produce JSON output (got ${typeof data})`,
    );
  }
  const buf = Buffer.from(data, "utf8");

  let fh = null;
  try {
    fh = await open(tmp, "w", 0o644);
    await fh.writeFile(buf);
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tmp, target);
    await fsyncDir(dir);
  } catch (err) {
    if (fh) {
      try { await fh.close(); } catch { /* swallow */ }
    }
    try { await unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Best-effort fsync of a directory. Required on POSIX for durability of
 * the rename above; not portable on Windows where the platform does not
 * expose directory fsync the same way.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function fsyncDir(dir) {
  let dh = null;
  try {
    dh = await open(dir, "r");
    await dh.sync();
  } catch (err) {
    if (process.platform === "win32") {
      // Windows does not support fsync on directory handles via Node's
      // public API; the rename itself is durable enough for our use.
      return;
    }
    // On POSIX, some filesystems (e.g. tmpfs in CI containers) reject
    // fsync on directory fds with EINVAL/EISDIR/EACCES — swallow so the
    // happy path stays robust. A failed dir fsync only reduces durability
    // of the directory entry, not the file contents themselves.
    if (err && (err.code === "EINVAL" || err.code === "EISDIR" || err.code === "EACCES" || err.code === "EPERM" || err.code === "ENOTSUP")) {
      return;
    }
    // Rethrow truly unexpected errors so callers learn about them.
    throw err;
  } finally {
    if (dh) {
      try { await dh.close(); } catch { /* swallow */ }
    }
  }
}
