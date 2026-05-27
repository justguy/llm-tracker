// hub/diffs/changed-since.js - SH-7A-02
//
// Compose tracker changed-since evidence with on-demand git diff evidence.
// Tracker revisions and git commits are separate clocks; the payload keeps
// them separate so callers do not infer one from the other.

import { buildChangedPayload, getChangedPayload } from "../changed.js";
import { collectGitDiff, computeGitBaseHead } from "./git-diff.js";

export async function buildChangedSincePayload(input = {}) {
  const slug = requiredString(input.slug || input.projectSlug || input.job?.projectSlug, "slug is required");
  const fromRev = normalizeNonNegativeInteger(
    input.fromRev ?? input.baseRev ?? input.job?.startRev,
    null,
    "fromRev",
  );
  if (fromRev === null) {
    throw new Error("fromRev or job.startRev is required");
  }
  const generatedAt = typeof input.now === "function" ? input.now() : new Date().toISOString();
  const tracker = buildTrackerEvidence({
    ...input,
    slug,
    fromRev,
    generatedAt,
  });
  const repoRoot = resolveRepoRoot(input);
  const base = await buildBaseHead({
    ...input,
    repoRoot,
    baseRev: fromRev,
  });
  const git = repoRoot
    ? await collectGitDiff({
        ...input,
        repoRoot,
        baseHead: base,
        baseRef: input.baseRef ?? input.baseGitSha ?? base.baseGitSha,
        headRef: input.headRef ?? input.headGitSha ?? base.headGitSha ?? "HEAD",
        now: () => generatedAt,
      })
    : nullGitEvidence("repoRoot_missing", fromRev, input.baseGitSha ?? null, null);

  return {
    project: slug,
    projectSlug: slug,
    fromRev,
    currentRev: tracker.changed?.rev ?? tracker.since?.currentRev ?? null,
    generatedAt,
    base,
    tracker,
    git,
  };
}

export async function buildBaseHead(input = {}) {
  const baseRev = normalizeNonNegativeInteger(
    input.baseRev ?? input.fromRev ?? input.job?.startRev,
    null,
    "baseRev",
  );
  const repoRoot = resolveRepoRoot(input);
  if (!repoRoot) {
    return {
      baseRev,
      baseGitSha: input.baseGitSha ?? input.job?.baseGitSha ?? null,
      headGitSha: null,
      unavailable: true,
      reason: "repoRoot_missing",
      repoRoot: null,
      commands: {},
    };
  }
  return computeGitBaseHead({
    ...input,
    repoRoot,
    baseRev,
  });
}

function buildTrackerEvidence(input) {
  const since = readSince(input);
  const changed = readChanged(input);
  return { since, changed };
}

function readSince(input) {
  if (input.since !== undefined) return input.since;
  if (input.store && typeof input.store.getSince === "function") {
    return input.store.getSince(input.slug, input.fromRev);
  }
  return null;
}

function readChanged(input) {
  if (input.changed !== undefined) return input.changed;
  if (input.workspace && input.entry) {
    return getChangedPayload({
      workspace: input.workspace,
      slug: input.slug,
      entry: input.entry,
      fromRev: input.fromRev,
      limit: input.limit,
      now: input.generatedAt,
    });
  }
  if (input.data) {
    return buildChangedPayload({
      slug: input.slug,
      data: input.data,
      history: input.history || [],
      fromRev: input.fromRev,
      limit: input.limit,
      now: input.generatedAt,
    });
  }
  return null;
}

function nullGitEvidence(reason, baseRev, baseGitSha, headGitSha) {
  return {
    ok: false,
    unavailable: true,
    reason,
    repoRoot: null,
    baseRev,
    baseGitSha,
    headGitSha,
    baseRef: baseGitSha,
    headRef: headGitSha,
    paths: [],
    range: null,
    commands: {},
    files: [],
    diffStat: null,
    nameStatus: null,
  };
}

function resolveRepoRoot(input) {
  return firstString(
    input.repoRoot,
    input.worktreePath,
    input.cwd,
    input.session?.worktreePath,
    input.session?.repoRoot,
    input.session?.cwd,
    input.job?.worktreePath,
    input.job?.repoRoot,
    input.job?.cwd,
  );
}

function normalizeNonNegativeInteger(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" && value.length > 0 ? Number(value) : value;
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return number;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function requiredString(value, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}
