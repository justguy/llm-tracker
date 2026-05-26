import chokidar from "chokidar";

const CHOKIDAR_EVENT_MAP = Object.freeze({
  add: "add",
  addDir: "add",
  change: "change",
  unlink: "unlink",
  unlinkDir: "unlink",
});

export class ChokidarWatcherBackend {
  constructor({ chokidarModule = chokidar } = {}) {
    this.name = "chokidar";
    this.chokidar = chokidarModule;
  }

  watch(paths, { onEvent, ignored, usePolling, atomic, awaitWriteFinish } = {}) {
    if (typeof onEvent !== "function") {
      throw new TypeError("ChokidarWatcherBackend.watch: onEvent callback is required");
    }
    const watcher = this.chokidar.watch(paths, {
      ignoreInitial: true,
      ignored,
      usePolling,
      atomic,
      awaitWriteFinish,
    });
    watcher.on("all", (rawEvent, filePath) => {
      const event = CHOKIDAR_EVENT_MAP[rawEvent];
      if (!event) return;
      onEvent({ backend: this.name, event, path: filePath, rawEvent });
    });
    return {
      backend: this.name,
      close: () => watcher.close(),
    };
  }
}

export function normalizeChokidarEvent(rawEvent) {
  return CHOKIDAR_EVENT_MAP[rawEvent] || null;
}
