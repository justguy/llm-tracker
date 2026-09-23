// hub/providers/codex-schema/index.js
//
// Vendored Codex App Server protocol schema access and validation helpers.

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CODEX_SCHEMA_VERSION = "v0.135.0";
export const CODEX_SCHEMA_CHANNEL = "stable";
export const CODEX_SCHEMA_FILENAME = "codex-app-server.schema.json";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function codexSchemaPath({
  version = DEFAULT_CODEX_SCHEMA_VERSION,
  channel = CODEX_SCHEMA_CHANNEL,
  rootDir = MODULE_DIR,
} = {}) {
  return join(rootDir, normalizeVersion(version), normalizeSegment(channel), CODEX_SCHEMA_FILENAME);
}

export async function loadVendoredCodexSchema(opts = {}) {
  const schemaPath = opts.path || codexSchemaPath(opts);
  const raw = await readFile(schemaPath, "utf8");
  const schema = JSON.parse(raw);
  return validateSchemaEnvelope(schema, schemaPath);
}

export function createCodexSchemaValidator(schema) {
  const normalized = validateSchemaEnvelope(schema);
  const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
  for (const format of ["uint", "uint16", "uint32"]) ajv.addFormat(format, true);
  const outgoingSchema = schemaForEnvelopeKind(normalized, "outgoingCall");
  const incomingSchema = schemaForEnvelopeKind(normalized, "incomingEvent");
  const validateOutgoing = ajv.compile(outgoingSchema);
  const validateIncoming = ajv.compile(incomingSchema);
  return Object.freeze({
    schema: normalized,
    methods: normalized.methods.map((method) => method.name),
    events: normalized.events.map((event) => event.name),
    validateOutgoingCall(value) {
      return assertValid(validateOutgoing, value, "outgoing_call");
    },
    validateIncomingEvent(value) {
      return assertValid(validateIncoming, value, "incoming_event");
    },
  });
}

export function validateCodexOutgoingCall(schema, value) {
  return createCodexSchemaValidator(schema).validateOutgoingCall(value);
}

export function validateCodexIncomingEvent(schema, value) {
  return createCodexSchemaValidator(schema).validateIncomingEvent(value);
}

export function compareCodexSchema(a, b) {
  const left = stableJson(validateSchemaEnvelope(a));
  const right = stableJson(validateSchemaEnvelope(b));
  return {
    equal: left === right,
    leftHash: hashString(left),
    rightHash: hashString(right),
  };
}

function validateSchemaEnvelope(schema, schemaPath) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw schemaError("Codex schema must be an object", "INVALID_SCHEMA", { schemaPath });
  }
  if (!Array.isArray(schema.methods) || !Array.isArray(schema.events)) {
    throw schemaError("Codex schema must declare methods[] and events[]", "INVALID_SCHEMA", {
      schemaPath,
    });
  }
  const methods = normalizeNamedEntries(schema.methods, "method", schemaPath);
  const events = normalizeNamedEntries(schema.events, "event", schemaPath);
  return Object.freeze({
    ...schema,
    methods: Object.freeze(methods),
    events: Object.freeze(events),
  });
}

function normalizeNamedEntries(entries, kind, schemaPath) {
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string" || !entry.name) {
      throw schemaError(`Codex schema ${kind} at index ${index} must include name`, "INVALID_SCHEMA", {
        schemaPath,
        index,
      });
    }
    return Object.freeze({ ...entry });
  });
}

function schemaForEnvelopeKind(schema, kind) {
  const defs = schema.$defs || schema.definitions || {};
  if (kind === "outgoingCall" && defs.OutgoingCall) return { ...defs.OutgoingCall, $defs: defs };
  if (kind === "incomingEvent" && defs.IncomingEvent) return { ...defs.IncomingEvent, $defs: defs };
  const names = kind === "outgoingCall"
    ? schema.methods.map((method) => method.name)
    : schema.events.map((event) => event.name);
  return {
    type: "object",
    additionalProperties: true,
    required: ["jsonrpc", "method"],
    properties: {
      jsonrpc: { const: "2.0" },
      id: kind === "outgoingCall" ? { anyOf: [{ type: "string" }, { type: "number" }] } : true,
      method: { enum: names },
      params: { type: "object" },
    },
  };
}

function assertValid(validate, value, kind) {
  if (validate(value)) return value;
  throw schemaError(`Codex ${kind} failed schema validation`, "CODEX_SCHEMA_VALIDATION_FAILED", {
    kind,
    errors: validate.errors || [],
  });
}

function normalizeVersion(version) {
  const value = String(version || "").trim();
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw schemaError("Codex schema version must be semver", "INVALID_SCHEMA_VERSION", { version });
  }
  return value.startsWith("v") ? value : `v${value}`;
}

function normalizeSegment(segment) {
  const value = String(segment || "").trim();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(value)) {
    throw schemaError("Codex schema path segment is invalid", "INVALID_SCHEMA_PATH", { segment });
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
  return out;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function schemaError(message, code, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}
