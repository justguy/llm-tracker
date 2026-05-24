// hub/runtime/events.js — sh-1-02 (TDD v0.5 §6.6, §6.10)
//
// RuntimeEvent JSON Schema validation. Loads the §6.6 union schema from
// schema/runtime-events.schema.json, compiles it with AJV (same library used
// by hub/validator.js and hub/config/validator.js), and exposes:
//
//   - validateRuntimeEvent(event) — throws on invalid input; .errors carries
//     the full AJV error array; the thrown message points at the field that
//     failed (e.g. "/session/tier"), plus a "plus N more" tail when AJV finds
//     more than one violation.
//
//   - RUNTIME_EVENT_TYPES — frozen list of every event-type string permitted
//     by the schema's base `type` enum. Kept in sync with the schema by a
//     unit test (test/runtime-events.test.js).
//
//   - runtimeEventsSchema — the loaded schema, re-exported for inspection
//     and for the in-sync test.
//
// Why per-variant validators (not just one top-level `oneOf` validator):
// when an event with a known `type` value fails a strict variant, AJV's
// `oneOf` strategy emits one error per *every other* variant (e.g. 40+ "must
// be equal to constant" complaints for the const-type discriminator on each
// non-matching variant). To get a field-pointed message back to the operator,
// we route on `type` ourselves and run the single relevant variant validator,
// falling back to the union for everything else (unknown / non-string type).

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, "..", "..", "schema", "runtime-events.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Top-level union validator. Used as the source of truth and as the fallback
// for events whose `type` field is missing/unknown/non-string.
const unionValidator = ajv.compile(schema);

// Build a `type` -> variant validator map. Each variant in #/definitions whose
// `type` property is a const becomes a fast-path validator that returns sharp
// field-pointed errors when the user's `type` matches its const.
const variantValidatorsByType = new Map();
for (const [defName, defSchema] of Object.entries(schema.definitions || {})) {
  const typeProp = defSchema && defSchema.properties && defSchema.properties.type;
  if (typeProp && typeof typeProp.const === "string") {
    // Compile a *copy* with a unique $id so AJV doesn't complain about the
    // duplicate root $id. Internal $refs (#/definitions/sessionId etc.)
    // resolve against this copy because the definitions are spread in.
    const variantSchema = {
      ...schema,
      $id: `${schema.$id}#variant-${defName}`,
      $ref: `#/definitions/${defName}`,
    };
    // Drop `oneOf` cleanly so the schema is a pure $ref to the variant.
    delete variantSchema.oneOf;
    variantValidatorsByType.set(typeProp.const, ajv.compile(variantSchema));
  }
}

// GenericRuntimeEvent is the catch-all for types that don't have a strict
// variant yet (later sh-1-XX tasks tighten them as they touch them). Wire
// every type in its enum to the generic validator unless a strict variant
// already claimed that type.
const genericDef = schema.definitions && schema.definitions.GenericRuntimeEvent;
if (genericDef && genericDef.properties && Array.isArray(genericDef.properties.type.enum)) {
  const genericVariantSchema = {
    ...schema,
    $id: `${schema.$id}#variant-GenericRuntimeEvent`,
    $ref: `#/definitions/GenericRuntimeEvent`,
  };
  delete genericVariantSchema.oneOf;
  const genericValidator = ajv.compile(genericVariantSchema);
  for (const t of genericDef.properties.type.enum) {
    if (!variantValidatorsByType.has(t)) {
      variantValidatorsByType.set(t, genericValidator);
    }
  }
}

/**
 * Canonical list of every RuntimeEvent type string permitted by the schema's
 * base `type` enum. Mirrors `#/definitions/runtimeEventType.enum` exactly.
 * A unit test asserts the two lists are equal.
 *
 * @type {readonly string[]}
 */
export const RUNTIME_EVENT_TYPES = Object.freeze([
  "session.started",
  "session.status",
  "session.warning",
  "session.warning_cleared",
  "session.output",
  "session.stopped",
  "session.stdio_capture_changed",
  "session.token_rotated",
  "session.token_audit",
  "job.started",
  "job.checkpoint",
  "job.completed",
  "job.rollover_requested",
  "skill.run.started",
  "skill.run.finished",
  "repo.change",
  "repo.burst",
  "verify.command.started",
  "verify.command.completed",
  "verify.human_approval.requested",
  "verify.human_approval.resolved",
  "conflict.ack",
  "attention.ack",
  "attention.snoozed",
  "attention.cleared",
  "human.override",
  "session.sandbox_changed",
  "session.model_changed",
  "session.task_attached",
  "session.task_unbound",
  "job.queued",
  "job.unblocked",
  "sandbox.escape_requested",
  "sandbox.escape_resolved",
  "session.ask",
  "session.interrupt",
  "task.new_from_launcher",
]);

/**
 * Pick the most informative single AJV error from an error array. Prefers
 * errors with a non-empty `instancePath` (field-level) over errors at the
 * document root, and ignores the umbrella `oneOf` keyword which by itself
 * conveys no actionable detail.
 *
 * @param {import("ajv").ErrorObject[]} errors
 * @returns {import("ajv").ErrorObject}
 */
function pickPrimaryError(errors) {
  if (errors.length === 0) {
    return /** @type {any} */ ({ message: "unknown error", instancePath: "" });
  }
  // Skip the unhelpful "must match exactly one schema in oneOf" umbrella.
  const useful = errors.filter((e) => !(e.keyword === "oneOf" && (e.instancePath || "") === ""));
  if (useful.length === 0) return errors[0];
  // Prefer field-level errors (non-empty instancePath).
  const withPath = useful.filter((e) => (e.instancePath || "") !== "");
  if (withPath.length > 0) {
    // Among field-level errors, prefer the deepest path (most specific).
    withPath.sort((a, b) => (b.instancePath || "").length - (a.instancePath || "").length);
    return withPath[0];
  }
  return useful[0];
}

/**
 * Validate a runtime event against the §6.6 union schema. Returns `true` on
 * success; throws on failure with:
 *
 *   - `.message`  — human-readable, field-pointed: "RuntimeEvent invalid at
 *                   /session/tier: must be equal to one of the allowed values
 *                   (plus 3 more)"
 *   - `.errors`   — full AJV error array (every violation, since the validator
 *                   is compiled with `allErrors: true`)
 *   - `.event`    — the rejected event (for logging/debugging)
 *
 * @param {unknown} event
 * @returns {true}
 */
export function validateRuntimeEvent(event) {
  // Fast path: route on `type` to the single matching variant validator, so
  // failed events come back with sharp field-level AJV errors instead of a
  // flood of "must equal const X" entries from every other variant.
  const declaredType =
    event && typeof event === "object" && !Array.isArray(event)
      ? /** @type {any} */ (event).type
      : undefined;
  const variantValidator =
    typeof declaredType === "string" ? variantValidatorsByType.get(declaredType) : undefined;

  if (variantValidator) {
    const ok = variantValidator(event);
    if (ok) return true;
    throwFromErrors(variantValidator.errors || [], event);
  }

  // Fallback for missing/unknown/non-string `type`: use the full union.
  const ok = unionValidator(event);
  if (ok) return true;
  throwFromErrors(unionValidator.errors || [], event);
}

/**
 * @param {import("ajv").ErrorObject[]} errors
 * @param {unknown} event
 * @returns {never}
 */
function throwFromErrors(errors, event) {
  const primary = pickPrimaryError(errors);
  const fieldPath = primary.instancePath || "(root)";
  const reason = primary.message || "is invalid";
  const more = errors.length > 1 ? ` (plus ${errors.length - 1} more)` : "";
  const err = new Error(`RuntimeEvent invalid at ${fieldPath}: ${reason}${more}`);
  /** @type {any} */ (err).errors = errors;
  /** @type {any} */ (err).event = event;
  throw err;
}

export { schema as runtimeEventsSchema };
