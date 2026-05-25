function stringArray(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string" && value.trim());
}

function repoRefs(task) {
  const refs = [];
  if (task?.repos?.primary && typeof task.repos.primary === "object") {
    refs.push(task.repos.primary);
  }
  if (Array.isArray(task?.repos?.secondary)) {
    refs.push(...task.repos.secondary.filter((ref) => ref && typeof ref === "object"));
  }
  return refs;
}

export function effectiveAllowedPaths(task) {
  const refs = repoRefs(task);
  const hasRepoAllowedPaths = refs.some((ref) =>
    Object.prototype.hasOwnProperty.call(ref, "allowed_paths")
  );
  if (hasRepoAllowedPaths) {
    return refs.flatMap((ref) => stringArray(ref.allowed_paths));
  }
  return stringArray(task?.allowed_paths);
}

