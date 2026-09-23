import { createAttentionActionHandler, value } from "./shared.js";

export const handleInterruptAction = createAttentionActionHandler({
  kind: "interrupt",
  eventType: "session.interrupt",
  required: ["sessionId"],
  permission: "session:interrupt",
  capability: "turnInterrupt",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    reason: options.reason || action.reason || "operator interrupt from attention action",
    evidenceRef: item.id || action.evidenceRef,
  }),
});
