import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProjectTaskContext, summarizeTask } from "./task-metadata.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_SEMANTIC_SCORE = 0.18;
const MIN_FUZZY_SCORE = 0.22;
const EMBEDDING_MODEL = process.env.LLM_TRACKER_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";

let extractorFactoryOverride = null;
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
    matches: [],
    truncation: {
      applied: false,
      returned: 0,
      totalAvailable: 0,
      maxCount: limit
    }
  };
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

async function getExtractor() {
  semanticActivated = true;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const factory = await loadExtractorFactory();
      const extractor = await factory({
        modelId: EMBEDDING_MODEL,
        task: "feature-extraction"
      });
      if (typeof extractor !== "function") {
        throw new Error("semantic embedder factory must return a callable extractor");
      }
      return extractor;
    })();
  }
  return extractorPromise;
}

async function embedText(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output?.data || []);
}

async function ensureSemanticIndex({ workspace, slug, entry }) {
  const key = cacheKey(workspace, slug);
  const rev = entry?.rev ?? entry?.data?.meta?.rev ?? null;
  const cached = semanticIndexCache.get(key);
  if (cached && cached.rev === rev) return cached.items;

  const context = buildProjectTaskContext({ data: entry?.data });
  const tasks = (entry?.data?.tasks || []).map((task) => ({
    task,
    summary: summarizeTask(task, context),
    document: buildSearchDocument(task)
  }));

  const items = [];
  for (const item of tasks) {
    items.push({
      ...item,
      vector: await embedText(item.document)
    });
  }

  semanticIndexCache.set(key, { rev, items });
  return items;
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
  extractorPromise = null;
  semanticActivated = false;
  semanticIndexCache.clear();
}

export async function primeSemanticIndex({ workspace, slug, entry }) {
  if (!semanticActivated || !entry?.data) return null;
  try {
    await ensureSemanticIndex({ workspace, slug, entry });
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
    const index = await ensureSemanticIndex({ workspace, slug, entry });
    const queryVector = await embedText(state.raw);
    const all = index
      .map((item) => ({
        ...summarizeResult(item.task, item.summary, cosineSimilarity(queryVector, item.vector))
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
      matches,
      truncation: {
        applied: matches.length < all.length,
        returned: matches.length,
        totalAvailable: all.length,
        maxCount: cappedLimit
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      message: `semantic search unavailable: ${error.message}`
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
