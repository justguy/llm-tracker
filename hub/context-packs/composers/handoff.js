import {
  changedPayload,
  composePack,
  gitEvidencePayload,
  jobSection,
  repoEvents,
  runtimeEvents,
  trackerSection,
} from "./shared.js";

export const HANDOFF_SOURCE_IDS = Object.freeze([
  "tracker.brief",
  "tracker.execute",
  "tracker.verify",
  "tracker.handoff",
  "tracker.changed",
  "runtime.events",
  "repo.watcher",
  "git.evidence",
]);

export function composeHandoffPack(params = {}, deps = {}) {
  return composePack("handoff", params, deps, {
    sourceIds: HANDOFF_SOURCE_IDS,
    sections: ({ params: input, deps: context, job, session }) => [
      jobSection(job, session),
      trackerSection("brief", "tracker.brief", "Task brief", input.brief),
      trackerSection("execute", "tracker.execute", "Execution plan", input.execute),
      trackerSection("verify", "tracker.verify", "Verification plan", input.verify),
      trackerSection("changed", "tracker.changed", "Changed since handoff baseline", changedPayload(input)),
      trackerSection("runtime_events", "runtime.events", "Runtime events", runtimeEvents(input, context, job, session)),
      trackerSection("repo_events", "repo.watcher", "Repo watcher events", repoEvents(input, context, job, session)),
      trackerSection("git", "git.evidence", "Git evidence", gitEvidencePayload(input)),
      trackerSection("handoff", "tracker.handoff", "Handoff request", input.handoff),
    ],
  });
}

export default composeHandoffPack;
