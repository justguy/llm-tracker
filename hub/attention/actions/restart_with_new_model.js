import { createAttentionActionHandler, value } from "./shared.js";

export const handleRestartWithNewModelAction = createAttentionActionHandler({
  kind: "restart_with_new_model",
  eventType: "session.model_changed",
  required: ["sessionId", "model"],
  permission: "session:restart",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    model: value({ item, action, options }, "model"),
    previousModel: item.model || action.previousModel || options.previousModel,
    reason: options.reason || "restart with new model from attention action",
    restartMode: "successor",
    evidenceRef: item.id || action.evidenceRef,
  }),
});
