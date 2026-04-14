import Ajv from "ajv";
import addFormats from "ajv-formats";

export const STATUS_VALUES = ["not_started", "in_progress", "complete", "deferred"];

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
        scratchpad: { type: "string" },
        updatedAt: { type: ["string", "null"] }
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
          blocker_reason: { type: ["string", "null"] },
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
