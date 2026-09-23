import {
  composePack,
  jobSection,
  trackerSection,
  changedPayload,
  gitEvidencePayload,
  repoEvents,
  runtimeEvents,
} from "./shared.js";

export const RESUME_SOURCE_IDS = Object.freeze([
  "tracker.brief",
  "tracker.execute",
  "tracker.verify",
  "tracker.changed",
  "runtime.events",
  "repo.watcher",
  "git.evidence",
]);

export function composeResumePack(params = {}, deps = {}) {
  return composePack("resume", params, deps, {
    sourceIds: RESUME_SOURCE_IDS,
    sections: ({ params: input, deps: context, job, session }) => [
      jobSection(job, session),
      trackerSection("brief", "tracker.brief", "Task brief", input.brief),
      trackerSection("execute", "tracker.execute", "Execution plan", input.execute),
      trackerSection("verify", "tracker.verify", "Verification plan", input.verify),
      trackerSection("changed", "tracker.changed", "Changed since pause", changedPayload(input)),
      trackerSection("runtime_events", "runtime.events", "Runtime events", runtimeEvents(input, context, job, session)),
      trackerSection("repo_events", "repo.watcher", "Repo watcher events", repoEvents(input, context, job, session)),
      trackerSection("git", "git.evidence", "Git evidence", gitEvidencePayload(input)),
    ],
  });
}

export default composeResumePack;
