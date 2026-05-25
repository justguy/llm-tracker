// hub/sessions/stdio/ring.js — SH-2-04 (TDD v0.5 §19.3, §25)
//
// In-memory FIFO ring buffer for raw stdio bytes. Always populated regardless
// of disk-capture state (the live tail in the UI reads from here).
//
// Contract:
//   - Single Buffer-backed circular structure of `maxBytes` capacity.
//   - `append(chunk)` accepts Buffer or string (utf8). Oldest bytes drop on
//     overflow; cumulative dropped-byte counter exposed as `drop`.
//   - `snapshot()` returns a flat Buffer in chronological order (newest last).
//   - No fs, no async, no events.

/**
 * @typedef {object} MemoryRing
 * @property {(chunk: Buffer | string) => void} append
 * @property {() => Buffer} snapshot
 * @property {number} bytes  Current populated byte count (<= maxBytes).
 * @property {number} drop   Cumulative bytes that fell off the back.
 */

/**
 * @param {{ maxBytes: number }} opts
 * @returns {MemoryRing}
 */
export function createMemoryRing({ maxBytes } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("createMemoryRing: maxBytes must be a positive integer");
  }
  const cap = maxBytes;
  const buf = Buffer.alloc(cap);
  let head = 0; // next write position
  let size = 0; // populated bytes (<= cap)
  let drop = 0;

  function append(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    let len = data.length;
    if (len === 0) return;
    let src = data;
    // If chunk alone is larger than capacity, keep only the trailing `cap` bytes.
    if (len > cap) {
      drop += len - cap;
      src = data.subarray(len - cap);
      len = cap;
    }
    // Drop oldest bytes if we'd overflow.
    const overflow = size + len - cap;
    if (overflow > 0) {
      drop += overflow;
      size -= overflow;
    }
    // Write src starting at head, wrapping.
    const tail = cap - head;
    if (len <= tail) {
      src.copy(buf, head);
    } else {
      src.copy(buf, head, 0, tail);
      src.copy(buf, 0, tail, len);
    }
    head = (head + len) % cap;
    size = Math.min(cap, size + len);
  }

  function snapshot() {
    if (size === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(size);
    // Chronological start position.
    const start = (head - size + cap) % cap;
    if (start + size <= cap) {
      buf.copy(out, 0, start, start + size);
    } else {
      const first = cap - start;
      buf.copy(out, 0, start, cap);
      buf.copy(out, first, 0, size - first);
    }
    return out;
  }

  return {
    append,
    snapshot,
    get bytes() {
      return size;
    },
    get drop() {
      return drop;
    },
  };
}
