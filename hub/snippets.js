import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { runtimeDir } from "./runtime.js";

export const SNIPPET_MAX_COUNT = 5;
export const SNIPPET_MAX_BYTES = 8 * 1024;

const REFERENCE_CAPTURE_PATTERN = /^(.*):(\d+)(?:-(\d+))?$/;

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function trackerRealPath(trackerPath) {
  try {
    return realpathSync(trackerPath);
  } catch {
    return resolve(trackerPath);
  }
}

function canonicalPath(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function isWithinPath(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(`${base}${sep}`);
}

function ensureSnippetCacheDir(workspace) {
  const dir = join(runtimeDir(workspace), "snippets");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSnippetCache(workspace, slug) {
  const file = snippetCachePath(workspace, slug);
  if (!existsSync(file)) return { project: slug, snippets: {} };
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return { project: slug, snippets: {} };
  }
}

function writeSnippetCache(workspace, slug, cache) {
  ensureSnippetCacheDir(workspace);
  atomicWriteJson(snippetCachePath(workspace, slug), cache);
}

function toFileLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildSnippetId(path, startLine, endLine) {
  const safe = path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "snippet";
  return `${safe}_${startLine}_${endLine}`;
}

function hashSnippetText(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function toSnippetRecord(parsed, indexedAtRev, text, extra = {}) {
  return {
    id: buildSnippetId(parsed.path, parsed.startLine, parsed.endLine),
    reference: parsed.reference,
    path: parsed.path,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    text,
    hash: text ? hashSnippetText(text) : null,
    indexedAtRev,
    ...extra
  };
}

function cacheKey(parsed) {
  return parsed.reference;
}

function stripCacheFields(record) {
  const { fileMtimeMs, fileSize, ...rest } = record;
  return rest;
}

function extractSnippetFromFile(parsed, absolutePath, indexedAtRev) {
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return {
      snippet: toSnippetRecord(parsed, indexedAtRev, "", { error: "missing file" }),
      stat: null
    };
  }

  if (!stat.isFile()) {
    return {
      snippet: toSnippetRecord(parsed, indexedAtRev, "", { error: "referenced path is not a file" }),
      stat: null
    };
  }

  const lines = toFileLines(readFileSync(absolutePath, "utf-8"));
  if (parsed.endLine > lines.length) {
    return {
      snippet: toSnippetRecord(parsed, indexedAtRev, "", {
        error: `stale reference: file has ${lines.length} lines`
      }),
      stat
    };
  }

  const text = lines.slice(parsed.startLine - 1, parsed.endLine).join("\n");
  return {
    snippet: toSnippetRecord(parsed, indexedAtRev, text),
    stat
  };
}

function maybeReuseCachedSnippet(cached, parsed, indexedAtRev, stat) {
  if (!cached || !stat) return null;
  if (cached.reference !== parsed.reference) return null;
  if (cached.path !== parsed.path) return null;
  if (cached.startLine !== parsed.startLine || cached.endLine !== parsed.endLine) return null;
  if (cached.fileMtimeMs !== stat.mtimeMs || cached.fileSize !== stat.size) return null;
  return {
    ...cached,
    indexedAtRev
  };
}

function cacheRecord(snippet, stat) {
  return {
    ...snippet,
    fileMtimeMs: stat?.mtimeMs ?? null,
    fileSize: stat?.size ?? null
  };
}

export function parseReference(reference) {
  if (typeof reference !== "string") return null;
  const match = reference.match(REFERENCE_CAPTURE_PATTERN);
  if (!match) return null;

  const startLine = parseInt(match[2], 10);
  const endLine = parseInt(match[3] || match[2], 10);
  if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) return null;

  return {
    reference,
    path: match[1],
    startLine,
    endLine
  };
}

export function snippetCachePath(workspace, slug) {
  return join(runtimeDir(workspace), "snippets", `${slug}.json`);
}

export function inferProjectRoot(workspace, trackerPath) {
  const resolvedWorkspace = canonicalPath(workspace);
  const resolvedTracker = trackerRealPath(trackerPath);

  if (isWithinPath(resolvedWorkspace, resolvedTracker)) {
    return resolvedWorkspace;
  }

  const trackerDir = dirname(resolvedTracker);
  const dotTrackerDir = dirname(trackerDir);
  if (basename(trackerDir) === "trackers" && basename(dotTrackerDir) === ".llm-tracker") {
    return dirname(dotTrackerDir);
  }

  return dirname(resolvedTracker);
}

export function loadReferenceSnippets({
  workspace,
  slug,
  trackerPath,
  references = [],
  indexedAtRev = null
}) {
  const projectRoot = inferProjectRoot(workspace, trackerPath);
  const resolvedTrackerPath = trackerRealPath(trackerPath);
  const existingCache = readSnippetCache(workspace, slug);
  const nextCache = {
    project: slug,
    trackerPath: resolvedTrackerPath,
    projectRoot,
    snippets: { ...(existingCache?.snippets || {}) }
  };

  const snippets = [];
  for (const reference of references) {
    const parsed = parseReference(reference);
    if (!parsed) continue;

    const key = cacheKey(parsed);
    const absolutePath = isAbsolute(parsed.path) ? parsed.path : resolve(projectRoot, parsed.path);
    let stat = null;

    try {
      stat = statSync(absolutePath);
    } catch {}

    const cached = maybeReuseCachedSnippet(nextCache.snippets[key], parsed, indexedAtRev, stat);
    if (cached) {
      nextCache.snippets[key] = cached;
      snippets.push(stripCacheFields(cached));
      continue;
    }

    const extracted = extractSnippetFromFile(parsed, absolutePath, indexedAtRev);
    nextCache.snippets[key] = cacheRecord(extracted.snippet, extracted.stat);
    snippets.push(stripCacheFields(extracted.snippet));
  }

  if (references.length > 0 && stableStringify(existingCache) !== stableStringify(nextCache)) {
    writeSnippetCache(workspace, slug, nextCache);
  }

  return {
    projectRoot,
    trackerPath: resolvedTrackerPath,
    cachePath: snippetCachePath(workspace, slug),
    snippets
  };
}
