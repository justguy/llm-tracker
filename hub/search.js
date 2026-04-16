import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_SEMANTIC_SCORE = 0.18;
const MIN_FUZZY_SCORE = 0.22;
const EMBEDDING_MODEL = process.env.LLM_TRACKER_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const ORT_SYMBOL = Symbol.for("onnxruntime");
const SEARCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSFORMERS_WEB_MODULE = resolve(
  SEARCH_ROOT,
  "node_modules",
  "@huggingface",
  "transformers",
  "dist",
  "transformers.web.js"
);
const ONNXRUNTIME_WEB_DIST = resolve(SEARCH_ROOT, "node_modules", "onnxruntime-web", "dist");
const WASM_FACTORY_FILE = "ort-wasm-simd-threaded.asyncify.mjs";
const WASM_BINARY_FILE = "ort-wasm-simd-threaded.asyncify.wasm";

let extractorFactoryOverride = null;
let nativeExtractorFactoryOverride = null;
let wasmExtractorFactoryOverride = null;
let extractorPromise = null;
let semanticActivated = false;

const semanticIndexCache = new Map();

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

function cacheKey(workspace, slug) {
  return `${workspace || ""}::${slug}`;
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(text) {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function trigramSet(text) {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (!normalized) return new Set();
  if (normalized.length <= 3) return new Set([normalized]);
  const out = new Set();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    out.add(normalized.slice(index, index + 3));
  }
  return out;
}

function diceCoefficient(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const value of setA) {
    if (setB.has(value)) overlap += 1;
  }
  return (2 * overlap) / (setA.size + setB.size);
}

function tokenCoverage(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidate = new Set(candidateTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (candidate.has(token)) matches += 1;
  }
  return matches / queryTokens.length;
}

function taskTags(task) {
  if (!Array.isArray(task?.context?.tags)) return [];
  return task.context.tags.filter((value) => typeof value === "string" && value.trim());
}

function buildSearchDocument(task) {
  const context = task?.context || {};
  return [
    task?.id || "",
    task?.title || "",
    task?.title || "",
    task?.goal || "",
    task?.comment || "",
    task?.blocker_reason || "",
    context.notes || "",
    context.source_title || "",
    taskTags(task).join(" ")
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < vecA.length; index += 1) {
    dotProduct += vecA[index] * vecB[index];
    normA += vecA[index] * vecA[index];
    normB += vecB[index] * vecB[index];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function taskExcerpt(task) {
  return (
    task?.goal ||
    task?.comment ||
    task?.blocker_reason ||
    task?.context?.notes ||
    null
  );
}

function summarizeResult(task, summary, score, extras = {}) {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal || null,
    status: task.status,
    assignee: task.assignee ?? null,
    priorityId: summary.priorityId,
    swimlaneId: summary.swimlaneId,
    ready: summary.ready,
    aggregate: summary.aggregate,
    blocked_kind: summary.blocked_kind,
    blocking_on: summary.blocking_on,
    references: summary.references,
    comment: summary.comment,
    excerpt: taskExcerpt(task),
    score: Number(score.toFixed(4)),
    ...(extras.matchedOn?.length ? { matchedOn: extras.matchedOn } : {})
  };
}

function sortMatches(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.aggregate !== b.aggregate) return a.aggregate ? 1 : -1;
  if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function emptyPayload({ slug, rev, query, mode, now, limit, model = null }) {
  return {
    project: slug,
    rev,
    generatedAt: now,
    mode,
    query,
    model,
    backend: mode,
    matches: [],
    truncation: {
      applied: false,
      returned: 0,
      totalAvailable: 0,
      maxCount: limit
    }
  };
}

function contentTypeForFile(fileUrl) {
  const pathname = typeof fileUrl === "string" ? fileUrl : fileUrl?.pathname || "";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  if (pathname.endsWith(".mjs") || pathname.endsWith(".js")) return "text/javascript";
  if (pathname.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function createLocalAwareFetch(baseFetch = globalThis.fetch?.bind(globalThis)) {
  return async (input, init) => {
    let url = null;
    try {
      url =
        input instanceof URL
          ? input
          : typeof input === "string"
            ? new URL(input)
            : input?.url
              ? new URL(input.url)
              : null;
    } catch {
      url = null;
    }

    if (url?.protocol === "file:") {
      const body = await readFile(fileURLToPath(url));
      return new Response(body, {
        status: 200,
        headers: { "content-type": contentTypeForFile(url) }
      });
    }

    if (!baseFetch) {
      throw new Error("fetch is unavailable for semantic runtime setup");
    }
    return baseFetch(input, init);
  };
}

function configureTransformersWasmEnv(env) {
  if (!env?.backends?.onnx?.wasm) return;
  env.fetch = createLocalAwareFetch(env.fetch || globalThis.fetch?.bind(globalThis));
  env.backends.onnx.wasm.wasmPaths = {
    mjs: pathToFileURL(resolve(ONNXRUNTIME_WEB_DIST, WASM_FACTORY_FILE)).href,
    wasm: pathToFileURL(resolve(ONNXRUNTIME_WEB_DIST, WASM_BINARY_FILE)).href
  };
}

function fullErrorMessage(error) {
  const seen = new Set();
  const parts = [];
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    parts.push(current?.message || String(current));
    current = current?.cause;
  }
  return parts.join(" :: ");
}

function isOnnxNativeBindingFailure(error) {
  const message = fullErrorMessage(error);
  return /onnxruntime-node|native binding|bindings file|could not locate the bindings file|dlopen|no native build|napi/i.test(message);
}

async function loadExtractorFactory() {
  if (extractorFactoryOverride) return extractorFactoryOverride;

  const factoryModule = process.env.LLM_TRACKER_EMBEDDER_MODULE;
  if (factoryModule) {
    const loaded = await import(pathToFileURL(resolve(factoryModule)).href);
    const factory = loaded.createEmbedder || loaded.default;
    if (typeof factory !== "function") {
      throw new Error("LLM_TRACKER_EMBEDDER_MODULE must export a default factory or createEmbedder()");
    }
    return factory;
  }

  const { pipeline } = await import("@huggingface/transformers");
  return async ({ modelId }) => pipeline("feature-extraction", modelId);
}

async function loadNativeExtractorFactory() {
  if (extractorFactoryOverride) return extractorFactoryOverride;
  if (nativeExtractorFactoryOverride) return nativeExtractorFactoryOverride;
  return loadExtractorFactory();
}

async function loadWasmExtractorFactory() {
  if (extractorFactoryOverride) return extractorFactoryOverride;
  if (wasmExtractorFactoryOverride) return wasmExtractorFactoryOverride;

  const onnxWebModule = await import("onnxruntime-web/webgpu");
  globalThis[ORT_SYMBOL] = onnxWebModule.default || onnxWebModule;

  const module = await import(pathToFileURL(TRANSFORMERS_WEB_MODULE).href);
  configureTransformersWasmEnv(module.env);
  const { pipeline } = module;
  return async ({ modelId }) => pipeline("feature-extraction", modelId, { device: "wasm" });
}

async function initializeExtractor(factoryLoader) {
  const factory = await factoryLoader();
  const extractor = await factory({
    modelId: EMBEDDING_MODEL,
    task: "feature-extraction"
  });
  if (typeof extractor !== "function") {
    throw new Error("semantic embedder factory must return a callable extractor");
  }
  return extractor;
}

async function getExtractorRuntime() {
  semanticActivated = true;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        return {
          extractor: await initializeExtractor(loadNativeExtractorFactory),
          warning: null,
          mode: "native"
        };
      } catch (error) {
        if (!isOnnxNativeBindingFailure(error)) {
          throw error;
        }

        return fallbackToWasmRuntime(error);
      }
    })();
  }
  return extractorPromise;
}

async function fallbackToWasmRuntime(nativeFailure) {
  try {
    return {
      extractor: await initializeExtractor(loadWasmExtractorFactory),
      warning: `semantic search is using the local wasm runtime because the native backend failed: ${nativeFailure.message}`,
      mode: "wasm"
    };
  } catch (wasmError) {
    wasmError.cause = wasmError.cause || nativeFailure;
    throw wasmError;
  }
}

async function embedText(text, runtime) {
  try {
    const output = await runtime.extractor(text, { pooling: "mean", normalize: true });
    return {
      vector: Array.from(output?.data || []),
      runtime
    };
  } catch (error) {
    if (runtime.mode !== "native" || !isOnnxNativeBindingFailure(error)) {
      throw error;
    }

    const wasmRuntime = await fallbackToWasmRuntime(error);
    extractorPromise = Promise.resolve(wasmRuntime);
    const output = await wasmRuntime.extractor(text, { pooling: "mean", normalize: true });
    return {
      vector: Array.from(output?.data || []),
      runtime: wasmRuntime
    };
  }
}

async function ensureSemanticIndex({ workspace, slug, entry, runtime }) {
  const key = cacheKey(workspace, slug);
  const rev = entry?.rev ?? entry?.data?.meta?.rev ?? null;
  const cached = semanticIndexCache.get(key);
  if (cached && cached.rev === rev) return { items: cached.items, runtime };

  const context = buildProjectTaskContext({ data: entry?.data });
  const tasks = (entry?.data?.tasks || []).map((task) => ({
    task,
    summary: summarizeTask(task, context),
    document: buildSearchDocument(task)
  }));

  const items = [];
  let activeRuntime = runtime;
  for (const item of tasks) {
    const embedded = await embedText(item.document, activeRuntime);
    activeRuntime = embedded.runtime;
    items.push({
      ...item,
      vector: embedded.vector
    });
  }

  semanticIndexCache.set(key, { rev, items });
  return { items, runtime: activeRuntime };
}

function queryState(rawQuery) {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  return {
    raw: query,
    normalized: normalizeText(query),
    tokens: tokenize(query),
    trigrams: trigramSet(query)
  };
}

function fuzzyFieldScore(query, value) {
  if (!value || !query.normalized) return 0;
  const normalized = normalizeText(value);
  if (!normalized) return 0;

  let score = 0;
  if (normalized === query.normalized) score = 1;
  else if (normalized.startsWith(query.normalized)) score = 0.97;
  else if (normalized.includes(query.normalized)) score = 0.9;

  const tokens = tokenize(normalized);
  const combined =
    0.55 * diceCoefficient(query.trigrams, trigramSet(normalized)) +
    0.45 * tokenCoverage(query.tokens, tokens);

  score = Math.max(score, combined);
  if (query.tokens.length > 0 && query.tokens.every((token) => tokens.includes(token))) {
    score = Math.min(1, score + 0.08);
  }

  return score;
}

function fuzzyTaskMatch(task, summary, query) {
  const matchedOn = [];
  const fieldScores = [];
  let score = 0;

  const consider = (label, value) => {
    const fieldScore = fuzzyFieldScore(query, value);
    if (fieldScore > score) score = fieldScore;
    fieldScores.push({ label, score: fieldScore });
    if (fieldScore >= 0.55) matchedOn.push(label);
  };

  consider("id", task.id);
  consider("title", task.title);
  consider("goal", task.goal || "");
  consider("comment", task.comment || "");
  consider("notes", task.context?.notes || "");
  consider("source", task.context?.source_title || "");
  for (const tag of taskTags(task)) consider("tag", tag);

  const combinedScore = fuzzyFieldScore(query, buildSearchDocument(task));
  score = Math.max(score, combinedScore * 0.95);
  if (score < MIN_FUZZY_SCORE) return null;

  const selectedFields = Array.from(new Set(
    matchedOn.length > 0
      ? matchedOn
      : fieldScores
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2)
          .map((entry) => entry.label)
  )).slice(0, 4);

  return summarizeResult(task, summary, score, {
    matchedOn: selectedFields
  });
}

export function clearSearchCachesForSlug(workspace, slug) {
  semanticIndexCache.delete(cacheKey(workspace, slug));
}

export function setSemanticExtractorFactoryForTests(factory) {
  extractorFactoryOverride = factory;
  nativeExtractorFactoryOverride = null;
  wasmExtractorFactoryOverride = null;
  extractorPromise = null;
  semanticActivated = false;
  semanticIndexCache.clear();
}

export function setSemanticRuntimeFactoriesForTests({ nativeFactory = null, wasmFactory = null } = {}) {
  extractorFactoryOverride = null;
  nativeExtractorFactoryOverride = nativeFactory;
  wasmExtractorFactoryOverride = wasmFactory;
  extractorPromise = null;
  semanticActivated = false;
  semanticIndexCache.clear();
}

export async function primeSemanticIndex({ workspace, slug, entry }) {
  if (!semanticActivated || !entry?.data) return null;
  try {
    const runtime = await getExtractorRuntime();
    await ensureSemanticIndex({ workspace, slug, entry, runtime });
  } catch {
    // Search warm-up is best-effort. Query-time paths surface actual errors.
  }
  return null;
}

export async function getSearchPayload({
  workspace,
  slug,
  entry,
  query,
  limit = DEFAULT_LIMIT,
  now = new Date().toISOString()
}) {
  if (!entry?.data) return null;

  const cappedLimit = clampLimit(limit);
  const state = queryState(query);
  const rev = entry.rev ?? entry.data.meta?.rev ?? null;
  if (!state.raw) return emptyPayload({ slug, rev, query: "", mode: "semantic", now, limit: cappedLimit, model: EMBEDDING_MODEL });

  try {
    const runtime = await getExtractorRuntime();
    const indexed = await ensureSemanticIndex({ workspace, slug, entry, runtime });
    const embeddedQuery = await embedText(state.raw, indexed.runtime);
    const all = indexed.items
      .map((item) => ({
        ...summarizeResult(item.task, item.summary, cosineSimilarity(embeddedQuery.vector, item.vector))
      }))
      .filter((item) => item.score >= MIN_SEMANTIC_SCORE)
      .sort(sortMatches);

    const matches = all.slice(0, cappedLimit);
    return {
      project: slug,
      rev,
      generatedAt: now,
      mode: "semantic",
      query: state.raw,
      model: EMBEDDING_MODEL,
      backend: "semantic",
      ...(embeddedQuery.runtime.warning ? { warning: embeddedQuery.runtime.warning } : {}),
      matches,
      truncation: {
        applied: matches.length < all.length,
        returned: matches.length,
        totalAvailable: all.length,
        maxCount: cappedLimit
      }
    };
  } catch (error) {
    const fallback = getFuzzyPayload({
      slug,
      entry,
      query: state.raw,
      limit: cappedLimit,
      now
    });
    return {
      ...fallback,
      mode: "semantic",
      model: EMBEDDING_MODEL,
      backend: "fuzzy_fallback",
      warning: `semantic search unavailable: ${error.message}`
    };
  }
}

export function getFuzzyPayload({
  slug,
  entry,
  query,
  limit = DEFAULT_LIMIT,
  now = new Date().toISOString()
}) {
  if (!entry?.data) return null;

  const cappedLimit = clampLimit(limit);
  const state = queryState(query);
  const rev = entry.rev ?? entry.data.meta?.rev ?? null;
  if (!state.raw) return emptyPayload({ slug, rev, query: "", mode: "fuzzy", now, limit: cappedLimit });

  const context = buildProjectTaskContext({ data: entry.data });
  const all = (entry.data.tasks || [])
    .map((task) => fuzzyTaskMatch(task, summarizeTask(task, context), state))
    .filter(Boolean)
    .sort(sortMatches);

  const matches = all.slice(0, cappedLimit);
  return {
    project: slug,
    rev,
    generatedAt: now,
    mode: "fuzzy",
    query: state.raw,
    backend: "fuzzy",
    matches,
    truncation: {
      applied: matches.length < all.length,
      returned: matches.length,
      totalAvailable: all.length,
      maxCount: cappedLimit
    }
  };
}

export async function buildSearchPayload({ slug, data, query, limit, now, workspace = null }) {
  return getSearchPayload({
    workspace,
    slug,
    entry: {
      data,
      rev: data?.meta?.rev ?? null
    },
    query,
    limit,
    now
  });
}

export function buildFuzzySearchPayload({ slug, data, query, limit, now }) {
  return getFuzzyPayload({
    slug,
    entry: {
      data,
      rev: data?.meta?.rev ?? null
    },
    query,
    limit,
    now
  });
}
