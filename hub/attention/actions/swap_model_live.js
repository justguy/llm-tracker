import { createAttentionActionHandler, value } from "./shared.js";

export const handleSwapModelLiveAction = createAttentionActionHandler({
  kind: "swap_model_live",
  eventType: "session.model_changed",
  required: ["sessionId", "model"],
  permission: "session:model_swap",
  capability: "modelSwapMidThread",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    model: value({ item, action, options }, "model"),
    previousModel: item.model || action.previousModel || options.previousModel,
    reason: options.reason || "live model swap from attention action",
    keepCtx: options.keepCtx !== false,
    evidenceRef: item.id || action.evidenceRef,
  }),
});
