import {
  completionSection,
  composePack,
  gitEvidencePayload,
  jobSection,
  runtimeEvents,
  skillPlanSection,
  trackerSection,
} from "./shared.js";

export const VERIFY_SOURCE_IDS = Object.freeze([
  "tracker.brief",
  "tracker.verify",
  "runtime.events",
  "git.evidence",
]);

export function composeVerifyPack(params = {}, deps = {}) {
  return composePack("verify", params, deps, {
    sourceIds: VERIFY_SOURCE_IDS,
    sections: ({ params: input, deps: context, job, session }) => [
      jobSection(job, session),
      trackerSection("brief", "tracker.brief", "Task brief", input.brief),
      trackerSection("verify", "tracker.verify", "Verification plan", input.verify ?? job?.verifyPack),
      completionSection(job),
      skillPlanSection(job),
      trackerSection("runtime_events", "runtime.events", "Runtime events", runtimeEvents(input, context, job, session)),
      trackerSection("git", "git.evidence", "Git evidence", gitEvidencePayload(input)),
    ],
  });
}

export default composeVerifyPack;
