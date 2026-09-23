import {
  changedPayload,
  composePack,
  gitEvidencePayload,
  historyPayload,
  jobSection,
  repoEvents,
  runtimeEvents,
  trackerSection,
} from "./shared.js";

export const REVIEW_SOURCE_IDS = Object.freeze([
  "tracker.brief",
  "tracker.why",
  "tracker.changed",
  "tracker.history",
  "runtime.events",
  "repo.watcher",
  "git.evidence",
]);

export function composeReviewPack(params = {}, deps = {}) {
  return composePack("review", params, deps, {
    sourceIds: REVIEW_SOURCE_IDS,
    sections: ({ params: input, deps: context, job, session }) => [
      jobSection(job, session),
      trackerSection("brief", "tracker.brief", "Task brief", input.brief),
      trackerSection("why", "tracker.why", "Why", input.why),
      trackerSection("changed", "tracker.changed", "Changed for review", changedPayload(input)),
      trackerSection("history", "tracker.history", "Tracker history", historyPayload(input)),
      trackerSection("runtime_events", "runtime.events", "Runtime events", runtimeEvents(input, context, job, session)),
      trackerSection("repo_events", "repo.watcher", "Repo watcher events", repoEvents(input, context, job, session)),
      trackerSection("git", "git.evidence", "Git evidence", gitEvidencePayload(input)),
    ],
  });
}

export default composeReviewPack;
