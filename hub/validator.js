import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parseDependencyRef } from "./cross-project-deps.js";
import { EFFORT_VALUES, REFERENCE_PATTERN_SOURCE } from "./references.js";
import { STATUS_VALUES, TASK_OUTCOME_VALUES } from "./status-vocabulary.js";

const schema = {
  type: "object",
  required: ["meta", "tasks"],
  additionalProperties: true,
  properties: {
    meta: {
      type: "object",
      required: ["name", "slug", "swimlanes", "priorities"],
      additionalProperties: true,
      properties: {
        name: { type: "string", minLength: 1 },
        slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
        swimlanes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "label"],
            additionalProperties: true,
            properties: {
              id: { type: "string", minLength: 1 },
              label: { type: "string", minLength: 1 },
              collapsed: { type: "boolean" }
            }
          }
        },
        priorities: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "label"],
            properties: {
              id: { type: "string", minLength: 1 },
              label: { type: "string", minLength: 1 }
            }
          }
        },
        scratchpad: { type: "string", maxLength: 5000 },
        updatedAt: { type: ["string", "null"] },
        deleted_tasks: {
          type: ["array", "null"],
          items: { type: "string", minLength: 1 },
          uniqueItems: true
        }
      }
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "status", "placement"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          kind: { enum: ["task", "group"] },
          parent_id: { type: ["string", "null"] },
          goal: { type: "string" },
          status: { enum: STATUS_VALUES },
          outcome: {
            enum: [...TASK_OUTCOME_VALUES, null]
          },
          placement: {
            type: "object",
            required: ["swimlaneId", "priorityId"],
            properties: {
              swimlaneId: { type: "string", minLength: 1 },
              priorityId: { type: "string", minLength: 1 }
            }
          },
          dependencies: { type: "array", items: { type: "string" } },
          assignee: { type: ["string", "null"] },
          reference: {
            type: ["string", "null"],
            pattern: REFERENCE_PATTERN_SOURCE
          },
          references: {
            type: ["array", "null"],
            items: {
              type: "string",
              pattern: REFERENCE_PATTERN_SOURCE
            }
          },
          effort: {
            enum: [...EFFORT_VALUES, null]
          },
          related: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          comment: {
            type: ["string", "null"],
            maxLength: 500
          },
          blocker_reason: { type: ["string", "null"], maxLength: 2000 },
          definition_of_done: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          constraints: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          expected_changes: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          allowed_paths: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          approval_required_for: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          repos: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              primary: { type: ["string", "null"], minLength: 1 },
              secondary: {
                type: ["array", "null"],
                items: { type: "string", minLength: 1 },
                uniqueItems: true
              },
              allowed_paths: {
                type: ["object", "null"],
                additionalProperties: {
                  type: "array",
                  items: { type: "string", minLength: 1 }
                }
              },
              approval_required_for: {
                type: ["array", "null"],
                items: { type: "string", minLength: 1 },
                uniqueItems: true
              }
            }
          },
          context: { type: "object" },
          updatedAt: { type: ["string", "null"] },
          rev: { type: ["integer", "null"] }
        }
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = ajv.compile(schema);

function formatAjvError(err) {
  const path = err.instancePath || "/";
  if (err.keyword === "enum") {
    return `${path}: must be one of [${err.params.allowedValues.join(", ")}]`;
  }
  if (err.keyword === "required") {
    return `${path}: missing required field "${err.params.missingProperty}"`;
  }
  if (err.keyword === "pattern") {
    if (path.includes("/reference") || path.includes("/references/")) {
      return `${path}: reference must use path:line or path:line-line; bare URLs are invalid`;
    }
    return `${path}: does not match pattern ${err.params.pattern}`;
  }
  return `${path}: ${err.message}`;
}

export function validateProject(data) {
  const errors = [];

  const ok = compiled(data);
  if (!ok) {
    for (const e of compiled.errors) errors.push(formatAjvError(e));
    return { ok: false, errors };
  }

  const swimlaneIds = new Set(data.meta.swimlanes.map((s) => s.id));
  const priorityIds = new Set(data.meta.priorities.map((p) => p.id));
  const taskIds = new Set();

  for (let i = 0; i < data.tasks.length; i++) {
    const t = data.tasks[i];
    const loc = `/tasks/${i}`;

    if (taskIds.has(t.id)) {
      errors.push(`${loc}/id: duplicate task id "${t.id}"`);
    }
    taskIds.add(t.id);

    if (!swimlaneIds.has(t.placement.swimlaneId)) {
      errors.push(
        `${loc}/placement/swimlaneId: "${t.placement.swimlaneId}" not declared in meta.swimlanes`
      );
    }
    if (!priorityIds.has(t.placement.priorityId)) {
      errors.push(
        `${loc}/placement/priorityId: "${t.placement.priorityId}" not declared in meta.priorities`
      );
    }
  }

  for (let i = 0; i < data.tasks.length; i++) {
    const t = data.tasks[i];
    for (const dep of t.dependencies || []) {
      const ref = parseDependencyRef(dep);
      if (!ref) {
        errors.push(`/tasks/${i}/dependencies: "${dep}" is not a valid task id reference`);
        continue;
      }
      if (ref.kind === "external") {
        // Cross-project dependencies are validated for syntax only. Slug + task
        // existence are checked at read time when the workspace lookup runs.
        continue;
      }
      if (!taskIds.has(ref.taskId)) {
        errors.push(`/tasks/${i}/dependencies: "${dep}" is not a task id in this project`);
      }
    }

    if (t.repos && typeof t.repos === "object") {
      const primary = typeof t.repos.primary === "string" ? t.repos.primary.trim() : "";
      const secondary = Array.isArray(t.repos.secondary)
        ? t.repos.secondary
            .filter((value) => typeof value === "string" && value.trim())
            .map((value) => value.trim())
        : [];
      const declared = new Set();
      if (primary) declared.add(primary);
      for (const repo of secondary) {
        if (repo === primary) {
          errors.push(
            `/tasks/${i}/repos/secondary: "${repo}" cannot also be the primary repo`
          );
          continue;
        }
        if (declared.has(repo)) {
          errors.push(`/tasks/${i}/repos/secondary: duplicate repo "${repo}"`);
          continue;
        }
        declared.add(repo);
      }

      if (t.repos.allowed_paths && typeof t.repos.allowed_paths === "object") {
        for (const repo of Object.keys(t.repos.allowed_paths)) {
          if (!declared.has(repo)) {
            errors.push(
              `/tasks/${i}/repos/allowed_paths: "${repo}" is not declared in repos.primary or repos.secondary`
            );
          }
        }
      }

      if (Array.isArray(t.repos.approval_required_for)) {
        for (const repo of t.repos.approval_required_for) {
          if (typeof repo !== "string" || !repo.trim()) continue;
          if (!declared.has(repo)) {
            errors.push(
              `/tasks/${i}/repos/approval_required_for: "${repo}" is not declared in repos.primary or repos.secondary`
            );
          }
        }
      }
    }

    if (typeof t.parent_id === "string") {
      const parentId = t.parent_id.trim();
      if (!parentId) {
        errors.push(`/tasks/${i}/parent_id: must be a non-empty task id or null`);
      } else if (parentId === t.id) {
        errors.push(`/tasks/${i}/parent_id: task cannot be its own parent`);
      } else if (!taskIds.has(parentId)) {
        errors.push(`/tasks/${i}/parent_id: "${parentId}" is not a task id in this project`);
      }
    }
  }

  const parentById = new Map(
    data.tasks
      .filter((task) => typeof task.parent_id === "string" && task.parent_id.trim())
      .map((task) => [task.id, task.parent_id.trim()])
  );
  for (let i = 0; i < data.tasks.length; i++) {
    const task = data.tasks[i];
    const seen = new Set([task.id]);
    let current = parentById.get(task.id);
    while (current) {
      if (seen.has(current)) {
        errors.push(`/tasks/${i}/parent_id: parent chain contains a cycle`);
        break;
      }
      seen.add(current);
      current = parentById.get(current);
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
