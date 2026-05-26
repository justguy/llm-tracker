import { validateTaskExtensions } from "../validator/task-extensions.js";

// SH-5-04 composition core. The surrounding job lifecycle still stamps this
// onto JobRecord once sh-3-05 lands; this module keeps composition deterministic.

export const HUMAN_APPROVAL_REQUIRED_TITLE = "HUMAN APPROVAL REQUIRED";
export const HUMAN_REVIEW_READY_TITLE = "HUMAN REVIEW READY";

function cloneItems(items, { normalize = false } = {}) {
  return Object.freeze(
    items.map((item) => Object.freeze(normalize ? normalizeItem(item) : { ...item }))
  );
}

function freezePack(pack, options = {}) {
  return Object.freeze({
    ...pack,
    items: cloneItems(Array.isArray(pack.items) ? pack.items : [], options)
  });
}

function normalizeItem(item) {
  if (item?.kind === "command" && !Object.prototype.hasOwnProperty.call(item, "expectExit")) {
    return { ...item, expectExit: 0 };
  }
  return { ...item };
}

function itemsFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.verify?.items)) return value.verify.items;
  if (Array.isArray(value.verifyPack?.items)) return value.verifyPack.items;
  if (Array.isArray(value.verifyDefaults?.items)) return value.verifyDefaults.items;
  return [];
}

function findTask(input) {
  if (input?.task && typeof input.task === "object") return input.task;
  const taskId = input?.taskId ?? input?.job?.taskId;
  if (!taskId || !Array.isArray(input?.tracker?.tasks)) return null;
  return input.tracker.tasks.find((task) => task.id === taskId) || null;
}

function mergeItems(...sources) {
  const seen = new Set();
  const items = [];
  for (const source of sources) {
    for (const item of itemsFrom(source)) {
      if (typeof item?.id === "string") {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
      }
      items.push(item);
    }
  }
  return items;
}

export function stampVerifyPack(input = {}) {
  if (input && typeof input === "object" && Array.isArray(input.items)) {
    return freezePack(input);
  }

  const task = findTask(input);
  if (task?.verify) {
    const valid = validateTaskExtensions({ verify: task.verify });
    if (!valid.ok) {
      throw new Error(`invalid task.verify: ${valid.errors.join("; ")}`);
    }
  }

  const stampedFromRev =
    Number.isInteger(input?.stampedFromRev)
      ? input.stampedFromRev
      : (input?.tracker?.meta?.rev ?? null);
  const items = mergeItems(task?.verify, input?.profile, input?.workspace);

  return freezePack({
    jobId: input?.jobId ?? input?.job?.id ?? null,
    stampedAt: input?.stampedAt ?? new Date().toISOString(),
    stampedFromRev,
    items
  }, { normalize: true });
}

export function collectReadyHumanApprovalRequests(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return [];
  const items = Array.isArray(job.verifyPack?.items) ? job.verifyPack.items : [];
  const gatesById = new Map();
  for (const gate of Array.isArray(job.completionGates) ? job.completionGates : []) {
    if (gate && typeof gate.id === "string" && gate.id.length > 0) {
      gatesById.set(gate.id, gate);
    }
  }
  const pendingRequests = new Set();
  for (const request of Array.isArray(job.humanApprovalRequests) ? job.humanApprovalRequests : []) {
    if (request?.status === "pending" && typeof request.itemId === "string") {
      pendingRequests.add(request.itemId);
    }
  }

  const requests = [];
  for (const item of items) {
    if (!item || item.kind !== "human_approval") continue;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (pendingRequests.has(item.id)) continue;
    const gate = gatesById.get(item.id);
    if (gate && (gate.status === "satisfied" || gate.status === "overridden" || gate.status === "failed")) {
      continue;
    }
    const required = gate?.required === true || item.required === true;
    const blocksCompletion = required && (!gate || gate.status === "pending" || gate.status === undefined);
    requests.push({
      itemId: item.id,
      itemKind: "human_approval",
      required,
      blocksCompletion,
      title: blocksCompletion ? HUMAN_APPROVAL_REQUIRED_TITLE : HUMAN_REVIEW_READY_TITLE,
      ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
    });
  }
  return requests;
}
