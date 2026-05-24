import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "..", "schema", "tracker-task-extensions.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = ajv.compile(schema);

const NUL = "\u0000";
const WIN_DRIVE_RE = /^[A-Za-z]:/;
const URI_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|file|data|ssh|git):)/i;

function formatAjvError(err) {
  const path = err.instancePath || "/";
  if (err.keyword === "const") {
    return `${path}: must be "${err.params.allowedValue}"`;
  }
  if (err.keyword === "enum") {
    return `${path}: must be one of [${(err.params.allowedValues || []).join(", ")}]`;
  }
  if (err.keyword === "required") {
    return `${path}: missing required field "${err.params.missingProperty}"`;
  }
  if (err.keyword === "pattern") {
    return `${path}: does not match pattern ${err.params.pattern}`;
  }
  if (err.keyword === "additionalProperties") {
    return `${path}: unexpected property "${err.params.additionalProperty}"`;
  }
  if (err.keyword === "maxLength") {
    return `${path}: must be ≤ ${err.params.limit} chars`;
  }
  if (err.keyword === "minLength") {
    return `${path}: must be a non-empty string`;
  }
  if (err.keyword === "maxItems") {
    return `${path}: must have ≤ ${err.params.limit} items`;
  }
  if (err.keyword === "minimum" || err.keyword === "maximum") {
    return `${path}: ${err.message}`;
  }
  return `${path}: ${err.message}`;
}

function checkNoNul(value, loc, errors) {
  if (typeof value === "string" && value.includes(NUL)) {
    errors.push(`${loc}: must not contain NUL byte`);
  }
}

function checkRepoRelativePath(value, loc, errors) {
  if (typeof value !== "string") return;
  if (value.includes(NUL)) {
    errors.push(`${loc}: must not contain NUL byte`);
    return;
  }
  if (value.startsWith("/")) {
    errors.push(`${loc}: must be repo-relative; must not start with "/"`);
    return;
  }
  if (WIN_DRIVE_RE.test(value)) {
    errors.push(`${loc}: must be repo-relative; Windows-drive paths rejected`);
    return;
  }
  if (URI_SCHEME_RE.test(value)) {
    errors.push(`${loc}: must be repo-relative; URI schemes rejected`);
    return;
  }
  if (value.includes("\\")) {
    errors.push(`${loc}: must be repo-relative POSIX-style path; backslashes rejected`);
    return;
  }
  const segments = value.split("/");
  if (segments.some((s) => s === "..")) {
    errors.push(`${loc}: must be repo-relative; must not contain ".." segment`);
  }
}

export function validateAllowedPaths(paths, loc, errors) {
  if (!Array.isArray(paths)) return;
  for (let i = 0; i < paths.length; i++) {
    checkRepoRelativePath(paths[i], `${loc}/${i}`, errors);
  }
}

function validateRepoRef(ref, loc, errors) {
  if (!ref || typeof ref !== "object") return;
  if (typeof ref.root === "string") checkNoNul(ref.root, `${loc}/root`, errors);
  if (typeof ref.worktree === "string") checkNoNul(ref.worktree, `${loc}/worktree`, errors);
  if (typeof ref.branch === "string") checkNoNul(ref.branch, `${loc}/branch`, errors);
  if (Array.isArray(ref.allowed_paths)) {
    validateAllowedPaths(ref.allowed_paths, `${loc}/allowed_paths`, errors);
  }
}

function validateVerifyItems(items, loc, errors) {
  if (!Array.isArray(items)) return;
  const seenIds = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    const itemLoc = `${loc}/items/${i}`;
    if (typeof item.id === "string") {
      if (seenIds.has(item.id)) {
        errors.push(`${itemLoc}/id: duplicate verify-item id "${item.id}" in task.verify.items`);
      } else {
        seenIds.add(item.id);
      }
    }
    if (item.kind === "command" && typeof item.cwd === "string") {
      checkRepoRelativePath(item.cwd, `${itemLoc}/cwd`, errors);
    }
  }
}

export function validateTaskExtensions(task, locPrefix = "") {
  if (!task || typeof task !== "object") {
    return { ok: true, errors: [] };
  }
  const hasRepos = Object.prototype.hasOwnProperty.call(task, "repos");
  const hasVerify = Object.prototype.hasOwnProperty.call(task, "verify");
  if (!hasRepos && !hasVerify) {
    return { ok: true, errors: [] };
  }

  const errors = [];
  const payload = {};
  if (hasRepos) payload.repos = task.repos;
  if (hasVerify) payload.verify = task.verify;

  if (!compiled(payload)) {
    for (const e of compiled.errors) {
      errors.push(`${locPrefix}${formatAjvError(e)}`);
    }
  }

  if (hasRepos && payload.repos && typeof payload.repos === "object") {
    if (payload.repos.primary) {
      validateRepoRef(payload.repos.primary, `${locPrefix}/repos/primary`, errors);
    }
    if (Array.isArray(payload.repos.secondary)) {
      for (let i = 0; i < payload.repos.secondary.length; i++) {
        validateRepoRef(payload.repos.secondary[i], `${locPrefix}/repos/secondary/${i}`, errors);
      }
    }
  }

  if (
    hasVerify &&
    payload.verify &&
    typeof payload.verify === "object" &&
    Array.isArray(payload.verify.items)
  ) {
    validateVerifyItems(payload.verify.items, `${locPrefix}/verify`, errors);
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function validateAllTaskExtensions(tasks) {
  if (!Array.isArray(tasks)) {
    return { ok: true, errors: [] };
  }
  const errors = [];
  for (let i = 0; i < tasks.length; i++) {
    const res = validateTaskExtensions(tasks[i], `/tasks/${i}`);
    if (!res.ok) errors.push(...res.errors);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
