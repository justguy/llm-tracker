import { createAttentionActionHandler, value } from "./shared.js";

export const handleAttachTaskAction = createAttentionActionHandler({
  kind: "attach_task",
  eventType: "session.task_attached",
  required: ["sessionId", "taskId", "jobId"],
  permission: "task:attach",
  buildEvent: ({ item, action, options }) => ({
    sessionId: value({ item, action, options }, "sessionId"),
    jobId: value({ item, action, options }, "jobId"),
    projectSlug: value({ item, action, options }, "projectSlug"),
    taskId: value({ item, action, options }, "taskId"),
    mode: options.mode || action.mode || "attention_action",
  }),
});
