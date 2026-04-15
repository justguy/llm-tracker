export const REFERENCE_PATTERN_SOURCE = "^.+:\\d+(-\\d+)?$";
export const REFERENCE_PATTERN = new RegExp(REFERENCE_PATTERN_SOURCE);

export const EFFORT_VALUES = ["xs", "s", "m", "l", "xl"];

export function isReferenceString(value) {
  return typeof value === "string" && REFERENCE_PATTERN.test(value);
}

export function normalizeTaskReferences(task) {
  if (!task || typeof task !== "object") return [];

  const out = [];
  const seen = new Set();

  const add = (value) => {
    if (!isReferenceString(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  if (Array.isArray(task.references)) {
    for (const ref of task.references) add(ref);
  }

  add(task.reference);

  return out;
}

export function hasNormalizedReferences(task) {
  return normalizeTaskReferences(task).length > 0;
}

export function normalizeEffort(value) {
  return EFFORT_VALUES.includes(value) ? value : null;
}
