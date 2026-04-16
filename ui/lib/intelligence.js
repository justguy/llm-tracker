export const PROJECT_INTEL_TABS = [
  { id: "next", label: "[NEXT]" },
  { id: "blockers", label: "[BLOCKERS]" },
  { id: "changed", label: "[CHANGED]" },
  { id: "decisions", label: "[DECISIONS]" }
];

export const TASK_INTEL_TABS = [
  { id: "brief", label: "[READ]" },
  { id: "why", label: "[WHY]" },
  { id: "execute", label: "[EXEC]" },
  { id: "verify", label: "[VERIFY]" }
];

export function humanizeValue(value) {
  return typeof value === "string" ? value.replaceAll("_", " ") : value;
}

export function toStringList(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string" && value.trim());
}

export function defaultChangedFromRev(currentRev, windowSize = 10) {
  if (!Number.isInteger(currentRev) || currentRev <= 0) return 0;
  return Math.max(0, currentRev - windowSize);
}

export function historyActionText(entry = {}) {
  if (entry.action === "undo") {
    return entry.undoOfRev ? `undo of rev ${entry.undoOfRev}` : "undo";
  }
  if (entry.action === "redo") {
    return entry.redoOfRev ? `redo of rev ${entry.redoOfRev}` : "redo";
  }
  if (Number.isInteger(entry.rolledBackTo)) {
    return `rollback to rev ${entry.rolledBackTo}`;
  }
  if (Number.isInteger(entry.rolledBackFrom)) {
    return `rollback from rev ${entry.rolledBackFrom}`;
  }
  return "change";
}

export function buildTaskFactList(task = {}) {
  const facts = [];
  const add = (label, value, tone = null) => {
    if (value === null || value === undefined || value === "") return;
    facts.push({ label, value, tone });
  };

  add("status", humanizeValue(task.status));
  add("priority", task.priorityId);
  add("lane", task.swimlaneId);
  add("effort", task.effort);

  if (typeof task.ready === "boolean") {
    add("ready", task.ready ? "yes" : "no", task.ready ? "ok" : "warn");
  }

  add("blocked", task.blocked_kind ? humanizeValue(task.blocked_kind) : null, "warn");

  const blockingOn = toStringList(task.blocking_on);
  if (blockingOn.length > 0) {
    add("blocking_on", blockingOn.join(", "), "warn");
  }

  const requiresApproval = toStringList(task.requires_approval);
  if (requiresApproval.length > 0) {
    add("approval", requiresApproval.join(", "), "warn");
  }

  add("assignee", task.assignee);

  if (Number.isInteger(task.lastTouchedRev)) {
    add("last_touch", `rev ${task.lastTouchedRev}`);
  }

  return facts;
}

export function buildCardMetaFacts(task = {}, blockedBy = []) {
  const facts = [];
  const approvals = toStringList(task.approval_required_for);

  if (blockedBy.length > 0) {
    facts.push({ label: "deps", value: blockedBy.join(", "), tone: "warn" });
  } else {
    facts.push({ label: "ready", value: "open", tone: "ok" });
  }

  if (approvals.length > 0) {
    facts.push({
      label: "approval",
      value: approvals.length === 1 ? approvals[0] : `${approvals.length} gates`,
      tone: "warn"
    });
  }

  if (Number.isInteger(task.rev)) {
    facts.push({ label: "rev", value: `r${task.rev}` });
  }

  return facts;
}
