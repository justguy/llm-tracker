import {
  advisoryHandoffSection,
  changedPayload,
  composePack,
  gitEvidencePayload,
  historyPayload,
  jobSection,
  repoEvents,
  runtimeEvents,
  sinceRevPayload,
  trackerSection,
} from "./shared.js";

export const ROLLOVER_SOURCE_IDS = Object.freeze([
  "tracker.brief",
  "tracker.why",
  "tracker.execute",
  "tracker.verify",
  "tracker.handoff",
  "tracker.changed",
  "tracker.history",
  "tracker.since_rev",
  "runtime.events",
  "repo.watcher",
  "git.evidence",
]);

export function composeRolloverPack(params = {}, deps = {}) {
  return composePack("rollover", params, deps, {
    sourceIds: ROLLOVER_SOURCE_IDS,
    sections: ({ params: input, deps: context, job, session }) => [
      jobSection(job, session),
      trackerSection("brief", "tracker.brief", "Task brief", input.brief),
      trackerSection("why", "tracker.why", "Why", input.why),
      trackerSection("execute", "tracker.execute", "Execution plan", input.execute),
      trackerSection("verify", "tracker.verify", "Verification plan", input.verify),
      trackerSection("changed", "tracker.changed", "Changed since start", changedPayload(input)),
      trackerSection("history", "tracker.history", "Tracker history", historyPayload(input)),
      trackerSection("since_rev", "tracker.since_rev", "Tracker changes by revision", sinceRevPayload(input)),
      trackerSection("runtime_events", "runtime.events", "Runtime events", runtimeEvents(input, context, job, session)),
      trackerSection("repo_events", "repo.watcher", "Repo watcher events", repoEvents(input, context, job, session)),
      trackerSection("git", "git.evidence", "Git evidence", gitEvidencePayload(input)),
      advisoryHandoffSection(input),
    ],
  });
}

export default composeRolloverPack;
