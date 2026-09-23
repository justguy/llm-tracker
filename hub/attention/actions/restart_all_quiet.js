import { createAttentionActionHandler, value } from "./shared.js";

export const handleRestartAllQuietAction = createAttentionActionHandler({
  kind: "restart_all_quiet",
  eventType: "session.status",
  required: ["sessionId"],
  permission: "session:restart",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    status: "resuming",
    reason: options.reason || action.reason || "restart quiet session from attention action",
    batch: "restart_all_quiet",
    evidenceRef: item.id || action.evidenceRef,
  }),
});
