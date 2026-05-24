import { validateTaskExtensions } from "../validator/task-extensions.js";

// SH-5-04 composition core. The surrounding job lifecycle still stamps this
// onto JobRecord once sh-3-05 lands; this module keeps composition deterministic.

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
