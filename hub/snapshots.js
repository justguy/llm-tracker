import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync
} from "node:fs";
import { join } from "node:path";

const REV_WIDTH = 6;

function padRev(n) {
  const s = String(n);
  return s.length >= REV_WIDTH ? s : "0".repeat(REV_WIDTH - s.length) + s;
}

export function snapshotPath(workspace, slug, rev) {
  return join(workspace, ".snapshots", slug, `${padRev(rev)}.json`);
}

export function historyPath(workspace, slug) {
  return join(workspace, ".history", `${slug}.jsonl`);
}

export function writeSnapshot(workspace, slug, rev, data) {
  const dir = join(workspace, ".snapshots", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath(workspace, slug, rev), JSON.stringify(data, null, 2));
}

export function readSnapshot(workspace, slug, rev) {
  const p = snapshotPath(workspace, slug, rev);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function listRevs(workspace, slug) {
  const dir = join(workspace, ".snapshots", slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => parseInt(f, 10))
    .sort((a, b) => a - b);
}

export function maxRev(workspace, slug) {
  const r = listRevs(workspace, slug);
  return r.length > 0 ? r[r.length - 1] : 0;
}

export function appendHistoryEntry(workspace, slug, entry) {
  const file = historyPath(workspace, slug);
  mkdirSync(join(workspace, ".history"), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

// Read all history entries; caller filters as needed.
export function readHistory(workspace, slug) {
  const file = historyPath(workspace, slug);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const out = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

// Return history entries with rev > fromRev, up to toRev (inclusive).
export function historySince(workspace, slug, fromRev, toRev) {
  return readHistory(workspace, slug).filter(
    (e) => e.rev > fromRev && (toRev === undefined || e.rev <= toRev)
  );
}
