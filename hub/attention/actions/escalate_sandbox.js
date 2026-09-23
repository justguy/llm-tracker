import { createAttentionActionHandler, value } from "./shared.js";

export const handleEscalateSandboxAction = createAttentionActionHandler({
  kind: "escalate_sandbox",
  eventType: "sandbox.escape_resolved",
  required: ["sessionId"],
  permission: "sandbox:escalate",
  capability: "structuredApprovals",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    approvalId: value({ item, action, options }, "approvalId"),
    decision: "approved",
    sandboxScope: action.sandboxScope || options.sandboxScope || "session",
    sandboxConfigChange: action.sandboxConfigChange || options.sandboxConfigChange || "demote",
    evidenceRef: item.id || action.evidenceRef,
  }),
});
