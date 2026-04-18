export const TASK_OUTCOME_VALUES = ["partial_slice_landed"];

export function humanizeTaskOutcome(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? trimmed.replaceAll("_", " ") : "";
}
