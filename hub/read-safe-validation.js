import { inferTrackerErrorHint } from "./error-payload.js";

const READ_SAFE_SCHEMA_ERROR_PATTERNS = [
  /task\.comment is too long/,
  /task\.blocker_reason is too long/,
  /meta\.scratchpad is too long/,
  /reference must use path:line or path:line-line/
];

export function isReadSafeSchemaError(error) {
  return READ_SAFE_SCHEMA_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function readSafeSchemaWarning(errors) {
  const message = errors.join("; ");
  return {
    type: "schema",
    error: message,
    message,
    hint:
      inferTrackerErrorHint(message) ||
      "Existing tracker data has schema validation issues. Read and direct repair tools are showing the current state, but fix the reported fields with tracker_patch or a valid tracker-file repair."
  };
}
