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

import {
  WARNING_KINDS,
  DEPRECATED_WARNING_KINDS,
  assertValidWarning,
} from "../sessions/warnings.js";

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
  "session.stop.requested",
  "process.signal_sent",
  "process.exited",
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

// --- SH-2-02: SessionWarning event factories ------------------------------
//
// These build `session.warning` and `session.warning_cleared` runtime events
// from a validated SessionWarning (TDD §8.3). The factories run
// `assertValidWarning` first so callers get a field-pointed §8.3 error before
// AJV gets a chance to emit its more schema-shaped (and less actionable)
// messages. After the per-kind lint, the event is validated against the
// runtime-events schema as a defence-in-depth check.
//
// `source` defaults to `"system"` because the hub's emit sites
// (ActivityMonitor, sandbox watcher, etc.) are all hub-internal — when an
// adapter or HTTP caller wants to surface a warning they pass their own
// `source`. The event `id` is intentionally left undefined when the caller
// doesn't provide one; the RuntimeStore stamps the canonical `evt_` id at
// append time (same pattern SessionRegistry uses).

/**
 * Build a `session.warning` runtime event.
 *
 * Validates the supplied `warning` against §8.3 first (rejects unknown /
 * deprecated kinds and per-kind missing/wrong-typed fields before AJV runs),
 * then runs the schema's variant validator as a defence-in-depth check.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {object} input.warning            SessionWarning per TDD §8.3
 * @param {string} input.workspace
 * @param {string} [input.source="system"]  RuntimeEvent.source (default "system")
 * @param {string} [input.ts]               ISO-8601 timestamp (default now)
 * @param {string} [input.id]               event id (omit so RuntimeStore stamps it)
 * @param {string} [input.idempotencyKey]
 * @returns {object} the validated runtime event
 */
export function createSessionWarningEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("createSessionWarningEvent: input must be an object");
  }
  const { sessionId, warning, workspace, source = "system", ts, id, idempotencyKey } = input;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("createSessionWarningEvent: sessionId required (non-empty string)");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("createSessionWarningEvent: workspace required (non-empty string)");
  }
  // §8.3 lint runs first so the rejection message points at the deprecated
  // kind / missing field instead of an AJV "additionalProperties" complaint.
  assertValidWarning(warning);

  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: 1,
    ts: typeof ts === "string" ? ts : new Date().toISOString(),
    type: "session.warning",
    source,
    workspace,
    sessionId,
    warning,
  };
  if (typeof id === "string") event.id = id;
  if (typeof idempotencyKey === "string") event.idempotencyKey = idempotencyKey;

  // validateRuntimeEvent requires `id`. When the caller omitted it (so the
  // store can stamp the canonical id at append time), validate with a
  // placeholder id and strip it before returning so the returned event is
  // append-ready.
  if (event.id === undefined) {
    validateRuntimeEvent({ ...event, id: "evt_00000000000000000000000000" });
  } else {
    validateRuntimeEvent(event);
  }
  return event;
}

/**
 * Build a `session.warning_cleared` runtime event.
 *
 * Asserts `warningKind` is one of the 8 allowed kinds and explicitly NOT a
 * deprecated kind (per §23.1). Same id/ts/source defaults as
 * createSessionWarningEvent.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.warningKind         one of WARNING_KINDS
 * @param {string} input.workspace
 * @param {string} [input.source="system"]
 * @param {string} [input.ts]
 * @param {string} [input.id]
 * @param {string} [input.idempotencyKey]
 * @returns {object} the validated runtime event
 */
export function createSessionWarningClearedEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("createSessionWarningClearedEvent: input must be an object");
  }
  const { sessionId, warningKind, workspace, source = "system", ts, id, idempotencyKey } = input;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("createSessionWarningClearedEvent: sessionId required (non-empty string)");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("createSessionWarningClearedEvent: workspace required (non-empty string)");
  }
  if (typeof warningKind !== "string") {
    throw new Error("createSessionWarningClearedEvent: warningKind required (string)");
  }
  if (DEPRECATED_WARNING_KINDS.includes(warningKind)) {
    const replacement = warningKind === "quiet" ? "quiet_terminal" : warningKind;
    const err = new Error(
      `createSessionWarningClearedEvent: warningKind '${warningKind}' is deprecated; use '${replacement}' (TDD §23.1)`,
    );
    /** @type {any} */ (err).details = { field: "/warningKind", deprecated: warningKind };
    throw err;
  }
  if (!WARNING_KINDS.includes(warningKind)) {
    throw new Error(
      `createSessionWarningClearedEvent: warningKind '${warningKind}' not in ${WARNING_KINDS.join("|")}`,
    );
  }

  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: 1,
    ts: typeof ts === "string" ? ts : new Date().toISOString(),
    type: "session.warning_cleared",
    source,
    workspace,
    sessionId,
    warningKind,
  };
  if (typeof id === "string") event.id = id;
  if (typeof idempotencyKey === "string") event.idempotencyKey = idempotencyKey;

  if (event.id === undefined) {
    validateRuntimeEvent({ ...event, id: "evt_00000000000000000000000000" });
  } else {
    validateRuntimeEvent(event);
  }
  return event;
}

// --- SH-2-23: Stdio capture toggle event factory --------------------------
//
// Builds a `session.stdio_capture_changed` runtime event. The schema variant
// (SessionStdioCaptureChangedEvent) requires `capture: { enabled: boolean }`
// — this factory accepts `captureToDisk` (the API/DoD shape), keeps it as a
// compatibility field, and packs it into the schema-shaped `capture.enabled`.
// `reason`, when supplied, rides as a top-level extra prop (the schema allows
// additionalProperties on the base).
//
// Same placeholder-id dance as the warning factories above: when the caller
// omits `id`, validate against a placeholder and strip it before returning so
// the returned event is append-ready (the RuntimeStore stamps the canonical
// evt_ id at append time).

/**
 * Build a `session.stdio_capture_changed` runtime event.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {boolean} input.captureToDisk      mapped to `capture.enabled`
 * @param {string} input.workspace
 * @param {string} [input.reason]            optional rationale (non-empty string)
 * @param {string} [input.source="http"]
 * @param {string} [input.ts]
 * @param {string} [input.id]
 * @param {string} [input.idempotencyKey]
 * @returns {object} the validated runtime event
 */
export function createSessionStdioCaptureChangedEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("createSessionStdioCaptureChangedEvent: input must be an object");
  }
  const {
    sessionId,
    captureToDisk,
    workspace,
    reason,
    source = "http",
    ts,
    id,
    idempotencyKey,
  } = input;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("createSessionStdioCaptureChangedEvent: sessionId required (non-empty string)");
  }
  if (typeof captureToDisk !== "boolean") {
    throw new Error("createSessionStdioCaptureChangedEvent: captureToDisk required (boolean)");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("createSessionStdioCaptureChangedEvent: workspace required (non-empty string)");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    throw new Error("createSessionStdioCaptureChangedEvent: reason must be a non-empty string when present");
  }

  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: 1,
    ts: typeof ts === "string" ? ts : new Date().toISOString(),
    type: "session.stdio_capture_changed",
    source,
    workspace,
    sessionId,
    captureToDisk,
    capture: { enabled: captureToDisk },
  };
  if (event.id === undefined) {
    validateRuntimeEvent({ ...event, id: "evt_00000000000000000000000000" });
  } else {
    validateRuntimeEvent(event);
  }
  return event;
}

// --- SH-4-05: Attention ack / snooze / cleared event factories ------------
//
// Build `attention.ack`, `attention.snoozed`, `attention.cleared` runtime
// events for POST /api/attention/:id/{ack|snooze|clear}. These persist
// operator overlays on the AttentionEngine projection; they never mutate
// durable tracker truth (TDD §23.2 #16, §8A.3).
//
// All three types currently route through the schema's GenericRuntimeEvent
// variant (schema/runtime-events.schema.json #/definitions/GenericRuntimeEvent),
// which enforces the base RuntimeEvent shape and accepts additional
// properties for the attention-specific payload. The strict per-variant
// schemas are not yet spec'd in §6.6 — the field names below are derived
// from the AttentionItem shape (§6.8): `acknowledgedAt`, `snoozedUntil`,
// `clearedAt`. Same placeholder-id dance as the other factories: validate
// against a placeholder when the caller omits `id` so the returned event is
// append-ready (RuntimeStore stamps the canonical evt_ id at append time).

const ATTENTION_ITEM_ID_SHAPE = /^att_[0-9a-hjkmnp-tv-z]{26}$/;

function isAttentionItemIdShape(value) {
  return typeof value === "string" && ATTENTION_ITEM_ID_SHAPE.test(value);
}

/**
 * Build an `attention.ack` runtime event.
 *
 * @param {object} input
 * @param {string} input.attentionItemId      att_ id of the AttentionItem
 * @param {string} input.dedupeKey            §6.8 dedupeKey (kind + scope fingerprint)
 * @param {string} input.workspace
 * @param {string} [input.acknowledgedAt]     ISO-8601 (default now)
 * @param {string} [input.actor]              optional human/actor label
 * @param {string} [input.source="http"]
 * @param {string} [input.ts]                 ISO-8601 (default now)
 * @param {string} [input.id]
 * @param {string} [input.idempotencyKey]
 * @returns {object} the validated runtime event
 */
export function createAttentionAckEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("createAttentionAckEvent: input must be an object");
  }
  const {
    attentionItemId,
    dedupeKey,
    workspace,
    acknowledgedAt,
    actor,
    source = "http",
    ts,
    id,
    idempotencyKey,
  } = input;
  if (!isAttentionItemIdShape(attentionItemId)) {
    throw new Error("createAttentionAckEvent: attentionItemId required (att_<26 Crockford>)");
  }
  if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
    throw new Error("createAttentionAckEvent: dedupeKey required (non-empty string)");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("createAttentionAckEvent: workspace required (non-empty string)");
  }
  if (acknowledgedAt !== undefined && (typeof acknowledgedAt !== "string" || acknowledgedAt.length === 0)) {
    throw new Error("createAttentionAckEvent: acknowledgedAt must be a non-empty ISO-8601 string when present");
  }
  if (actor !== undefined && (typeof actor !== "string" || actor.length === 0)) {
    throw new Error("createAttentionAckEvent: actor must be a non-empty string when present");
  }

  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: 1,
    ts: typeof ts === "string" ? ts : now,
    type: "attention.ack",
    source,
    workspace,
    attentionItemId,
    dedupeKey,
    acknowledgedAt: acknowledgedAt || now,
  };
  if (actor !== undefined) event.actor = actor;
  if (typeof id === "string") event.id = id;
  if (typeof idempotencyKey === "string") event.idempotencyKey = idempotencyKey;

  if (event.id === undefined) {
    validateRuntimeEvent({ ...event, id: "evt_00000000000000000000000000" });
  } else {
    validateRuntimeEvent(event);
  }
  return event;
}

/**
 * Build an `attention.snoozed` runtime event.
 *
 * @param {object} input
 * @param {string} input.attentionItemId
 * @param {string} input.dedupeKey
 * @param {string} input.snoozedUntil         ISO-8601 future timestamp (required)
 * @param {string} input.reason               non-empty rationale (required)
 * @param {string} input.workspace
 * @param {string} [input.actor]
 * @param {string} [input.source="http"]
 * @param {string} [input.ts]
 * @param {string} [input.id]
 * @param {string} [input.idempotencyKey]
 * @returns {object} the validated runtime event
 */
export function createAttentionSnoozedEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("createAttentionSnoozedEvent: input must be an object");
  }
  const {
    attentionItemId,
    dedupeKey,
    snoozedUntil,
    reason,
    workspace,
    actor,
    source = "http",
    ts,
    id,
    idempotencyKey,
  } = input;
  if (!isAttentionItemIdShape(attentionItemId)) {
    throw new Error("createAttentionSnoozedEvent: attentionItemId required (att_<26 Crockford>)");
  }
  if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
    throw new Error("createAttentionSnoozedEvent: dedupeKey required (non-empty string)");
  }
  if (typeof snoozedUntil !== "string" || snoozedUntil.length === 0) {
    throw new Error("createAttentionSnoozedEvent: snoozedUntil required (ISO-8601 string)");
  }
  const untilMs = Date.parse(snoozedUntil);
  if (Number.isNaN(untilMs)) {
    throw new Error("createAttentionSnoozedEvent: snoozedUntil must be a parseable ISO-8601 timestamp");
  }
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("createAttentionSnoozedEvent: reason required (non-empty string)");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("createAttentionSnoozedEvent: workspace required (non-empty string)");
  }
  if (actor !== undefined && (typeof actor !== "string" || actor.length === 0)) {
    throw new Error("createAttentionSnoozedEvent: actor must be a non-empty string when present");
  }

  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: 1,
    ts: typeof ts === "string" ? ts : new Date().toISOString(),
    type: "attention.snoozed",
    source,
    workspace,
    attentionItemId,
    dedupeKey,
    snoozedUntil,
    reason,
  };
  if (actor !== undefined) event.actor = actor;
  if (typeof id === "string") event.id = id;
  if (typeof idempotencyKey === "string") event.idempotencyKey = idempotencyKey;

  if (event.id === undefined) {
    validateRuntimeEvent({ ...event, id: "evt_00000000000000000000000000" });
  } else {
    validateRuntimeEvent(event);
  }
  return event;
}

/**
 * Build an `attention.cleared` runtime event.
 *
 * Per TDD §23.2 #16 and §8A.3, "cleared" records an explicit human override —
 * the projection layer is responsible for honoring it; this factory does not
 * forcibly mutate engine output.
 *
 * @param {object} input
 * @param {string} input.attentionItemId
 * @param {string} input.dedupeKey
 * @param {string} input.reason               non-empty rationale (required)
 * @param {string} input.workspace
 * @param {string} [input.clearedAt]          ISO-8601 (default now)
 * @param {string} [input.actor]
 * @param {string} [input.source="http"]
 * @param {string} [input.ts]
 * @param {string} [input.id]
 * @param {string} [input.idempotencyKey]
 * @returns {object} the validated runtime event
 */
export function createAttentionClearedEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("createAttentionClearedEvent: input must be an object");
  }
  const {
    attentionItemId,
    dedupeKey,
    reason,
    workspace,
    clearedAt,
    actor,
    source = "http",
    ts,
    id,
    idempotencyKey,
  } = input;
  if (!isAttentionItemIdShape(attentionItemId)) {
    throw new Error("createAttentionClearedEvent: attentionItemId required (att_<26 Crockford>)");
  }
  if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
    throw new Error("createAttentionClearedEvent: dedupeKey required (non-empty string)");
  }
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("createAttentionClearedEvent: reason required (non-empty string)");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("createAttentionClearedEvent: workspace required (non-empty string)");
  }
  if (clearedAt !== undefined && (typeof clearedAt !== "string" || clearedAt.length === 0)) {
    throw new Error("createAttentionClearedEvent: clearedAt must be a non-empty ISO-8601 string when present");
  }
  if (actor !== undefined && (typeof actor !== "string" || actor.length === 0)) {
    throw new Error("createAttentionClearedEvent: actor must be a non-empty string when present");
  }

  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const event = {
    schemaVersion: 1,
    ts: typeof ts === "string" ? ts : now,
    type: "attention.cleared",
    source,
    workspace,
    attentionItemId,
    dedupeKey,
    reason,
    clearedAt: clearedAt || now,
  };
  if (actor !== undefined) event.actor = actor;
  if (typeof id === "string") event.id = id;
  if (typeof idempotencyKey === "string") event.idempotencyKey = idempotencyKey;

  if (event.id === undefined) {
    validateRuntimeEvent({ ...event, id: "evt_00000000000000000000000000" });
  } else {
    validateRuntimeEvent(event);
  }
  return event;
}
