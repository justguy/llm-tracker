import {
  changedPayload,
  composePack,
  gitEvidencePayload,
  jobSection,
  repoEvents,
  sinceRevPayload,
  snapshotsHistoryPayload,
  trackerSection,
} from "./shared.js";

export const CHANGED_SINCE_SOURCE_IDS = Object.freeze([
  "tracker.changed",
  "tracker.since_rev",
  "snapshots.history",
  "repo.watcher",
  "git.evidence",
]);

export function composeChangedSincePack(params = {}, deps = {}) {
  return composePack("changed_since", params, deps, {
    sourceIds: CHANGED_SINCE_SOURCE_IDS,
    sections: ({ params: input, deps: context, job, session }) => [
      jobSection(job, session),
      trackerSection("changed", "tracker.changed", "Changed since revision", changedPayload(input)),
      trackerSection("since_rev", "tracker.since_rev", "Tracker changes by revision", sinceRevPayload(input)),
      trackerSection("snapshots_history", "snapshots.history", "Snapshot history", snapshotsHistoryPayload(input)),
      trackerSection("repo_events", "repo.watcher", "Repo watcher events", repoEvents(input, context, job, session)),
      trackerSection("git", "git.evidence", "Git evidence", gitEvidencePayload(input)),
    ],
  });
}

export default composeChangedSincePack;
