import { WORKSPACE_CONFIG_DEFAULTS } from "../config/defaults.js";

export const DEFAULT_COALESCE_MS = WORKSPACE_CONFIG_DEFAULTS.sessionHub.watcher.coalesceMs;

/**
 * Debounce normalized repo.change events per (repoRoot, path) before they reach
 * RuntimeStore. Burst aggregation is layered on top in SH-7-03.
 */
export class RepoChangeCoalescer {
  #buffer = new Map();
  #timers = new Map();

  constructor({
    coalesceMs = DEFAULT_COALESCE_MS,
    emit,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onError = null,
  } = {}) {
    if (!Number.isFinite(coalesceMs) || coalesceMs < 0) {
      throw new TypeError("RepoChangeCoalescer: coalesceMs must be a finite number >= 0");
    }
    if (typeof emit !== "function") {
      throw new TypeError("RepoChangeCoalescer: emit function required");
    }
    if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("RepoChangeCoalescer: timer functions required");
    }
    this.coalesceMs = coalesceMs;
    this.emit = emit;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#onError = typeof onError === "function" ? onError : null;
  }

  #setTimer;
  #clearTimer;
  #onError;

  receive(event) {
    assertRepoChangeEvent(event);
    const key = repoChangeCoalescerKey(event);
    const previous = this.#buffer.get(key);
    this.#buffer.set(key, coalesceRepoChangeEvent(previous, event));
    this.#reschedule(key);
    return key;
  }

  async flushKey(key) {
    if (!this.#buffer.has(key)) return null;
    this.#clearKeyTimer(key);
    const event = this.#buffer.get(key);
    this.#buffer.delete(key);
    await this.emit(event);
    return event;
  }

  async flush() {
    const events = [];
    for (const key of Array.from(this.#buffer.keys())) {
      const event = await this.flushKey(key);
      if (event) events.push(event);
    }
    return events;
  }

  async close({ flush = true } = {}) {
    for (const key of Array.from(this.#timers.keys())) this.#clearKeyTimer(key);
    if (!flush) {
      this.#buffer.clear();
      return [];
    }
    return this.flush();
  }

  pendingCount() {
    return this.#buffer.size;
  }

  pendingEvents() {
    return Array.from(this.#buffer.values()).map((event) => ({ ...event }));
  }

  #reschedule(key) {
    this.#clearKeyTimer(key);
    const handle = this.#setTimer(() => {
      const result = this.flushKey(key);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          if (this.#onError) this.#onError(error);
        });
      }
      return result;
    }, this.coalesceMs);
    if (handle && typeof handle.unref === "function") handle.unref();
    this.#timers.set(key, handle);
  }

  #clearKeyTimer(key) {
    if (!this.#timers.has(key)) return;
    this.#clearTimer(this.#timers.get(key));
    this.#timers.delete(key);
  }
}

export function coalesceRepoChangeEvent(previous, next) {
  assertRepoChangeEvent(next);
  if (!previous) return { ...next };
  assertRepoChangeEvent(previous);
  return {
    ...previous,
    ...next,
    event: collapseWatcherEvent(previous.event, next.event),
  };
}

export function collapseWatcherEvent(previous, next) {
  if (!["add", "change", "unlink"].includes(previous)) {
    throw new TypeError("collapseWatcherEvent: previous must be add, change, or unlink");
  }
  if (!["add", "change", "unlink"].includes(next)) {
    throw new TypeError("collapseWatcherEvent: next must be add, change, or unlink");
  }
  if (next === "unlink") return "unlink";
  if (previous === "add" && next === "change") return "add";
  return next;
}

export function repoChangeCoalescerKey(event) {
  assertRepoChangeEvent(event);
  return `${event.repoRoot}\0${event.path}`;
}

function assertRepoChangeEvent(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("RepoChangeCoalescer: repo.change event object required");
  }
  if (event.type !== "repo.change") {
    throw new TypeError("RepoChangeCoalescer: event.type must be repo.change");
  }
  if (!isNonEmptyString(event.repoRoot)) {
    throw new TypeError("RepoChangeCoalescer: event.repoRoot must be a non-empty string");
  }
  if (!isNonEmptyString(event.path)) {
    throw new TypeError("RepoChangeCoalescer: event.path must be a non-empty string");
  }
  if (!["add", "change", "unlink"].includes(event.event)) {
    throw new TypeError("RepoChangeCoalescer: event.event must be add, change, or unlink");
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
