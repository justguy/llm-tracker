import Ajv from "ajv";
import addFormats from "ajv-formats";
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
      if (!taskIds.has(dep)) {
        errors.push(`/tasks/${i}/dependencies: "${dep}" is not a task id in this project`);
      }
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
