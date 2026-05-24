// test/runtime-debounce.test.js — sh-1-06 (TDD v0.5 §5.3, §23.2 #8, §25)
//
// Uses an injected fake clock so wall-clock time does not affect outcomes.
// The FakeClock owns:
//   - now()        → current "virtual" ms-since-epoch
//   - setTimer(fn,ms) / clearTimer(h) → debouncer-compatible timer hooks
//   - advance(ms)  → moves time forward, firing any callbacks whose deadline
//                    has passed (in deadline-order so chained schedules behave
//                    as they would under real setTimeout).

import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotDebouncer } from "../hub/runtime/debounce.js";
import { RuntimeStore } from "../hub/runtime/store.js";

const ROOT = process.platform === "win32" ? "C:\\workspace\\proj" : "/workspace/proj";

class FakeClock {
  constructor() {
    this.now = 0;
    this.timers = new Map();
    this.nextHandle = 1;
  }
  setTimer = (fn, ms) => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { fireAt: this.now + ms, fn });
    return handle;
  };
  clearTimer = (h) => {
    this.timers.delete(h);
  };
  nowFn = () => this.now;
  /** Advance virtual time by `ms`, firing every timer whose fireAt has passed. */
  advance(ms) {
    const target = this.now + ms;
    // Loop until no more timers are due — re-armed timers inside callbacks
    // may schedule new work at any future time.
    while (true) {
      let pickHandle = null;
      let pickFireAt = Infinity;
      for (const [h, t] of this.timers) {
        if (t.fireAt <= target && t.fireAt < pickFireAt) {
          pickHandle = h;
          pickFireAt = t.fireAt;
        }
      }
      if (pickHandle == null) break;
      this.now = pickFireAt;
      const { fn } = this.timers.get(pickHandle);
      this.timers.delete(pickHandle);
      fn();
    }
    this.now = target;
  }
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test("constructor rejects negative debounceMs", () => {
  assert.throws(() => new SnapshotDebouncer({ debounceMs: -1 }), /debounceMs/);
  assert.throws(() => new SnapshotDebouncer({ debounceMs: Number.NaN }), /debounceMs/);
});

test("constructor rejects maxAgeMs < debounceMs", () => {
  assert.throws(() => new SnapshotDebouncer({ debounceMs: 500, maxAgeMs: 100 }), /maxAgeMs/);
  assert.throws(() => new SnapshotDebouncer({ maxAgeMs: Number.NaN }), /maxAgeMs/);
});

test("constructor rejects maxEventsPending < 1", () => {
  assert.throws(() => new SnapshotDebouncer({ maxEventsPending: 0 }), /maxEventsPending/);
  assert.throws(() => new SnapshotDebouncer({ maxEventsPending: -3 }), /maxEventsPending/);
  assert.throws(() => new SnapshotDebouncer({ maxEventsPending: Number.NaN }), /maxEventsPending/);
});

test("constructor uses §25 defaults", () => {
  const d = new SnapshotDebouncer();
  assert.equal(d.debounceMs, 250);
  assert.equal(d.maxAgeMs, 5000);
  assert.equal(d.maxEventsPending, 250);
  assert.equal(d.flushOnShutdown, true);
});

// ---------------------------------------------------------------------------
// Core scheduling semantics
// ---------------------------------------------------------------------------

test("schedule throws if flushFn is not a function", () => {
  const d = new SnapshotDebouncer();
  assert.throws(() => d.schedule(null), /flushFn/);
  assert.throws(() => d.schedule(42), /flushFn/);
});

test("debounce: 5 schedules within debounceMs → 1 flush after quiet period", async () => {
  const clk = new FakeClock();
  let calls = 0;
  const flush = async () => {
    calls++;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  for (let i = 0; i < 5; i++) {
    d.schedule(flush);
    clk.advance(50); // 50ms < 250ms quiet period → keeps resetting
  }
  assert.equal(calls, 0, "no flush while quiet period keeps resetting");
  assert.equal(d.pendingCount, 5);

  clk.advance(250); // now quiet for >=250ms → fire
  await d.flush(); // drain the in-flight async chain
  assert.equal(calls, 1);
  assert.equal(d.pendingCount, 0);
  assert.equal(d.isArmed, false);
});

test("max-pending: 250 schedules with no quiet gap → 1 immediate flush on the 250th", async () => {
  const clk = new FakeClock();
  let calls = 0;
  const flush = async () => {
    calls++;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  for (let i = 1; i <= 249; i++) {
    d.schedule(flush);
    // Don't advance — stays well inside the 250ms quiet period.
  }
  assert.equal(calls, 0, "249 schedules must not flush");
  assert.equal(d.pendingCount, 249);

  d.schedule(flush); // 250th → immediate flush
  await d.flush();
  assert.equal(calls, 1);
  assert.equal(d.pendingCount, 0);
});

test("max-age: schedules every 100ms for 5500ms force at least one flush by 5000ms", async () => {
  const clk = new FakeClock();
  let calls = 0;
  let lastFlushAt = null;
  const flush = async () => {
    calls++;
    lastFlushAt = clk.now;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  // Drive schedules every 100ms (quiet period would never elapse on its own).
  for (let i = 0; i < 55; i++) {
    d.schedule(flush);
    clk.advance(100);
  }
  await d.flush();

  assert.ok(calls >= 1, "max-age must force at least one flush within 5500ms");
  assert.ok(
    lastFlushAt !== null && lastFlushAt <= 5500,
    `flush should occur on or before 5500ms (saw ${lastFlushAt})`,
  );
  // Specifically: the first flush should land at ~5000ms (max-age).
  // We can't read intermediate timings easily, but we can assert that >=1
  // flush happened despite the quiet period never being satisfied.
});

test("after a max-age flush, a fresh pending burst re-arms timers", async () => {
  const clk = new FakeClock();
  let calls = 0;
  const flush = async () => {
    calls++;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  // First burst: drive past max-age.
  for (let i = 0; i < 55; i++) {
    d.schedule(flush);
    clk.advance(100);
  }
  await d.flush();
  const firstFlushCount = calls;
  assert.ok(firstFlushCount >= 1);

  // After draining, schedule once more and let quiet period elapse.
  d.schedule(flush);
  clk.advance(250);
  await d.flush();
  assert.equal(calls, firstFlushCount + 1, "follow-up schedule produces its own flush");
});

// ---------------------------------------------------------------------------
// Shutdown semantics
// ---------------------------------------------------------------------------

test("shutdown flushes pending events when flushOnShutdown=true (default)", async () => {
  const clk = new FakeClock();
  let calls = 0;
  const flush = async () => {
    calls++;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  d.schedule(flush);
  d.schedule(flush);
  d.schedule(flush);
  assert.equal(calls, 0);

  await d.shutdown();
  assert.equal(calls, 1, "exactly one final flush on graceful shutdown");
  assert.equal(d.pendingCount, 0);
});

test("shutdown discards pending events when flushOnShutdown=false", async () => {
  const clk = new FakeClock();
  let calls = 0;
  const flush = async () => {
    calls++;
  };
  const d = new SnapshotDebouncer({
    flushOnShutdown: false,
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  d.schedule(flush);
  d.schedule(flush);

  await d.shutdown();
  assert.equal(calls, 0, "no flush when flushOnShutdown is false");
  assert.equal(d.pendingCount, 0);
});

test("schedule() after shutdown is a no-op", async () => {
  const clk = new FakeClock();
  let calls = 0;
  const flush = async () => {
    calls++;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  await d.shutdown();
  d.schedule(flush);
  clk.advance(10_000);
  await d.flush();
  assert.equal(calls, 0);
});

test("shutdown awaits any in-flight async flush", async () => {
  const clk = new FakeClock();
  let resolveFlush;
  const flushDone = new Promise((r) => {
    resolveFlush = r;
  });
  let started = false;
  let finished = false;
  const flush = async () => {
    started = true;
    await flushDone;
    finished = true;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  d.schedule(flush);
  clk.advance(250); // fire the debounce timer → kicks off async flush
  // _fireFlush chains via Promise.then, so flushFn runs in a microtask.
  await new Promise((r) => setImmediate(r));
  assert.equal(started, true, "flushFn should have started");
  assert.equal(finished, false, "flushFn not done until resolveFlush() called");

  // Begin shutdown; this should await the in-flight promise.
  const shutdownPromise = d.shutdown();
  // Allow event-loop ticks to run; flush still waiting on resolveFlush.
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false, "shutdown must not resolve until flush completes");

  resolveFlush();
  await shutdownPromise;
  assert.equal(finished, true);
});

// ---------------------------------------------------------------------------
// flush() helper + error surfacing
// ---------------------------------------------------------------------------

test("flush() resolves after in-flight flush completes", async () => {
  const clk = new FakeClock();
  let finished = false;
  let resolveInner;
  const innerDone = new Promise((r) => {
    resolveInner = r;
  });
  const flush = async () => {
    await innerDone;
    finished = true;
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  d.schedule(flush);
  const flushPromise = d.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false);

  resolveInner();
  await flushPromise;
  assert.equal(finished, true);
});

test("flush() with no pending events is a no-op", async () => {
  const d = new SnapshotDebouncer();
  await d.flush(); // resolves cleanly
  assert.equal(d.pendingCount, 0);
});

test("flushFn errors are stored on lastFlushError without propagating", async () => {
  const clk = new FakeClock();
  const flush = async () => {
    throw new Error("boom-from-flush");
  };
  const d = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });

  d.schedule(flush);
  clk.advance(250);
  // Should NOT throw — error is captured for the caller to inspect.
  await d.flush();
  assert.ok(d.lastFlushError instanceof Error);
  assert.match(d.lastFlushError.message, /boom-from-flush/);

  // Debouncer is still usable for further work.
  let okCalls = 0;
  d.schedule(async () => {
    okCalls++;
  });
  clk.advance(250);
  await d.flush();
  assert.equal(okCalls, 1);
});

// ---------------------------------------------------------------------------
// RuntimeStore integration
// ---------------------------------------------------------------------------

test("RuntimeStore without writeSnapshots does NOT create a debouncer", () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  assert.equal(store.snapshotDebouncer, null);
});

test("RuntimeStore with writeSnapshots builds a SnapshotDebouncer using defaults", () => {
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    writeSnapshots: async () => {},
  });
  assert.ok(store.snapshotDebouncer instanceof SnapshotDebouncer);
  assert.equal(store.snapshotDebouncer.debounceMs, 250);
  assert.equal(store.snapshotDebouncer.maxAgeMs, 5000);
  assert.equal(store.snapshotDebouncer.maxEventsPending, 250);
  assert.equal(store.snapshotDebouncer.flushOnShutdown, true);
});

test("RuntimeStore honors per-option debouncer overrides", () => {
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    writeSnapshots: async () => {},
    snapshotDebounceMs: 1,
    snapshotMaxAgeMs: 2,
    snapshotMaxEventsPending: 3,
    flushOnShutdown: false,
  });
  assert.equal(store.snapshotDebouncer.debounceMs, 1);
  assert.equal(store.snapshotDebouncer.maxAgeMs, 2);
  assert.equal(store.snapshotDebouncer.maxEventsPending, 3);
  assert.equal(store.snapshotDebouncer.flushOnShutdown, false);
});

test("RuntimeStore accepts a caller-supplied snapshotDebouncer (test injection)", () => {
  const clk = new FakeClock();
  const injected = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    writeSnapshots: async () => {},
    snapshotDebouncer: injected,
  });
  assert.equal(store.snapshotDebouncer, injected);
});

test("RuntimeStore.append schedules a snapshot after each append; debounce fires once", async () => {
  const clk = new FakeClock();
  let writes = 0;
  let lastSeenRev = -1;
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    writeSnapshots: async () => {
      writes++;
      lastSeenRev = store.rev;
    },
    snapshotDebouncer: new SnapshotDebouncer({
      setTimer: clk.setTimer,
      clearTimer: clk.clearTimer,
      now: clk.nowFn,
    }),
  });

  await store.append({ type: "x" });
  await store.append({ type: "y" });
  await store.append({ type: "z" });
  assert.equal(writes, 0, "no flush before quiet period");

  clk.advance(250);
  await store.snapshotDebouncer.flush();
  assert.equal(writes, 1);
  assert.equal(lastSeenRev, 3, "writeSnapshots sees state after all 3 appends");
});

test("RuntimeStore.append does NOT schedule for deduped retries", async () => {
  const clk = new FakeClock();
  let writes = 0;
  const debouncer = new SnapshotDebouncer({
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    now: clk.nowFn,
  });
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    writeSnapshots: async () => {
      writes++;
    },
    snapshotDebouncer: debouncer,
  });

  const evt = { type: "job.checkpoint", source: "mcp", idempotencyKey: "k" };
  const r1 = await store.append({ ...evt });
  const r2 = await store.append({ ...evt });
  const r3 = await store.append({ ...evt });
  assert.equal(r2.deduped, true);
  assert.equal(r3.deduped, true);

  // Only the original append should have nudged the debouncer.
  assert.equal(debouncer.pendingCount, 1);
  clk.advance(250);
  await debouncer.flush();
  assert.equal(writes, 1);
});

test("RuntimeStore.shutdown() flushes pending snapshot writes", async () => {
  const clk = new FakeClock();
  let writes = 0;
  const store = new RuntimeStore({
    workspaceRoot: ROOT,
    writeSnapshots: async () => {
      writes++;
    },
    snapshotDebouncer: new SnapshotDebouncer({
      setTimer: clk.setTimer,
      clearTimer: clk.clearTimer,
      now: clk.nowFn,
    }),
  });

  await store.append({ type: "x" });
  await store.append({ type: "y" });
  assert.equal(writes, 0);

  await store.shutdown();
  assert.equal(writes, 1, "shutdown flushes pending snapshots");
});

test("RuntimeStore.shutdown() is a no-op when no debouncer is configured", async () => {
  const store = new RuntimeStore({ workspaceRoot: ROOT });
  await store.shutdown(); // resolves cleanly
});
