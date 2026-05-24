// hub/runtime/queue.js — Session Hub Phase 1 (TDD v0.5 §5.2, §5.3)
//
// AsyncWriteQueue serializes async work units: callers `await queue.run(fn)`
// and the queue guarantees the next `fn` does not start until the previous
// one settles. Used by RuntimeStore.append() to keep JSONL writes,
// projection updates, and WS broadcasts ordered.
//
// No dependency: a single Promise chain implements the queue. Each `run()`
// awaits the previous tail before invoking its task, and replaces the tail
// with a Promise that settles only after the task itself settles.
// Rejections in user tasks do NOT poison the chain — the tail resolves
// (never rejects), so subsequent `run()` calls still proceed.

export class AsyncWriteQueue {
  #tail = Promise.resolve();
  #depth = 0;

  /**
   * Run `fn` once all previously-queued tasks have settled. Returns whatever
   * `fn` returns (or rejects with whatever `fn` throws/rejects). Subsequent
   * tasks still run even if `fn` rejects.
   *
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    if (typeof fn !== "function") {
      return Promise.reject(new TypeError("AsyncWriteQueue.run: fn must be a function"));
    }
    const prev = this.#tail;
    this.#depth += 1;
    const result = prev.then(() => fn());
    // The tail must NEVER reject — otherwise a single user error would block
    // every future task. Swallow rejections on the tail; the original `result`
    // promise still rejects for the caller.
    this.#tail = result.catch(() => {});
    // Decrement on settle.
    const trackedResult = result.finally(() => {
      this.#depth -= 1;
    });
    return trackedResult;
  }

  /** Number of tasks currently queued or executing. */
  get depth() {
    return this.#depth;
  }

  /**
   * Resolves once the queue is fully drained. Convenient for tests and
   * shutdown paths.
   * @returns {Promise<void>}
   */
  async idle() {
    // Snapshot tail; awaiting a tail does not block additions, so loop until
    // depth stays at zero across one tick.
    // eslint-disable-next-line no-constant-condition -- intentional drain loop
    while (true) {
      const tail = this.#tail;
      await tail;
      if (this.#depth === 0) return;
    }
  }
}
