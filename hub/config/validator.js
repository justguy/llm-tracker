// SH-0-07 schema validator. The schema lives in
// schema/workspace.schema.json and is now STRICT:
//   - top-level: only `sessionHub` is allowed (additionalProperties: false)
//   - inside sessionHub: each block declares its TDD §25 keys with proper
//     types, enums, and integer minima; unknown keys are rejected
//     (additionalProperties: false per block).
//   - `sessionHub.trustedLocalMode.neverAutoApproveTerminalPrompts` is
//     pinned to `const: true` — flipping it to false fails validation. See
//     TDD §23.2 closure #20 and docs/session-hub/precedence.md.
//
// The bundled §25 defaults (hub/config/defaults.js) MUST validate against
// this schema; the loader merges defaults under any user overlay, so a
// well-formed config produces a well-formed merged view.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "..", "schema", "workspace.schema.json");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = ajv.compile(schema);

function formatAjvError(err) {
  const path = err.instancePath || "/";
  // The non-overridable safety flag gets a dedicated, loud message so
  // operators are not left guessing why their config was rejected.
  if (
    err.keyword === "const" &&
    path === "/sessionHub/trustedLocalMode/neverAutoApproveTerminalPrompts"
  ) {
    return `${path}: sessionHub.trustedLocalMode.neverAutoApproveTerminalPrompts is non-overridable and must be true (TDD §23.2 #20)`;
  }
  if (err.keyword === "additionalProperties") {
    if (path === "" || path === "/") {
      return `/: unknown key "${err.params.additionalProperty}" (only "sessionHub" is allowed at the top level)`;
    }
    return `${path}: unknown key "${err.params.additionalProperty}" — not declared in TDD §25 for this block`;
  }
  if (err.keyword === "type") {
    return `${path}: must be ${err.params.type}`;
  }
  if (err.keyword === "enum") {
    return `${path}: must be one of ${JSON.stringify(err.params.allowedValues)}`;
  }
  if (err.keyword === "required") {
    return `${path}: missing required key "${err.params.missingProperty}"`;
  }
  return `${path}: ${err.message}`;
}

export function validateWorkspaceConfig(data) {
  // A null/undefined config (i.e. empty file) is treated as the empty object
  // so the merge-with-defaults path still runs cleanly. The schema itself
  // requires an object at the root, so we normalize here.
  const target = data == null ? {} : data;
  const ok = compiled(target);
  if (ok) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: compiled.errors.map(formatAjvError)
  };
}

export { SCHEMA_PATH };
