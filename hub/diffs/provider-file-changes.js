// hub/diffs/provider-file-changes.js - SH-7A-03
//
// Provider file-change events are intent evidence for DiffReview rows. They do
// not prove git state and must never create or clear conflict warnings.

export const PROVIDER_FILE_CHANGE_PHASES = Object.freeze(["proposed", "applied"]);

/**
 * @typedef {object} ProviderFileChangeRef
 * @property {string} id
 * @property {"proposed" | "applied"} phase
 * @property {string} providerId
 * @property {string} [sessionId]
 * @property {string} threadId
 * @property {string} proposalId
 * @property {string} path
 * @property {string} ts
 * @property {string} evidenceRef
 * @property {string} [summary]
 */

/**
 * Attach provider file-change refs to matching diff file rows.
 *
 * @param {Array<Record<string, unknown>>} files
 * @param {unknown} providerInput
 * @returns {{ files: Array<Record<string, unknown>>, providerItems: ProviderFileChangeRef[], unmatchedProviderItems: ProviderFileChangeRef[] }}
 */
export function annotateProviderFileChanges(files = [], providerInput = []) {
  if (!Array.isArray(files)) {
    throw new TypeError("annotateProviderFileChanges: files must be an array");
  }

  const providerItems = extractProviderFileChangeRefs(providerInput);
  const byPath = groupByPath(providerItems);
  const matchedIds = new Set();

  const annotatedFiles = files.map((file) => {
    const path = normalizePath(file?.path);
    const matches = path ? byPath.get(path) || [] : [];
    for (const item of matches) matchedIds.add(item.id);

    const existing = Array.isArray(file?.providerItems)
      ? file.providerItems.filter(isPlainObject)
      : [];
    const nextProviderItems = mergeProviderItems(existing, matches);

    return nextProviderItems.length > 0
      ? { ...file, providerItems: nextProviderItems }
      : { ...file };
  });

  return {
    files: annotatedFiles,
    providerItems,
    unmatchedProviderItems: providerItems.filter((item) => !matchedIds.has(item.id)),
  };
}

/**
 * Normalize raw provider events, normalized provider timeline rows, or existing
 * provider item refs into one DiffReview provider evidence shape.
 *
 * @param {unknown} input
 * @returns {ProviderFileChangeRef[]}
 */
export function extractProviderFileChangeRefs(input = []) {
  const rows = providerInputRows(input);
  const refs = [];

  for (const row of rows) {
    refs.push(...refsFromRow(row));
  }

  return dedupeProviderItems(refs);
}

export function providerFileChangeRefFromEvent(event, path) {
  if (!isPlainObject(event)) return null;
  const phase = phaseFromRawKind(event.kind);
  if (!phase) return null;
  return buildProviderFileChangeRef({
    phase,
    providerId: event.providerId,
    sessionId: event.sessionId,
    threadId: event.threadId,
    proposalId: event.proposalId,
    ts: event.ts,
    summary: event.summary,
    path,
  });
}

export function providerFileChangeRefFromTimelineItem(item, path) {
  if (!isPlainObject(item) || item.kind !== "file_change" || !isPlainObject(item.data)) {
    return null;
  }
  return buildProviderFileChangeRef({
    phase: item.data.phase,
    providerId: item.providerId,
    sessionId: item.sessionId,
    threadId: item.data.threadId,
    proposalId: item.data.proposalId,
    ts: item.ts,
    summary: item.data.summary,
    path,
    evidenceRef: item.evidenceRef,
  });
}

function refsFromRow(row) {
  if (!isPlainObject(row)) return [];

  if (isProviderFileChangeRef(row)) {
    return [normalizeProviderItem(row)];
  }

  const files = filesFromRow(row);
  const refs = [];
  for (const file of files) {
    const fromTimeline = providerFileChangeRefFromTimelineItem(row, file);
    const fromEvent = providerFileChangeRefFromEvent(row, file);
    if (fromTimeline) refs.push(fromTimeline);
    if (fromEvent) refs.push(fromEvent);
  }
  return refs;
}

function buildProviderFileChangeRef(input) {
  const phase = PROVIDER_FILE_CHANGE_PHASES.includes(input.phase) ? input.phase : null;
  const path = normalizePath(input.path);
  if (
    !phase ||
    !isNonEmptyString(input.providerId) ||
    !isNonEmptyString(input.threadId) ||
    !isNonEmptyString(input.proposalId) ||
    !isNonEmptyString(input.ts) ||
    !path
  ) {
    return null;
  }

  const ref = {
    id: providerFileChangeId(input.providerId, input.proposalId, phase, path, input.ts),
    phase,
    providerId: input.providerId,
    threadId: input.threadId,
    proposalId: input.proposalId,
    path,
    ts: input.ts,
    evidenceRef:
      isNonEmptyString(input.evidenceRef)
        ? input.evidenceRef
        : providerFileChangeEvidenceRef(input.providerId, input.proposalId, phase, path, input.ts),
  };

  if (isNonEmptyString(input.sessionId)) ref.sessionId = input.sessionId;
  if (isNonEmptyString(input.summary)) ref.summary = input.summary;
  return ref;
}

function normalizeProviderItem(item) {
  const ref = buildProviderFileChangeRef(item);
  if (!ref) return null;
  return {
    ...ref,
    id: isNonEmptyString(item.id) ? item.id : ref.id,
    evidenceRef: isNonEmptyString(item.evidenceRef) ? item.evidenceRef : ref.evidenceRef,
  };
}

function isProviderFileChangeRef(value) {
  return (
    isPlainObject(value) &&
    PROVIDER_FILE_CHANGE_PHASES.includes(value.phase) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.threadId) &&
    isNonEmptyString(value.proposalId) &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.ts)
  );
}

function filesFromRow(row) {
  if (Array.isArray(row.files)) return normalizedPaths(row.files);
  if (isPlainObject(row.data) && Array.isArray(row.data.files)) {
    return normalizedPaths(row.data.files);
  }
  return [];
}

function providerInputRows(input) {
  if (Array.isArray(input)) return input;
  if (!isPlainObject(input)) return [];

  return [
    ...arrayOrEmpty(input.providerItems),
    ...arrayOrEmpty(input.providerEvents),
    ...arrayOrEmpty(input.providerTimelineItems),
    ...arrayOrEmpty(input.timelineItems),
  ];
}

function groupByPath(providerItems) {
  const byPath = new Map();
  for (const item of providerItems) {
    const list = byPath.get(item.path) || [];
    list.push(item);
    byPath.set(item.path, list);
  }
  return byPath;
}

function mergeProviderItems(existingItems, newItems) {
  const out = [];
  const seen = new Set();

  for (const item of existingItems) {
    const normalized = isProviderFileChangeRef(item) ? normalizeProviderItem(item) : null;
    if (normalized) {
      const key = providerItemKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    } else {
      out.push(item);
    }
  }

  for (const item of newItems) {
    const normalized = normalizeProviderItem(item);
    if (!normalized) continue;
    const key = providerItemKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function dedupeProviderItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const normalized = isProviderFileChangeRef(item) ? normalizeProviderItem(item) : item;
    if (!normalized) continue;
    const key = providerItemKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function providerItemKey(item) {
  return [
    item.phase,
    item.providerId,
    item.sessionId || "",
    item.threadId,
    item.proposalId,
    item.path,
    item.ts,
  ].join("\0");
}

function normalizedPaths(files) {
  return Array.from(new Set(files.map(normalizePath).filter(Boolean)));
}

function phaseFromRawKind(kind) {
  if (kind === "file_change.proposed") return "proposed";
  if (kind === "file_change.applied") return "applied";
  return null;
}

function providerFileChangeId(providerId, proposalId, phase, path, ts) {
  return `provider-file-change:${escapeIdPart(providerId)}:${escapeIdPart(proposalId)}:${phase}:${escapeIdPart(path)}:${escapeIdPart(ts)}`;
}

function providerFileChangeEvidenceRef(providerId, proposalId, phase, path, ts) {
  return `provider:${escapeIdPart(providerId)}:file_change:${escapeIdPart(proposalId)}:${phase}:${escapeIdPart(path)}:${escapeIdPart(ts)}`;
}

function escapeIdPart(value) {
  return encodeURIComponent(String(value));
}

function normalizePath(value) {
  if (!isNonEmptyString(value)) return null;
  let path = value.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path.length > 0 ? path : null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
