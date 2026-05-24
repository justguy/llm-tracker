// hub/runtime/startup.js — sh-1-07 (TDD v0.5 §5.4)
//
// Startup rebuild for the RuntimeProjection.
//
//   1. Load the three runtime snapshot files
//      (sessions.snapshot.json, jobs.snapshot.json, skill-runs.snapshot.json).
//   2. If all three parse cleanly and their watermarks agree, seed the
//      projection from their payloads and replay only the JSONL events
//      newer than the watermark.
//   3. If any snapshot is missing, malformed, or watermark-inconsistent, do
//      a FULL rebuild by replaying the runtime-events.jsonl from line 1
//      (per §5.4 step 3) and surface a recovery warning so the operator
//      can see why we dropped back to the cold path.
//   4. If the JSONL itself has a corrupt line, `readJsonlLines` already
//      halts at the last valid event and returns a recoveryWarning —
//      forward that warning verbatim through the result.
//
// The watermark scheme is opt-in / forward-compatible:
//
//   - Wrapped (preferred):
//       { version: 1, watermark: { jsonlOffset, lastEventId, rev }, payload: T[] }
//     The watermark records where the snapshot was taken in the JSONL.
//     `lastEventId` is used to skip past already-absorbed JSONL events; the
//     `jsonlOffset` and `rev` exist for cross-snapshot consistency (a
//     mismatch implies a partial 3-file write and we treat it as corrupt).
//
//   - Bare list (legacy / forward-compat):
//       T[]
//     We accept this shape, seed the projection from it, but treat the
//     watermark as unknown — replay the entire JSONL on top. Idempotency
//     for the replay falls to RuntimeProjection.seenEventIds and to the
//     event-type handlers (upserts via apply() are safe).
//
// Allowed paths: hub/runtime/startup.js (this file) + test/runtime-startup.test.js.

import { open, readFile } from "node:fs/promises";
import { makePaths } from "./paths.js";
import { readJsonlLines } from "./snapshots.js";

const SNAPSHOT_VERSION = 1;

/**
 * Stable mapping from snapshot kind to file-path key on `makePaths()` and to
 * the projection field it seeds. Frozen so callers (and the writeSnapshots
 * integration in sh-1-06) can rely on the exact identifiers.
 */
export const SNAPSHOT_NAMES = Object.freeze({
  sessions: "sessions",
  jobs: "jobs",
  skillRuns: "skillRuns",
});

/**
 * Wrap a snapshot payload with the canonical watermark envelope. Exposed for
 * the snapshot-writer integration (sh-1-06) — keeps the wrap shape co-located
 * with the unwrap logic in {@link rebuildRuntimeFromDisk}.
 *
 * @param {object[]} payload                   Sessions / jobs / skill-runs list.
 * @param {object} [opts]
 * @param {number} [opts.jsonlOffset=0]        Byte offset reached in JSONL at snapshot time.
 * @param {string|null} [opts.lastEventId=null] evt_ id of the last absorbed event.
 * @param {number} [opts.rev=0]                Monotonic projection rev at snapshot time.
 * @returns {{version:number, watermark:{jsonlOffset:number,lastEventId:string|null,rev:number}, payload:object[]}}
 */
export function wrapSnapshot(payload, { jsonlOffset = 0, lastEventId = null, rev = 0 } = {}) {
  if (!Array.isArray(payload)) {
    throw new TypeError("wrapSnapshot: payload must be an array");
  }
  return {
    version: SNAPSHOT_VERSION,
    watermark: { jsonlOffset, lastEventId, rev },
    payload,
  };
}

/**
 * @typedef {object} RebuildResult
 * @property {number} events    Count of JSONL events applied to the projection this rebuild.
 * @property {'snapshots+replay'|'replay-only'|'empty'} source  Which path was taken.
 * @property {string[]} warnings   Recovery warnings (corrupt snapshot, JSONL halt, etc.).
 * @property {number} jsonlOffset  Byte size of the JSONL file at end of rebuild.
 */

/**
 * Rebuild a RuntimeProjection from disk per TDD v0.5 §5.4.
 *
 * Required projection surface:
 *   - `apply(event)`               — absorb one RuntimeEvent (idempotent).
 *   - `seenEventIds: Set<string>`  — used to dedupe replayed events.
 *   - `sessions`, `jobs`, `skillRuns: Map<string, object>`
 *   - `sessionOrder`, `jobOrder`, `skillRunOrder: string[]`
 *
 * (Matches the public surface of `RuntimeProjection` in sh-1-05.)
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot      Absolute path to the workspace root.
 * @param {object} opts.projection         Fresh / compatible RuntimeProjection to fill.
 * @returns {Promise<RebuildResult>}
 */
export async function rebuildRuntimeFromDisk({ workspaceRoot, projection } = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError("rebuildRuntimeFromDisk: workspaceRoot must be a non-empty string");
  }
  if (!projection || typeof projection.apply !== "function") {
    throw new TypeError("rebuildRuntimeFromDisk: projection must expose an apply(event) method");
  }

  const paths = makePaths({ workspaceRoot });
  const warnings = [];

  // ---- 1. Try to load the 3 snapshot files. -------------------------------
  const snapshotPaths = {
    sessions: paths.sessionsSnapshot,
    jobs: paths.jobsSnapshot,
    skillRuns: paths.skillRunsSnapshot,
  };

  let loaded = null; // { sessions, jobs, skillRuns, watermark } | null
  try {
    loaded = await loadWrappedSnapshots(snapshotPaths);
  } catch (err) {
    warnings.push(
      `runtime startup: snapshot load failed (${err.message}); performing full rebuild from JSONL`,
    );
    loaded = null;
  }

  if (loaded) {
    seedProjection(projection, loaded);
  } else {
    // Distinguish "no snapshots present" from "snapshot load failed" by
    // checking whether we already pushed a load-failed warning.
    const sawLoadFailure = warnings.some((w) => w.includes("snapshot load failed"));
    if (!sawLoadFailure) {
      warnings.push(
        "runtime startup: no snapshots present; performing full rebuild from JSONL",
      );
    }
  }

  // ---- 2. Read the JSONL log. --------------------------------------------
  const jsonl = await readJsonlLines(paths.runtimeEvents);
  if (jsonl.recoveryWarning) warnings.push(jsonl.recoveryWarning);

  // ---- 3. Decide which events to replay on top of the seeded projection. -
  // Wrapped snapshots with a non-null lastEventId let us skip past every
  // event up to (and including) that id, so only "newer than watermark"
  // events are applied to the projection. The boundary event itself is
  // already absorbed by the snapshot, so the projection's seenEventIds set
  // gets seeded with it inside seedProjection() — meaning re-applying it
  // would be a no-op anyway, but for clarity we skip it explicitly.
  //
  // Bare snapshots (or wrapped snapshots with lastEventId=null) replay the
  // full JSONL; seenEventIds + per-handler upserts keep the projection
  // self-consistent.
  let replayFrom = 0;
  let source;
  if (loaded) {
    source = "snapshots+replay";
    const wmId = loaded.watermark.lastEventId;
    if (typeof wmId === "string" && wmId.length > 0) {
      const idx = jsonl.events.findIndex((e) => e && e.id === wmId);
      if (idx >= 0) {
        replayFrom = idx + 1; // resume strictly after the watermark event
      } else {
        // The watermark points at an event we no longer see in the JSONL.
        // Safest: replay everything we have on top of the snapshot. The
        // seeded seenEventIds (with wmId) covers the boundary event itself;
        // per-handler upserts handle the rest.
        replayFrom = 0;
        if (jsonl.events.length > 0) {
          warnings.push(
            `runtime startup: snapshot watermark lastEventId=${wmId} not found in JSONL; replaying full log`,
          );
        }
      }
    }
  } else if (jsonl.events.length === 0) {
    source = "empty";
  } else {
    source = "replay-only";
  }

  // ---- 4. Apply the relevant slice of the JSONL. -------------------------
  let appliedCount = 0;
  for (let i = replayFrom; i < jsonl.events.length; i++) {
    projection.apply(jsonl.events[i]);
    appliedCount += 1;
  }

  const finalOffset = await statSize(paths.runtimeEvents);
  return {
    events: appliedCount,
    source,
    warnings,
    jsonlOffset: finalOffset,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load and validate the 3 snapshot files. Returns `null` if NONE of them
 * exist (cold start). Throws if at least one exists but any is unreadable,
 * malformed, has the wrong shape, or has a watermark that disagrees with
 * the others.
 *
 * @param {{sessions:string, jobs:string, skillRuns:string}} snapshotPaths
 * @returns {Promise<null | {
 *   sessions:object[], jobs:object[], skillRuns:object[],
 *   watermark:{jsonlOffset:number,lastEventId:string|null,rev:number}
 * }>}
 */
async function loadWrappedSnapshots(snapshotPaths) {
  /** @type {{[k:string]: {version:number, watermark:object, payload:object[]} | null}} */
  const out = {};
  let presentCount = 0;
  let missingCount = 0;

  for (const [key, p] of Object.entries(snapshotPaths)) {
    let raw;
    try {
      raw = await readFile(p, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        out[key] = null;
        missingCount += 1;
        continue;
      }
      throw new Error(`snapshot ${key} (${p}) unreadable: ${err.message}`);
    }
    presentCount += 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`snapshot ${key} (${p}) is not valid JSON: ${err.message}`);
    }
    if (Array.isArray(parsed)) {
      // Bare list (forward-compat / pre-watermark). Treat as "seed-only",
      // no watermark — full JSONL replay on top.
      out[key] = {
        version: SNAPSHOT_VERSION,
        watermark: { jsonlOffset: 0, lastEventId: null, rev: 0 },
        payload: parsed,
      };
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.payload) &&
      parsed.watermark &&
      typeof parsed.watermark === "object"
    ) {
      const wm = parsed.watermark;
      // Defensive normalization: missing fields default to "unknown".
      const watermark = {
        jsonlOffset: Number.isFinite(wm.jsonlOffset) ? wm.jsonlOffset : 0,
        lastEventId:
          typeof wm.lastEventId === "string" && wm.lastEventId.length > 0
            ? wm.lastEventId
            : null,
        rev: Number.isFinite(wm.rev) ? wm.rev : 0,
      };
      out[key] = { version: parsed.version || SNAPSHOT_VERSION, watermark, payload: parsed.payload };
    } else {
      throw new Error(`snapshot ${key} (${p}) has unexpected shape`);
    }
  }

  // All three missing → cold start.
  if (missingCount === 3) return null;
  // Partial-present is treated as corrupt: snapshots are written atomically
  // as a 3-file set (sh-1-06), so a half-set means we crashed mid-write.
  if (presentCount !== 3) {
    throw new Error(
      `snapshot set is incomplete (${presentCount}/3 files present); expected an atomic 3-file write`,
    );
  }

  // Consistency check: all 3 watermarks must agree on rev + jsonlOffset.
  // (lastEventId can differ in principle but in practice writeSnapshots()
  // stamps the same value into all 3; we still cross-check it for safety.)
  const revs = new Set(Object.values(out).map((s) => s.watermark.rev));
  const offsets = new Set(Object.values(out).map((s) => s.watermark.jsonlOffset));
  const lastIds = new Set(Object.values(out).map((s) => s.watermark.lastEventId));
  if (revs.size > 1 || offsets.size > 1 || lastIds.size > 1) {
    throw new Error(
      `snapshot watermarks disagree across sessions/jobs/skill-runs ` +
        `(revs=[${[...revs].join(",")}], offsets=[${[...offsets].join(",")}], lastEventIds=[${[...lastIds].map((v) => v ?? "null").join(",")}])`,
    );
  }

  return {
    sessions: out.sessions.payload,
    jobs: out.jobs.payload,
    skillRuns: out.skillRuns.payload,
    watermark: out.sessions.watermark,
  };
}

/**
 * Seed an empty (or freshly-constructed) projection with snapshot payloads.
 * This is the only legitimate direct-mutation path on a RuntimeProjection:
 * rehydration bypasses `apply()` because the events that produced these
 * records are already absorbed at snapshot-write time.
 *
 * @param {object} projection
 * @param {{sessions:object[], jobs:object[], skillRuns:object[], watermark:{lastEventId:string|null}}} snapshots
 */
function seedProjection(projection, snapshots) {
  seedMap(projection.sessions, projection.sessionOrder, snapshots.sessions);
  seedMap(projection.jobs, projection.jobOrder, snapshots.jobs);
  seedMap(projection.skillRuns, projection.skillRunOrder, snapshots.skillRuns);
  // Seed seenEventIds with the watermark's lastEventId so a subsequent
  // apply() of that exact event is a no-op (idempotent replay-from-snapshot).
  if (
    snapshots.watermark &&
    typeof snapshots.watermark.lastEventId === "string" &&
    projection.seenEventIds &&
    typeof projection.seenEventIds.add === "function"
  ) {
    projection.seenEventIds.add(snapshots.watermark.lastEventId);
  }
}

/**
 * @param {Map<string, object>} map
 * @param {string[]} order
 * @param {object[]} records
 */
function seedMap(map, order, records) {
  if (!map || typeof map.set !== "function") return;
  if (!Array.isArray(order)) return;
  if (!Array.isArray(records)) return;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!map.has(id)) order.push(id);
    map.set(id, record);
  }
}

/**
 * Return the byte size of a file, or 0 if it does not exist. Used to publish
 * the final JSONL offset back to the caller so the next snapshot writer can
 * stamp an up-to-date watermark.
 *
 * @param {string} p
 * @returns {Promise<number>}
 */
async function statSize(p) {
  let fh;
  try {
    fh = await open(p, "r");
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
  try {
    const st = await fh.stat();
    return st.size;
  } finally {
    try { await fh.close(); } catch { /* swallow close errors */ }
  }
}
