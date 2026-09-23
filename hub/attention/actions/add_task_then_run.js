import { createAttentionActionHandler, value } from "./shared.js";

export const handleAddTaskThenRunAction = createAttentionActionHandler({
  kind: "add_task_then_run",
  eventType: "task.new_from_launcher",
  required: ["sessionId", "projectSlug"],
  permission: "task:create",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    projectSlug: value({ item, action, options }, "projectSlug"),
    title: options.title || action.title || "New task from attention action",
    draft: {
      source: "attention_action",
      attentionItemId: item.id || null,
      runAfterCreate: true,
    },
  }),
});
