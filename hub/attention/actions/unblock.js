import { createAttentionActionHandler, value } from "./shared.js";

export const handleUnblockAction = createAttentionActionHandler({
  kind: "unblock",
  eventType: "job.unblocked",
  required: ["jobId", "sessionId"],
  permission: "job:unblock",
  buildEvent: ({ item, action, options }) => ({
    jobId: value({ item, action, options }, "jobId"),
    sessionId: value({ item, action, options }, "sessionId"),
    reason: options.reason || action.reason || "operator unblock from attention action",
    user: options.user || options.actor || action.actor,
  }),
});
