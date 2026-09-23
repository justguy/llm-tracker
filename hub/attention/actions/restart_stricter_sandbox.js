import { createAttentionActionHandler, value } from "./shared.js";

export const handleRestartStricterSandboxAction = createAttentionActionHandler({
  kind: "restart_stricter_sandbox",
  eventType: "session.sandbox_changed",
  required: ["sessionId", "sandbox"],
  permission: "session:restart",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    sandbox: value({ item, action, options }, "sandbox"),
    previousSandbox: item.sandbox || action.previousSandbox || options.previousSandbox,
    reason: options.reason || "restart with stricter sandbox from attention action",
    restartMode: "successor",
    evidenceRef: item.id || action.evidenceRef,
  }),
});
