import { createAttentionActionHandler, value } from "./shared.js";

export const handleCompleteOverrideAction = createAttentionActionHandler({
  kind: "complete_override",
  eventType: "human.override",
  required: ["jobId"],
  requiredOptions: ["reason"],
  permission: "job:complete_override",
  buildEvent: ({ item, action, options }) => ({
    jobId: value({ item, action, options }, "jobId"),
    sessionId: value({ item, action, options }, "sessionId"),
    reason: options.reason,
    user: options.user || options.actor || action.actor,
    context: {
      kind: "complete_override",
      source: "attention_action",
      attentionItemId: item.id || null,
      projectSlug: item.projectSlug || null,
      taskId: item.taskId || null,
    },
  }),
});
