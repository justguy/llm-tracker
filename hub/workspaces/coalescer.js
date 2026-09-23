import { WORKSPACE_CONFIG_DEFAULTS } from "../config/defaults.js";

export const DEFAULT_COALESCE_MS = WORKSPACE_CONFIG_DEFAULTS.sessionHub.watcher.coalesceMs;
export const DEFAULT_MAX_BATCH_SIZE = WORKSPACE_CONFIG_DEFAULTS.sessionHub.watcher.maxBatchSize;
export const DEFAULT_BURST_SAMPLE_SIZE = 20;

/**
 * Debounce normalized repo.change events per (repoRoot, path) before they reach
 * RuntimeStore. Burst aggregation is layered on top in SH-7-03.
 */
export class RepoChangeCoalescer {
  #buffer = new Map();
  #timers = new Map();
  #burstPaths = new Map();

  constructor({
    coalesceMs = DEFAULT_COALESCE_MS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    burstSampleSize = DEFAULT_BURST_SAMPLE_SIZE,
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
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 0) {
      throw new TypeError("RepoChangeCoalescer: maxBatchSize must be an integer >= 0");
    }
    if (!Number.isInteger(burstSampleSize) || burstSampleSize <= 0) {
      throw new TypeError("RepoChangeCoalescer: burstSampleSize must be an integer > 0");
    }
    this.coalesceMs = coalesceMs;
    this.maxBatchSize = maxBatchSize;
    this.burstSampleSize = burstSampleSize;
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
    const burstGroup = repoBurstGroupKey(event);
    const burstKey = repoBurstCoalescerKey(burstGroup);
    if (this.#buffer.has(burstKey)) {
      this.#mergeIntoBurst(burstKey, burstGroup, event);
      this.#reschedule(burstKey);
      return burstKey;
    }

    const key = repoChangeCoalescerKey(event);
    const previous = this.#buffer.get(key);
    this.#buffer.set(key, coalesceRepoChangeEvent(previous, event));

    if (this.#repoChangeCount(burstGroup) > this.maxBatchSize) {
      const burstEvent = this.#createBurstForGroup(burstGroup);
      const newBurstKey = repoBurstCoalescerKey(burstGroup);
      this.#buffer.set(newBurstKey, burstEvent);
      this.#reschedule(newBurstKey);
      return newBurstKey;
    }

    this.#reschedule(key);
    return key;
  }

  async flushKey(key) {
    if (!this.#buffer.has(key)) return null;
    this.#clearKeyTimer(key);
    const event = this.#buffer.get(key);
    this.#buffer.delete(key);
    if (event && event.type === "repo.burst") this.#burstPaths.delete(repoBurstGroupKey(event));
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
      this.#burstPaths.clear();
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

  #repoChangeCount(groupKey) {
    let count = 0;
    for (const event of this.#buffer.values()) {
      if (event.type === "repo.change" && repoBurstGroupKey(event) === groupKey) count += 1;
    }
    return count;
  }

  #repoChangeEvents(groupKey) {
    return Array.from(this.#buffer.values()).filter(
      (event) => event.type === "repo.change" && repoBurstGroupKey(event) === groupKey,
    );
  }

  #createBurstForGroup(groupKey) {
    const events = this.#repoChangeEvents(groupKey);
    for (const event of events) {
      const key = repoChangeCoalescerKey(event);
      this.#clearKeyTimer(key);
      this.#buffer.delete(key);
    }
    const paths = new Set(events.map((event) => event.path));
    this.#burstPaths.set(groupKey, paths);
    return createRepoBurstEvent(events, {
      fileCount: paths.size,
      samplePaths: Array.from(paths).slice(0, this.burstSampleSize),
    });
  }

  #mergeIntoBurst(burstKey, groupKey, event) {
    const previous = this.#buffer.get(burstKey);
    const paths = this.#burstPaths.get(groupKey) || new Set(previous.samplePaths || []);
    paths.add(event.path);
    this.#burstPaths.set(groupKey, paths);
    this.#buffer.set(
      burstKey,
      createRepoBurstEvent([previous, event], {
        fileCount: paths.size,
        samplePaths: Array.from(paths).slice(0, this.burstSampleSize),
      }),
    );
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

export function repoBurstGroupKey(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("repoBurstGroupKey: event object required");
  }
  for (const field of ["workspace", "projectSlug", "repoRoot"]) {
    if (!isNonEmptyString(event[field])) {
      throw new TypeError(`repoBurstGroupKey: event.${field} must be a non-empty string`);
    }
  }
  return `${event.workspace}\0${event.projectSlug}\0${event.repoRoot}`;
}

export function repoBurstCoalescerKey(groupKey) {
  if (!isNonEmptyString(groupKey)) {
    throw new TypeError("repoBurstCoalescerKey: groupKey must be a non-empty string");
  }
  return `${groupKey}\0*`;
}

export function createRepoBurstEvent(events, overrides = {}) {
  const eventList = Array.isArray(events) ? events : [];
  if (eventList.length === 0) {
    throw new TypeError("createRepoBurstEvent: at least one event is required");
  }
  for (const event of eventList) assertRepoBurstSourceEvent(event);
  const latest = eventList[eventList.length - 1];
  const samplePaths =
    Array.isArray(overrides.samplePaths) && overrides.samplePaths.length > 0
      ? overrides.samplePaths.slice()
      : uniqueStrings(eventList.flatMap((event) => event.samplePaths || event.path || [])).slice(
          0,
          DEFAULT_BURST_SAMPLE_SIZE,
        );
  const activeSessionIds = uniqueStrings(eventList.flatMap((event) => event.activeSessionIds || []));
  return {
    schemaVersion: 1,
    id: latest.id,
    ts: latest.ts,
    type: "repo.burst",
    source: latest.source,
    workspace: latest.workspace,
    projectSlug: latest.projectSlug,
    repoRoot: latest.repoRoot,
    fileCount:
      Number.isInteger(overrides.fileCount) && overrides.fileCount >= 0
        ? overrides.fileCount
        : uniqueStrings(eventList.flatMap((event) => event.samplePaths || event.path || [])).length,
    samplePaths,
    activeSessionIds,
    possibleSessionIds: uniqueStrings(eventList.flatMap((event) => event.possibleSessionIds || [])),
    attribution: burstAttribution(eventList, activeSessionIds),
    relatedTaskIds: uniqueStrings(eventList.flatMap((event) => event.relatedTaskIds || [])),
    reason: overrides.reason || "maxBatchSize_exceeded",
  };
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

function assertRepoBurstSourceEvent(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("createRepoBurstEvent: event object required");
  }
  if (event.type !== "repo.change" && event.type !== "repo.burst") {
    throw new TypeError("createRepoBurstEvent: event.type must be repo.change or repo.burst");
  }
  for (const field of ["id", "ts", "source", "workspace", "projectSlug", "repoRoot"]) {
    if (!isNonEmptyString(event[field])) {
      throw new TypeError(`createRepoBurstEvent: event.${field} must be a non-empty string`);
    }
  }
  if (event.type === "repo.change" && !isNonEmptyString(event.path)) {
    throw new TypeError("createRepoBurstEvent: repo.change event.path must be a non-empty string");
  }
}

function burstAttribution(events, activeSessionIds) {
  if (activeSessionIds.length === 0) return "unknown";
  const values = new Set(events.map((event) => event.attribution).filter(isNonEmptyString));
  if (values.size > 1) return "mixed";
  const value = values.values().next().value;
  if (value === "unknown" || value === "ambiguous" || value === "mixed") return value;
  return "mixed";
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(isNonEmptyString)));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
