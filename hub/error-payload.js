export function inferTrackerErrorHint(message = "") {
  if (typeof message !== "string" || message.trim() === "") return null;

  if (
    message.includes("/reference") ||
    message.includes("/references/") ||
    message.includes("reference must use")
  ) {
    return "Use repo-relative file references in `path:line` or `path:line-line` form. Bare URLs are invalid in `reference` and `references[]`.";
  }

  if (message.includes("new tasks added through patch mode")) {
    return "Add brand-new patch tasks as `not_started` or `in_progress`. If the work is already complete, deferred, or folded into an owning row, update the existing row instead of appending a new standalone task.";
  }

  if (message.includes("project not found — register")) {
    return "Register the project first with the full tracker file or `PUT /api/projects/:slug`, then use patch mode for updates.";
  }

  return null;
}

export function buildTrackerErrorBody({
  message,
  kind = null,
  type = null,
  path = null,
  notes = null,
  timestamp = new Date().toISOString()
} = {}) {
  const normalizedType = type || kind || null;
  const hint = inferTrackerErrorHint(message);
  const body = {
    error: message || "",
    type: normalizedType,
    timestamp
  };

  if (hint) body.hint = hint;
  if (path) body.path = path;
  if (notes !== null && notes !== undefined) body.notes = notes;

  // Legacy fields kept for compatibility with any existing consumers.
  body.message = body.error;
  if (kind) body.kind = kind;

  return body;
}
