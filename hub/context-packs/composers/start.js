import {
  composePack,
  jobSection,
  trackerSection,
  changedPayload,
} from "./shared.js";

export const START_SOURCE_IDS = Object.freeze([
  "tracker.brief",
  "tracker.why",
  "tracker.execute",
  "tracker.verify",
  "tracker.changed",
]);

export function composeStartPack(params = {}, deps = {}) {
  return composePack("start", params, deps, {
    sourceIds: START_SOURCE_IDS,
    sections: ({ params: input, job, session }) => [
      jobSection(job, session),
      trackerSection("draft", null, "Launch draft", input.draft ?? null),
      trackerSection("brief", "tracker.brief", "Task brief", input.brief),
      trackerSection("why", "tracker.why", "Why", input.why),
      trackerSection("execute", "tracker.execute", "Execution plan", input.execute),
      trackerSection("verify", "tracker.verify", "Verification plan", input.verify),
      trackerSection("changed", "tracker.changed", "Changed since baseline", changedPayload(input)),
    ],
  });
}

export default composeStartPack;
