export { handleEscalateSandboxAction } from "./escalate_sandbox.js";
export { handleUnblockAction } from "./unblock.js";
export { handleAskAction } from "./ask.js";
export { handleInterruptAction } from "./interrupt.js";
export { handleCompleteOverrideAction } from "./complete_override.js";
export { handleAttachTaskAction } from "./attach_task.js";
export { handleAddTaskThenRunAction } from "./add_task_then_run.js";
export { handleSwapModelLiveAction } from "./swap_model_live.js";
export { handleRestartWithNewModelAction } from "./restart_with_new_model.js";
export { handleRestartStricterSandboxAction } from "./restart_stricter_sandbox.js";
export { handleRestartAllQuietAction } from "./restart_all_quiet.js";

import { handleEscalateSandboxAction } from "./escalate_sandbox.js";
import { handleUnblockAction } from "./unblock.js";
import { handleAskAction } from "./ask.js";
import { handleInterruptAction } from "./interrupt.js";
import { handleCompleteOverrideAction } from "./complete_override.js";
import { handleAttachTaskAction } from "./attach_task.js";
import { handleAddTaskThenRunAction } from "./add_task_then_run.js";
import { handleSwapModelLiveAction } from "./swap_model_live.js";
import { handleRestartWithNewModelAction } from "./restart_with_new_model.js";
import { handleRestartStricterSandboxAction } from "./restart_stricter_sandbox.js";
import { handleRestartAllQuietAction } from "./restart_all_quiet.js";

export const ATTENTION_V07_ACTION_HANDLERS = Object.freeze({
  escalate_sandbox: handleEscalateSandboxAction,
  unblock: handleUnblockAction,
  ask: handleAskAction,
  interrupt: handleInterruptAction,
  complete_override: handleCompleteOverrideAction,
  attach_task: handleAttachTaskAction,
  add_task_then_run: handleAddTaskThenRunAction,
  swap_model_live: handleSwapModelLiveAction,
  restart_with_new_model: handleRestartWithNewModelAction,
  restart_stricter_sandbox: handleRestartStricterSandboxAction,
  restart_all_quiet: handleRestartAllQuietAction,
});

export async function handleAttentionV07Action(input = {}, deps = {}) {
  const kind = input.action?.kind || input.kind;
  const handler = ATTENTION_V07_ACTION_HANDLERS[kind];
  if (!handler) {
    return {
      ok: false,
      enabled: false,
      kind: kind || "",
      disabledReason: "Unsupported v0.7 attention action handler",
    };
  }
  return handler(input, deps);
}
