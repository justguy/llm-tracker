import { createAttentionActionHandler, value } from "./shared.js";

export const handleAskAction = createAttentionActionHandler({
  kind: "ask",
  eventType: "session.ask",
  required: ["sessionId"],
  requiredOptions: ["senderSessionId"],
  permission: "session:ask",
  buildEvent: ({ item, action, options }) => ({
    sessionId: options.senderSessionId,
    from: options.senderSessionId,
    targetSessionId: value({ item, action, options }, "sessionId"),
    to: value({ item, action, options }, "sessionId"),
    prompt: options.prompt || options.askPrompt || action.prompt || "Please provide a status update.",
  }),
});
