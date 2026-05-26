// ui/attention/actions.js — SH-4-08
//
// Browser-side dispatcher for AttentionAction chips. This mirrors the pure
// hub policy in hub/attention/actions.js but performs the client effects:
// fetches for implemented runtime endpoints, clipboard writes, and custom UI
// events for actions whose concrete handler lands in a later task.

export const UI_ATTENTION_ACTION_KINDS = Object.freeze([
  "open_session",
  "open_stdio",
  "open_chat",
  "approve",
  "deny",
  "request_checkpoint",
  "rollover",
  "run_closeout",
  "run_verify",
  "spawn_reviewer",
  "view_conflict",
  "create_worktree",
  "bind_task",
  "copy_context",
  "escalate_sandbox",
  "unblock",
  "ask",
  "interrupt",
  "complete_override",
  "attach_task",
  "add_task_then_run",
  "swap_model_live",
  "restart_with_new_model",
  "restart_stricter_sandbox",
  "restart_all_quiet",
  "acknowledge",
  "snooze",
]);

export const DEFAULT_UI_ATTENTION_ACTION_FEATURES = Object.freeze({
  rollover: false,
  spawnReviewer: false,
  sandboxEscape: false,
  interrupt: false,
  completionOverride: false,
  attachTask: false,
  addTaskThenRun: false,
  worktreeCreation: false,
  liveModelSwap: false,
  modelRestart: false,
  sandboxRestart: false,
  quietBatchRestart: false,
});

const ACTION_SPECS = Object.freeze({
  open_session: eventSpec("llm-tracker:attention-open-session"),
  open_stdio: eventSpec("llm-tracker:attention-open-stdio"),
  open_chat: eventSpec("llm-tracker:attention-open-chat"),
  approve: eventSpec("llm-tracker:attention-approve"),
  deny: eventSpec("llm-tracker:attention-deny"),
  request_checkpoint: {
    dispatch: "http",
    method: "POST",
    required: ["jobId"],
    url: (item) => `/api/jobs/${encodeURIComponent(item.jobId)}/checkpoint`,
    body: (_item, _action, options) => ({
      summary: options.checkpointSummary || "checkpoint requested from attention action",
    }),
  },
  rollover: {
    dispatch: "http",
    feature: "rollover",
    disabledReason: "Rollover action handlers are gated until the rollover phase lands",
    method: "POST",
    required: ["jobId"],
    url: (item) => `/api/jobs/${encodeURIComponent(item.jobId)}/rollover`,
    body: (_item, _action, options) => ({
      reason: options.rolloverReason || "attention_action",
    }),
  },
  run_closeout: eventSpec("llm-tracker:attention-run-closeout"),
  run_verify: eventSpec("llm-tracker:attention-run-verify"),
  spawn_reviewer: eventSpec(
    "llm-tracker:attention-spawn-reviewer",
    "spawnReviewer",
    "Reviewer spawning is gated until the reviewer phase lands",
  ),
  view_conflict: eventSpec("llm-tracker:attention-view-conflict"),
  create_worktree: eventSpec(
    "llm-tracker:attention-create-worktree",
    "worktreeCreation",
    "Worktree creation is gated until trusted local worktree creation is enabled",
  ),
  bind_task: eventSpec("llm-tracker:attention-bind-task"),
  copy_context: { dispatch: "copy" },
  escalate_sandbox: eventSpec(
    "llm-tracker:attention-escalate-sandbox",
    "sandboxEscape",
    "Sandbox escalation is gated until the sandbox approval phase lands",
  ),
  unblock: {
    dispatch: "http",
    method: "POST",
    required: ["jobId"],
    url: (item) => `/api/jobs/${encodeURIComponent(item.jobId)}/unblock`,
    body: (_item, _action, options) => ({
      reason: options.unblockReason || "operator unblock from attention action",
    }),
  },
  ask: {
    dispatch: "http",
    method: "POST",
    required: ["sessionId"],
    requiredOptions: ["senderSessionId", "sessionToken"],
    url: (_item, _action, options) => `/api/sessions/${encodeURIComponent(options.senderSessionId)}/ask`,
    body: (item, action, options) => ({
      targetSessionId: item.sessionId,
      prompt: options.askPrompt || action.prompt || "Please provide a status update.",
    }),
  },
  interrupt: eventSpec(
    "llm-tracker:attention-interrupt",
    "interrupt",
    "Interrupt is gated until provider thread cancellation lands",
  ),
  complete_override: {
    dispatch: "http",
    feature: "completionOverride",
    disabledReason: "Completion override is gated until complete-override handlers land",
    method: "POST",
    required: ["jobId"],
    url: (item) => `/api/jobs/${encodeURIComponent(item.jobId)}/complete-override`,
    body: (_item, _action, options) => ({
      reason: options.overrideReason || "operator override from attention action",
    }),
  },
  attach_task: eventSpec(
    "llm-tracker:attention-attach-task",
    "attachTask",
    "Attach-task action is gated until the attach-task modal lands",
  ),
  add_task_then_run: eventSpec(
    "llm-tracker:attention-add-task-then-run",
    "addTaskThenRun",
    "Add-task-then-run is gated until inline task creation lands",
  ),
  swap_model_live: eventSpec(
    "llm-tracker:attention-swap-model-live",
    "liveModelSwap",
    "Live model swap is gated until provider capability support lands",
  ),
  restart_with_new_model: eventSpec(
    "llm-tracker:attention-restart-with-new-model",
    "modelRestart",
    "Model restart is gated until successor restart support lands",
  ),
  restart_stricter_sandbox: eventSpec(
    "llm-tracker:attention-restart-stricter-sandbox",
    "sandboxRestart",
    "Sandbox restart is gated until sandbox restart support lands",
  ),
  restart_all_quiet: eventSpec(
    "llm-tracker:attention-restart-all-quiet",
    "quietBatchRestart",
    "Quiet-session batch restart is gated until quiet batch handlers land",
  ),
  acknowledge: {
    dispatch: "http",
    method: "POST",
    required: ["id", "dedupeKey"],
    url: (item) => `/api/attention/${encodeURIComponent(item.id)}/ack`,
    body: (item, _action, options) => ({
      dedupeKey: item.dedupeKey,
      ...(options.actor ? { actor: options.actor } : {}),
    }),
  },
  snooze: {
    dispatch: "http",
    method: "POST",
    required: ["id", "dedupeKey"],
    url: (item) => `/api/attention/${encodeURIComponent(item.id)}/snooze`,
    body: (item, _action, options) => ({
      dedupeKey: item.dedupeKey,
      until: snoozeUntil(options),
      reason: options.snoozeReason || "operator snoozed from attention action",
      ...(options.actor ? { actor: options.actor } : {}),
    }),
  },
});

function eventSpec(eventName, feature, disabledReason) {
  return Object.freeze({
    dispatch: "event",
    eventName,
    ...(feature ? { feature, disabledReason } : {}),
  });
}

function snoozeUntil(options) {
  if (typeof options.snoozeUntil === "string" && options.snoozeUntil.length > 0) {
    return options.snoozeUntil;
  }
  const base = options.now instanceof Date ? options.now.getTime() : Date.now();
  return new Date(base + 60 * 60 * 1000).toISOString();
}

function mergeFeatures(features) {
  return {
    ...DEFAULT_UI_ATTENTION_ACTION_FEATURES,
    ...(features && typeof features === "object" ? features : {}),
  };
}

function missingFields(spec, item) {
  if (!Array.isArray(spec.required)) return [];
  return spec.required.filter((field) => {
    const value = item?.[field];
    return typeof value !== "string" || value.length === 0;
  });
}

function missingOptions(spec, options) {
  if (!Array.isArray(spec.requiredOptions)) return [];
  return spec.requiredOptions.filter((field) => {
    const value = options?.[field];
    return typeof value !== "string" || value.length === 0;
  });
}

export function getAttentionActionPlan(item, action, options = {}) {
  const kind = typeof action?.kind === "string" ? action.kind : "";
  const spec = ACTION_SPECS[kind];
  if (!spec || !UI_ATTENTION_ACTION_KINDS.includes(kind)) {
    return disabledPlan({ item, action, kind, reason: "Unsupported attention action kind" });
  }
  if (action?.enabled === false) {
    return disabledPlan({
      item,
      action,
      kind,
      reason: action.disabledReason || "Action disabled",
      spec,
    });
  }
  const features = mergeFeatures(options.features);
  if (spec.feature && features[spec.feature] !== true) {
    return disabledPlan({
      item,
      action,
      kind,
      reason: spec.disabledReason || `Feature gate '${spec.feature}' is disabled`,
      spec,
    });
  }
  const missing = missingFields(spec, item);
  if (missing.length > 0) {
    return disabledPlan({
      item,
      action,
      kind,
      reason: `Requires item.${missing.join(" and item.")}`,
      spec,
      missing,
    });
  }
  const missingOpts = missingOptions(spec, options);
  if (missingOpts.length > 0) {
    return disabledPlan({
      item,
      action,
      kind,
      reason: `Requires options.${missingOpts.join(" and options.")}`,
      spec,
      missing: missingOpts.map((field) => `options.${field}`),
    });
  }
  const base = {
    ok: true,
    enabled: true,
    kind,
    dispatch: spec.dispatch,
    itemId: item?.id || null,
    actionId: action?.id || null,
  };
  if (spec.dispatch === "http") {
    return {
      ...base,
      method: spec.method,
      url: spec.url(item, action, options),
      body: spec.body ? spec.body(item, action, options) : undefined,
    };
  }
  if (spec.dispatch === "event") {
    return { ...base, eventName: spec.eventName };
  }
  return base;
}

function disabledPlan({ item, action, kind, reason, spec = null, missing = [] }) {
  return {
    ok: false,
    enabled: false,
    kind,
    dispatch: spec?.dispatch || "none",
    itemId: item?.id || null,
    actionId: action?.id || null,
    disabledReason: reason,
    missing,
  };
}

export function decorateAttentionAction(item, action, options = {}) {
  const plan = getAttentionActionPlan(item, action, options);
  if (plan.enabled) return { ...action, enabled: true };
  return {
    ...action,
    enabled: false,
    disabledReason: action?.disabledReason || plan.disabledReason,
  };
}

export function decorateAttentionActions(actions, item, options = {}) {
  if (!Array.isArray(actions)) return [];
  return actions.map((action) => decorateAttentionAction(item, action, options));
}

export async function dispatchAttentionAction(item, action, options = {}) {
  const plan = getAttentionActionPlan(item, action, options);
  if (!plan.enabled) return plan;
  if (plan.dispatch === "http") return postJson(plan, options);
  if (plan.dispatch === "event") return dispatchBrowserEvent(plan, item, action, options);
  if (plan.dispatch === "copy") return copyContext(item, action, options);
  return plan;
}

async function postJson(plan, options) {
  const fetchFn = options.fetch || (typeof fetch === "function" ? fetch : null);
  if (typeof fetchFn !== "function") {
    return { ...plan, ok: false, enabled: false, disabledReason: "Fetch API unavailable" };
  }
  const headers = { "Content-Type": "application/json" };
  if (typeof options.sessionToken === "string" && options.sessionToken.length > 0) {
    headers["X-LT-Session-Token"] = options.sessionToken;
  }
  const response = await fetchFn(plan.url, {
    method: plan.method || "POST",
    headers,
    body: JSON.stringify(plan.body || {}),
  });
  let body = {};
  if (typeof response.json === "function") {
    body = await response.json().catch(() => ({}));
  }
  return {
    ...plan,
    ok: Boolean(response.ok),
    status: response.status,
    response,
    body: body || {},
    disabledReason: response.ok ? undefined : body?.error?.message || body?.error || response.statusText,
  };
}

function dispatchBrowserEvent(plan, item, action, options) {
  const win = options.window || (typeof window !== "undefined" ? window : null);
  const detail = { item, action, plan };
  if (win && typeof win.dispatchEvent === "function") {
    if (typeof win.CustomEvent === "function") {
      win.dispatchEvent(new win.CustomEvent(plan.eventName, { detail }));
    } else {
      win.dispatchEvent({ type: plan.eventName, detail });
    }
    return { ...plan, ok: true, dispatched: true };
  }
  if (typeof options.onEvent === "function") {
    options.onEvent(plan.eventName, detail);
    return { ...plan, ok: true, dispatched: true };
  }
  return { ...plan, ok: true, dispatched: false };
}

async function copyContext(item, action, options) {
  const text = JSON.stringify({ item, action }, null, 2);
  const clipboard =
    options.clipboard ||
    (typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null);
  if (clipboard && typeof clipboard.writeText === "function") {
    await clipboard.writeText(text);
    return { ok: true, enabled: true, kind: action.kind, dispatch: "copy", copied: true };
  }
  return dispatchBrowserEvent(
    {
      ok: true,
      enabled: true,
      kind: action.kind,
      dispatch: "event",
      eventName: "llm-tracker:attention-copy-context",
      itemId: item?.id || null,
      actionId: action?.id || null,
    },
    item,
    action,
    options,
  );
}

export const UI_ATTENTION_ACTION_SPECS = ACTION_SPECS;
