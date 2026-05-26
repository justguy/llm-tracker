import { existsSync, watch as fsWatch } from "node:fs";
import { isAbsolute, join } from "node:path";

export class NodeFsWatchBackend {
  constructor({ watch = fsWatch, pathExists = existsSync } = {}) {
    this.name = "node_fs_watch";
    this.fsWatch = watch;
    this.pathExists = pathExists;
  }

  watch(paths, { onEvent, ignored, recursive = true } = {}) {
    if (typeof onEvent !== "function") {
      throw new TypeError("NodeFsWatchBackend.watch: onEvent callback is required");
    }
    const roots = Array.isArray(paths) ? paths : [paths];
    const watchers = roots.map((root) => {
      const callback = (rawEvent, filename) => {
        const filePath = filename ? toAbsolutePath(root, filename) : root;
        if (typeof ignored === "function" && ignored(filePath)) return;
        const event = normalizeNodeFsWatchEvent(rawEvent, filePath, this.pathExists);
        if (!event) return;
        onEvent({ backend: this.name, event, path: filePath, rawEvent });
      };
      try {
        return this.fsWatch(root, { recursive }, callback);
      } catch (err) {
        if (!recursive || !isRecursiveUnsupported(err)) throw err;
        return this.fsWatch(root, {}, callback);
      }
    });
    return {
      backend: this.name,
      close: () => {
        for (const watcher of watchers) {
          if (watcher && typeof watcher.close === "function") watcher.close();
        }
      },
    };
  }
}

export function normalizeNodeFsWatchEvent(rawEvent, filePath, pathExists = existsSync) {
  if (rawEvent === "change") return "change";
  if (rawEvent === "rename") return pathExists(filePath) ? "add" : "unlink";
  return null;
}

function toAbsolutePath(root, filename) {
  const value = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename);
  return isAbsolute(value) ? value : join(root, value);
}

function isRecursiveUnsupported(err) {
  return (
    err &&
    typeof err === "object" &&
    (err.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" || /recursive/i.test(String(err.message)))
  );
}
