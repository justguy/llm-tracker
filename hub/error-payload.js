export function inferTrackerErrorHint(message = "") {
  if (typeof message !== "string" || message.trim() === "") return null;

  if (
    message.includes("/reference") ||
    message.includes("/references/") ||
    message.includes("reference must use")
  ) {
    return "Use repo-relative file references in `path:line` or `path:line-line` form. Bare URLs are invalid in `reference` and `references[]`.";
  }

  if (message.includes("task.comment is too long") || /\/tasks\/\d+\/comment:/.test(message)) {
    return "Keep `task.comment` at 500 chars or fewer. Use it as a short decision note; move full evidence, status logs, and long rationale into `context.notes`, a specific `context.<topic>` key, `references[]`, `definition_of_done`, or `expected_changes`.";
  }

  if (message.includes("task.blocker_reason is too long") || /\/tasks\/\d+\/blocker_reason:/.test(message)) {
    return "Keep `task.blocker_reason` at 2000 chars or fewer. Summarize only the active blocker there; move detailed evidence into `context.notes`, `references[]`, or a follow-up task.";
  }

  if (message.includes("meta.scratchpad is too long") || message.includes("/meta/scratchpad:")) {
    return "Keep `meta.scratchpad` at 5000 chars or fewer. Treat it as a short live status banner and move durable detail into task context, references, or project docs.";
  }

  if (message.includes("new tasks added through patch mode")) {
    return "Add brand-new patch tasks as `not_started` or `in_progress`. If the work is already complete, deferred, or folded into an owning row, update the existing row instead of appending a new standalone task.";
  }

  if (message.includes("patch body must be a JSON object")) {
    return "Send a JSON object with `tasks`, `meta`, `swimlaneOps`, `taskOps`, or `expectedRev`. Do not send arrays, strings, numbers, or null as the patch body.";
  }

  if (message.includes("unsupported swimlane op")) {
    return "Use one of the supported swimlane operations: `add`, `update`, `move`, or `remove`.";
  }

  if (message.includes("unsupported task op")) {
    return "Use one of the supported task operations: `move`, `archive`, `split`, or `merge`.";
  }

  if (message.includes("taskOps.move") && message.includes("requires swimlaneId and priorityId")) {
    return "For task moves, send `taskOps: [{ op: \"move\", id, swimlaneId, priorityId }]` or include `placement: { swimlaneId, priorityId }`.";
  }

  if (message.includes("/dependencies:")) {
    return "Use local task ids or cross-project dependency refs in `<otherSlug>:<taskId>` form. Do not use dependency edges for grouping; use `kind: \"group\"` plus `parent_id` for containment.";
  }

  if (message.includes("/parent_id:")) {
    return "Use `parent_id` only for tree containment. It must point to an existing different task id and must not create a cycle; use `dependencies[]` for blockers.";
  }

  if (message.includes("/repos/")) {
    return "Declare every repo in `repos.primary` or `repos.secondary[]` before using it in `repos.allowed_paths` or `repos.approval_required_for`. Do not duplicate the primary repo in secondary.";
  }

  if (message.includes("/placement/swimlaneId:") || message.includes("/placement/priorityId:")) {
    return "Use placement ids declared in `meta.swimlanes[].id` and `meta.priorities[].id`, or add/move lanes through `swimlaneOps` instead of inventing placement ids.";
  }

  if (message.includes("duplicate task id")) {
    return "Task ids must be unique. Update the existing owning task row, or create a new task with a distinct id if it is genuinely new open work.";
  }

  if (message.includes("project not found — register")) {
    return "Register the project first with the full tracker file or `PUT /api/projects/:slug`, then use patch mode for updates.";
  }

  if (message.includes("still has tasks; provide reassignTo")) {
    return "Retry the structural removal with `reassignTo` set to another swimlane id from the repair payload.";
  }

  return null;
}

export function buildTrackerErrorBody({
  message,
  kind = null,
  type = null,
  hint = null,
  path = null,
  notes = null,
  repair = null,
  expectedRev = null,
  currentRev = null,
  timestamp = new Date().toISOString()
} = {}) {
  const normalizedType = type || kind || null;
  const inferredHint = hint || inferTrackerErrorHint(message);
  const body = {
    error: message || "",
    type: normalizedType,
    timestamp
  };

  if (inferredHint) body.hint = inferredHint;
  if (path) body.path = path;
  if (notes !== null && notes !== undefined) body.notes = notes;
  if (repair !== null && repair !== undefined) body.repair = repair;
  if (expectedRev !== null && expectedRev !== undefined) body.expectedRev = expectedRev;
  if (currentRev !== null && currentRev !== undefined) body.currentRev = currentRev;

  // Legacy fields kept for compatibility with any existing consumers.
  body.message = body.error;
  if (kind) body.kind = kind;

  return body;
}
