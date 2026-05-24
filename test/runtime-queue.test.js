// test/runtime-queue.test.js — sh-1-01 (TDD v0.5 §5.2)

import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncWriteQueue } from "../hub/runtime/queue.js";

/** Resolve after `ms` ms. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("run() returns the value of the supplied function", async () => {
  const q = new AsyncWriteQueue();
  assert.equal(await q.run(() => 42), 42);
  assert.equal(await q.run(async () => "hello"), "hello");
});

test("run() executes tasks serially (one at a time)", async () => {
  const q = new AsyncWriteQueue();
  let inFlight = 0;
  let maxInFlight = 0;
  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(
      q.run(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield several times to give the scheduler a chance to interleave.
        await sleep(1);
        await sleep(1);
        inFlight -= 1;
        return i;
      }),
    );
  }
  const results = await Promise.all(tasks);
  assert.equal(maxInFlight, 1, "no two tasks should overlap");
  assert.deepEqual(
    results,
    Array.from({ length: 20 }, (_, i) => i),
    "results return in submission order",
  );
});

test("run() preserves submission order even with mixed sync/async delays", async () => {
  const q = new AsyncWriteQueue();
  const log = [];
  const a = q.run(async () => {
    await sleep(15);
    log.push("a");
    return "a";
  });
  const b = q.run(async () => {
    log.push("b");
    return "b";
  });
  const c = q.run(async () => {
    await sleep(5);
    log.push("c");
    return "c";
  });
  const results = await Promise.all([a, b, c]);
  assert.deepEqual(log, ["a", "b", "c"]);
  assert.deepEqual(results, ["a", "b", "c"]);
});

test("rejected tasks reject the caller's promise but do NOT poison the queue", async () => {
  const q = new AsyncWriteQueue();
  const boom = q.run(async () => {
    throw new Error("boom");
  });
  await assert.rejects(boom, /boom/);
  // Queue still works.
  const ok = await q.run(async () => "ok");
  assert.equal(ok, "ok");
});

test("synchronous throw is captured as a rejection", async () => {
  const q = new AsyncWriteQueue();
  await assert.rejects(
    q.run(() => {
      throw new Error("sync-boom");
    }),
    /sync-boom/,
  );
  assert.equal(await q.run(() => 1), 1);
});

test("run() rejects with TypeError when fn is not a function", async () => {
  const q = new AsyncWriteQueue();
  await assert.rejects(q.run(null), /must be a function/);
  await assert.rejects(q.run("nope"), /must be a function/);
});

test("idle() resolves after all queued tasks settle", async () => {
  const q = new AsyncWriteQueue();
  let completed = 0;
  for (let i = 0; i < 5; i++) {
    q.run(async () => {
      await sleep(5);
      completed += 1;
    });
  }
  assert.ok(q.depth > 0, "depth must reflect queued tasks");
  await q.idle();
  assert.equal(completed, 5);
  assert.equal(q.depth, 0);
});

test("depth counter tracks queued + running tasks", async () => {
  const q = new AsyncWriteQueue();
  let release;
  const blockerStarted = new Promise((markStarted) => {
    q.run(
      () =>
        new Promise((resolveBlocker) => {
          release = resolveBlocker;
          markStarted(); // signal that the queue has actually invoked the blocker
        }),
    );
  });
  q.run(() => {});
  q.run(() => {});
  // Wait until the blocker has started executing — only then is `release` assigned.
  await blockerStarted;
  assert.equal(q.depth, 3, "1 running blocker + 2 queued = depth 3");
  release();
  await q.idle();
  assert.equal(q.depth, 0);
});
