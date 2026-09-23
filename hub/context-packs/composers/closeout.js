import {
  changedPayload,
  completionSection,
  composePack,
  gitEvidencePayload,
  historyPayload,
  jobSection,
  runtimeEvents,
  skillPlanSection,
  trackerSection,
} from "./shared.js";

export const CLOSEOUT_SOURCE_IDS = Object.freeze([
  "tracker.brief",
  "tracker.verify",
  "tracker.handoff",
  "tracker.changed",
  "tracker.history",
  "runtime.events",
  "git.evidence",
]);

export function composeCloseoutPack(params = {}, deps = {}) {
  return composePack("closeout", params, deps, {
    sourceIds: CLOSEOUT_SOURCE_IDS,
    sections: ({ params: input, deps: context, job, session }) => [
      jobSection(job, session),
      trackerSection("brief", "tracker.brief", "Task brief", input.brief),
      trackerSection("verify", "tracker.verify", "Verification plan", input.verify ?? job?.verifyPack),
      trackerSection("handoff", "tracker.handoff", "Handoff", input.handoff),
      trackerSection("changed", "tracker.changed", "Changed since start", changedPayload(input)),
      trackerSection("history", "tracker.history", "Tracker history", historyPayload(input)),
      completionSection(job),
      skillPlanSection(job),
      trackerSection("runtime_events", "runtime.events", "Runtime events", runtimeEvents(input, context, job, session)),
      trackerSection("git", "git.evidence", "Git evidence", gitEvidencePayload(input)),
    ],
  });
}

export default composeCloseoutPack;
