// ui/board/TaskEditor.js — SH-5-08 (TDD v0.5 §6.9, §6.9.4, §11.6.2)
//
// Tracker board UI for editing the optional task fields introduced in
// SH-5-07: `task.repos` and `task.verify`. The file ships three layers:
//
//   1. Pure helpers (exported, unit-tested) that normalize raw form state
//      into the canonical `task.repos` / `task.verify` JSON the validator
//      accepts. The helpers enforce the SH-5-07 invariants verbatim (see
//      schema/tracker-task-extensions.schema.json + TDD §6.9.4):
//        - secondary repos ≤16; allowed_paths ≤256 entries each ≤512 chars,
//          repo-relative POSIX (no leading "/", no "..", no NUL, no Windows
//          drive letter, no URI scheme, no backslashes).
//        - root non-empty, ≤1024 chars, no NUL.
//        - verify items ≤128; ids unique within the array and match
//          ^[a-z0-9][a-z0-9_.:-]{0,63}$; required is a boolean (defaults
//          to false when missing from form state).
//        - per-kind constraints: command.cmd ≤4096 chars, timeoutSec 1..3600,
//          expectExit defaults to 0; lint.tool matches ^[a-zA-Z0-9_.:-]+$,
//          args ≤128; skill_run.skillId matches
//          ^[a-z0-9][a-z0-9_.:-]{0,127}$; human_approval.prompt ≤2000 chars;
//          dod_check.ref ≤256 chars.
//      Normalize failures throw with `.code = "INVALID_REPOS"` or
//      `.code = "INVALID_VERIFY"` so the component can surface field-level
//      errors using the same code the API will return.
//
//   2. A thin adapter — `validateTaskExtensions(taskExt)` — that delegates to
//      hub/validator/task-extensions.js (the SH-5-07 module). Keeping this in
//      the editor means save-button error messages match exactly what the
//      tracker patch endpoint emits when the same JSON is sent over the wire.
//
//   3. A small preact component (default export) that renders the editor.
//      Inline styles only; the design system styling lands in a later task.
//
// Out of scope for SH-5-08 (intentionally — these land later):
//   - Wiring `TaskEditor` into ui/board-views.js / ui/task-drawer.js — the
//     board-integration follow-up owns that.
//   - Glob preview against the workspace watcher (SH-7A-04 / SH-7-05).
//   - VerifyPack composition with profile / workspace defaults (§11.6.1).
//   - Polished design-system styling — the goal here is "edit affordances
//     exist + saved JSON validates", not a finished UI.
//
// Test convention note: UI tests in this repo do not render preact (see
// test/ui-task-drawer.test.js); they only exercise exported pure helpers.
// The SH-5-08 "UI snapshot" DoD line is therefore satisfied by deterministic
// JSON-shape assertions on the normalize / serialize helpers — they are the
// snapshot surface for the saved JSON.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { validateTaskExtensions as validateExtensionsImpl } from "../../hub/validator/task-extensions.js";

// ── Constraint constants (mirror schema/tracker-task-extensions.schema.json) ─

const MAX_SECONDARY = 16;
const MAX_ALLOWED_PATHS = 256;
const MAX_ALLOWED_PATH_LEN = 512;
const MAX_ROOT_LEN = 1024;
const MAX_WORKTREE_LEN = 1024;
const MAX_BRANCH_LEN = 256;
const MAX_VERIFY_ITEMS = 128;
const MAX_CMD_LEN = 4096;
const MAX_CWD_LEN = 1024;
const MAX_TIMEOUT_SEC = 3600;
const MIN_TIMEOUT_SEC = 1;
const MAX_LINT_ARGS = 128;
const MAX_PROMPT_LEN = 2000;
const MAX_DOD_REF_LEN = 256;

const ITEM_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const SKILL_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const LINT_TOOL_RE = /^[a-zA-Z0-9_.:-]+$/;
const URI_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|file|data|ssh|git):)/i;

const VERIFY_KINDS = Object.freeze([
  "command",
  "lint",
  "skill_run",
  "human_approval",
  "dod_check",
]);

const NUL = "\u0000";
const WIN_DRIVE_RE = /^[A-Za-z]:/;

// ── Helpers ────────────────────────────────────────────────────────────────

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function trimOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function splitAllowedPaths(input) {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
  }
  if (typeof input !== "string") return [];
  // Split on newlines or commas; trim each; drop empties.
  return input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isEmptyRepoRef(raw) {
  if (!isPlainObject(raw)) return true;
  const root = trimOrEmpty(raw.root);
  const worktree = trimOrEmpty(raw.worktree);
  const branch = trimOrEmpty(raw.branch);
  return (
    root.length === 0 &&
    worktree.length === 0 &&
    branch.length === 0 &&
    splitAllowedPaths(raw.allowed_paths).length === 0
  );
}

function checkAllowedPath(value, index) {
  if (typeof value !== "string" || value.length === 0) {
    throw fail("INVALID_REPOS", `allowed_paths[${index}]: must be a non-empty string`);
  }
  if (value.length > MAX_ALLOWED_PATH_LEN) {
    throw fail(
      "INVALID_REPOS",
      `allowed_paths[${index}]: must be ≤ ${MAX_ALLOWED_PATH_LEN} chars`
    );
  }
  if (value.includes(NUL)) {
    throw fail("INVALID_REPOS", `allowed_paths[${index}]: must not contain NUL byte`);
  }
  if (value.startsWith("/")) {
    throw fail(
      "INVALID_REPOS",
      `allowed_paths[${index}]: must be repo-relative; must not start with "/"`
    );
  }
  if (WIN_DRIVE_RE.test(value)) {
    throw fail(
      "INVALID_REPOS",
      `allowed_paths[${index}]: must be repo-relative; Windows-drive paths rejected`
    );
  }
  if (URI_SCHEME_RE.test(value)) {
    throw fail(
      "INVALID_REPOS",
      `allowed_paths[${index}]: must be repo-relative; URI schemes rejected`
    );
  }
  if (value.includes("\\")) {
    throw fail(
      "INVALID_REPOS",
      `allowed_paths[${index}]: must be repo-relative POSIX-style path; backslashes rejected`
    );
  }
  if (value.split("/").some((seg) => seg === "..")) {
    throw fail(
      "INVALID_REPOS",
      `allowed_paths[${index}]: must be repo-relative; must not contain ".." segment`
    );
  }
}

function checkRoot(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    throw fail("INVALID_REPOS", `${where}.root: must be a non-empty string`);
  }
  if (value.length > MAX_ROOT_LEN) {
    throw fail("INVALID_REPOS", `${where}.root: must be ≤ ${MAX_ROOT_LEN} chars`);
  }
  if (value.includes(NUL)) {
    throw fail("INVALID_REPOS", `${where}.root: must not contain NUL byte`);
  }
}

function checkOptionalString(value, max, where, field) {
  if (value == null || value === "") return;
  if (typeof value !== "string") {
    throw fail("INVALID_REPOS", `${where}.${field}: must be a string`);
  }
  if (value.length > max) {
    throw fail("INVALID_REPOS", `${where}.${field}: must be ≤ ${max} chars`);
  }
  if (value.includes(NUL)) {
    throw fail("INVALID_REPOS", `${where}.${field}: must not contain NUL byte`);
  }
}

function normalizeRepoRef(raw, where) {
  if (!isPlainObject(raw)) return null;
  if (isEmptyRepoRef(raw)) return null;
  const root = trimOrEmpty(raw.root);
  const worktree = trimOrEmpty(raw.worktree);
  const branch = trimOrEmpty(raw.branch);
  const allowedRaw = dedupe(splitAllowedPaths(raw.allowed_paths));

  checkRoot(root, where);
  checkOptionalString(worktree, MAX_WORKTREE_LEN, where, "worktree");
  checkOptionalString(branch, MAX_BRANCH_LEN, where, "branch");

  if (allowedRaw.length > MAX_ALLOWED_PATHS) {
    throw fail(
      "INVALID_REPOS",
      `${where}.allowed_paths: must have ≤ ${MAX_ALLOWED_PATHS} entries`
    );
  }
  for (let i = 0; i < allowedRaw.length; i++) {
    checkAllowedPath(allowedRaw[i], i);
  }

  const out = { root };
  if (worktree) out.worktree = worktree;
  if (branch) out.branch = branch;
  if (allowedRaw.length > 0) out.allowed_paths = allowedRaw;
  return out;
}

/**
 * Normalize the repos form state into the canonical task.repos shape.
 *
 * Returns `null` to mean "clear task.repos" when input is null/undefined or an
 * empty object with no primary or secondary entries. Otherwise returns
 * `{ primary, secondary? }`.
 *
 * Throws `Error` with `.code = "INVALID_REPOS"` on constraint violations.
 */
export function normalizeReposInput(input) {
  if (input == null) return null;
  if (!isPlainObject(input)) {
    throw fail("INVALID_REPOS", "repos: must be an object");
  }
  const hasPrimary = isPlainObject(input.primary);
  const secondaryRaw = Array.isArray(input.secondary) ? input.secondary : [];

  if (!hasPrimary && secondaryRaw.length === 0) {
    return null;
  }

  const out = {};

  if (hasPrimary) {
    const primary = normalizeRepoRef(input.primary, "repos.primary");
    if (primary) out.primary = primary;
  }

  if (secondaryRaw.length > MAX_SECONDARY) {
    throw fail(
      "INVALID_REPOS",
      `repos.secondary: must have ≤ ${MAX_SECONDARY} entries`
    );
  }
  const secondary = [];
  for (let i = 0; i < secondaryRaw.length; i++) {
    const ref = normalizeRepoRef(secondaryRaw[i], `repos.secondary[${i}]`);
    if (ref) secondary.push(ref);
  }
  if (secondary.length > 0) out.secondary = secondary;

  // If after dropping empties nothing remained, return null.
  if (!out.primary && !out.secondary) return null;
  return out;
}

// ── Verify items ───────────────────────────────────────────────────────────

function isVerifyRowEmpty(row) {
  if (!isPlainObject(row)) return true;
  const keys = ["id", "cmd", "tool", "skillId", "prompt", "ref", "cwd"];
  for (const k of keys) {
    if (typeof row[k] === "string" && row[k].trim() !== "") return false;
  }
  if (Array.isArray(row.args) && row.args.some((a) => typeof a === "string" && a.trim() !== "")) {
    return false;
  }
  return true;
}

function normalizeCommandItem(row, where) {
  const id = trimOrEmpty(row.id);
  const cmd = typeof row.cmd === "string" ? row.cmd : "";
  if (cmd.length === 0) {
    throw fail("INVALID_VERIFY", `${where}.cmd: must be a non-empty string`);
  }
  if (cmd.length > MAX_CMD_LEN) {
    throw fail("INVALID_VERIFY", `${where}.cmd: must be ≤ ${MAX_CMD_LEN} chars`);
  }
  const item = { kind: "command", id, required: Boolean(row.required), cmd };

  const cwd = trimOrEmpty(row.cwd);
  if (cwd) {
    if (cwd.length > MAX_CWD_LEN) {
      throw fail("INVALID_VERIFY", `${where}.cwd: must be ≤ ${MAX_CWD_LEN} chars`);
    }
    if (cwd.includes(NUL)) {
      throw fail("INVALID_VERIFY", `${where}.cwd: must not contain NUL byte`);
    }
    if (cwd.startsWith("/")) {
      throw fail("INVALID_VERIFY", `${where}.cwd: must be repo-relative; must not start with "/"`);
    }
    if (WIN_DRIVE_RE.test(cwd)) {
      throw fail("INVALID_VERIFY", `${where}.cwd: must be repo-relative; Windows-drive paths rejected`);
    }
    if (URI_SCHEME_RE.test(cwd)) {
      throw fail("INVALID_VERIFY", `${where}.cwd: must be repo-relative; URI schemes rejected`);
    }
    if (cwd.includes("\\")) {
      throw fail("INVALID_VERIFY", `${where}.cwd: must be repo-relative POSIX-style path; backslashes rejected`);
    }
    if (cwd.split("/").some((s) => s === "..")) {
      throw fail("INVALID_VERIFY", `${where}.cwd: must not contain ".." segment`);
    }
    item.cwd = cwd;
  }

  if (row.timeoutSec != null && row.timeoutSec !== "") {
    const t = Number(row.timeoutSec);
    if (!Number.isInteger(t) || t < MIN_TIMEOUT_SEC || t > MAX_TIMEOUT_SEC) {
      throw fail(
        "INVALID_VERIFY",
        `${where}.timeoutSec: must be an integer in [${MIN_TIMEOUT_SEC}, ${MAX_TIMEOUT_SEC}]`
      );
    }
    item.timeoutSec = t;
  }

  if (row.expectExit != null && row.expectExit !== "") {
    const e = Number(row.expectExit);
    if (!Number.isInteger(e)) {
      throw fail("INVALID_VERIFY", `${where}.expectExit: must be an integer`);
    }
    item.expectExit = e;
  } else {
    item.expectExit = 0;
  }

  return item;
}

function normalizeLintItem(row, where) {
  const id = trimOrEmpty(row.id);
  const tool = trimOrEmpty(row.tool);
  if (tool.length === 0) {
    throw fail("INVALID_VERIFY", `${where}.tool: must be a non-empty string`);
  }
  if (!LINT_TOOL_RE.test(tool)) {
    throw fail(
      "INVALID_VERIFY",
      `${where}.tool: must match ${LINT_TOOL_RE.source}`
    );
  }
  const item = { kind: "lint", id, required: Boolean(row.required), tool };

  let args = row.args;
  if (typeof args === "string") {
    args = args.split(/[\n,]/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (Array.isArray(args)) {
    const clean = args.map((a) => (typeof a === "string" ? a : String(a)));
    if (clean.length > MAX_LINT_ARGS) {
      throw fail("INVALID_VERIFY", `${where}.args: must have ≤ ${MAX_LINT_ARGS} entries`);
    }
    if (clean.length > 0) item.args = clean;
  }

  return item;
}

function normalizeSkillRunItem(row, where) {
  const id = trimOrEmpty(row.id);
  const skillId = trimOrEmpty(row.skillId);
  if (skillId.length === 0) {
    throw fail("INVALID_VERIFY", `${where}.skillId: must be a non-empty string`);
  }
  if (!SKILL_ID_RE.test(skillId)) {
    throw fail(
      "INVALID_VERIFY",
      `${where}.skillId: must match ${SKILL_ID_RE.source}`
    );
  }
  return { kind: "skill_run", id, required: Boolean(row.required), skillId };
}

function normalizeHumanApprovalItem(row, where) {
  const id = trimOrEmpty(row.id);
  const prompt = typeof row.prompt === "string" ? row.prompt : "";
  if (prompt.length === 0) {
    throw fail("INVALID_VERIFY", `${where}.prompt: must be a non-empty string`);
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    throw fail("INVALID_VERIFY", `${where}.prompt: must be ≤ ${MAX_PROMPT_LEN} chars`);
  }
  return { kind: "human_approval", id, required: Boolean(row.required), prompt };
}

function normalizeDodCheckItem(row, where) {
  const id = trimOrEmpty(row.id);
  const ref = trimOrEmpty(row.ref);
  if (ref.length === 0) {
    throw fail("INVALID_VERIFY", `${where}.ref: must be a non-empty string`);
  }
  if (ref.length > MAX_DOD_REF_LEN) {
    throw fail("INVALID_VERIFY", `${where}.ref: must be ≤ ${MAX_DOD_REF_LEN} chars`);
  }
  return { kind: "dod_check", id, required: Boolean(row.required), ref };
}

function normalizeOneVerifyItem(row, where) {
  if (!isPlainObject(row)) {
    throw fail("INVALID_VERIFY", `${where}: must be an object`);
  }
  const id = trimOrEmpty(row.id);
  if (!ITEM_ID_RE.test(id)) {
    throw fail(
      "INVALID_VERIFY",
      `${where}.id: must match ${ITEM_ID_RE.source}`
    );
  }
  const kind = row.kind;
  if (!VERIFY_KINDS.includes(kind)) {
    throw fail(
      "INVALID_VERIFY",
      `${where}.kind: must be one of [${VERIFY_KINDS.join(", ")}]`
    );
  }
  switch (kind) {
    case "command":
      return normalizeCommandItem(row, where);
    case "lint":
      return normalizeLintItem(row, where);
    case "skill_run":
      return normalizeSkillRunItem(row, where);
    case "human_approval":
      return normalizeHumanApprovalItem(row, where);
    case "dod_check":
      return normalizeDodCheckItem(row, where);
    default:
      // unreachable thanks to the includes() check above
      throw fail("INVALID_VERIFY", `${where}.kind: unsupported kind`);
  }
}

/**
 * Normalize the verify form state into the canonical task.verify shape.
 *
 * Returns `null` when input is null/undefined/empty array (or every row is
 * empty). Otherwise returns `{ items: VerifyPackItem[] }`.
 *
 * Throws `Error` with `.code = "INVALID_VERIFY"` on constraint violations.
 */
export function normalizeVerifyItems(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) {
    throw fail("INVALID_VERIFY", "verify: must be an array of items");
  }
  const nonEmpty = input.filter((row) => !isVerifyRowEmpty(row));
  if (nonEmpty.length === 0) return null;

  if (nonEmpty.length > MAX_VERIFY_ITEMS) {
    throw fail(
      "INVALID_VERIFY",
      `verify.items: must have ≤ ${MAX_VERIFY_ITEMS} entries`
    );
  }

  const items = [];
  const seenIds = new Set();
  for (let i = 0; i < nonEmpty.length; i++) {
    const item = normalizeOneVerifyItem(nonEmpty[i], `verify.items[${i}]`);
    if (seenIds.has(item.id)) {
      throw fail(
        "INVALID_VERIFY",
        `verify.items[${i}].id: duplicate verify-item id "${item.id}"`
      );
    }
    seenIds.add(item.id);
    items.push(item);
  }
  return { items };
}

/**
 * Thin adapter to hub/validator/task-extensions.js so the editor surfaces the
 * same error messages the tracker patch endpoint emits. Accepts the same
 * shape the validator does — i.e. an object with optional `repos` / `verify`
 * keys.
 */
export function validateTaskExtensions(taskExt) {
  const result = validateExtensionsImpl(taskExt || {});
  if (result.ok) return { ok: true };
  return { ok: false, errors: result.errors };
}

/**
 * Top-level convenience that runs both normalize* functions, then the
 * validator, returning `{ repos, verify }` ready to PATCH onto a task.
 *
 * On normalize failure, the underlying error (with `.code` set) is rethrown.
 * On validator failure, throws `Error` with `.code = "INVALID_TASK_EXT"` and
 * `.errors` set to the validator's error array.
 */
export function serializeTaskExtensions(formState) {
  const state = formState || {};
  const repos = normalizeReposInput(state.repos);
  const verify = normalizeVerifyItems(state.verify);

  const payload = { repos, verify };
  const result = validateTaskExtensions(payload);
  if (!result.ok) {
    const err = fail("INVALID_TASK_EXT", `task extension JSON invalid: ${result.errors.join("; ")}`);
    err.errors = result.errors;
    throw err;
  }
  return payload;
}

/** Initial empty form-state used by the component and the tests. Frozen. */
export const EMPTY_FORM_STATE = Object.freeze({
  repos: null,
  verify: null,
});

// ── Preact component (not unit-tested per repo convention) ─────────────────

function emptyPrimaryRow() {
  return { root: "", worktree: "", branch: "", allowed_paths: "" };
}

function emptySecondaryRow() {
  return { root: "", worktree: "", branch: "", allowed_paths: "" };
}

function emptyVerifyRow(kind = "command") {
  const base = { kind, id: "", required: false };
  if (kind === "command") return { ...base, cmd: "", cwd: "", timeoutSec: "", expectExit: "" };
  if (kind === "lint") return { ...base, tool: "", args: "" };
  if (kind === "skill_run") return { ...base, skillId: "" };
  if (kind === "human_approval") return { ...base, prompt: "" };
  if (kind === "dod_check") return { ...base, ref: "" };
  return base;
}

function reposFromTask(task) {
  const repos = task?.repos;
  if (!isPlainObject(repos)) return null;
  const primary = isPlainObject(repos.primary)
    ? {
        root: repos.primary.root || "",
        worktree: repos.primary.worktree || "",
        branch: repos.primary.branch || "",
        allowed_paths: Array.isArray(repos.primary.allowed_paths)
          ? repos.primary.allowed_paths.join("\n")
          : "",
      }
    : null;
  const secondary = Array.isArray(repos.secondary)
    ? repos.secondary.map((r) => ({
        root: r.root || "",
        worktree: r.worktree || "",
        branch: r.branch || "",
        allowed_paths: Array.isArray(r.allowed_paths) ? r.allowed_paths.join("\n") : "",
      }))
    : [];
  return { primary, secondary };
}

function verifyFromTask(task) {
  const verify = task?.verify;
  if (!isPlainObject(verify) || !Array.isArray(verify.items)) return [];
  return verify.items.map((item) => {
    const base = { kind: item.kind, id: item.id || "", required: Boolean(item.required) };
    if (item.kind === "command") {
      return {
        ...base,
        cmd: item.cmd || "",
        cwd: item.cwd || "",
        timeoutSec: item.timeoutSec != null ? String(item.timeoutSec) : "",
        expectExit: item.expectExit != null ? String(item.expectExit) : "",
      };
    }
    if (item.kind === "lint") {
      return {
        ...base,
        tool: item.tool || "",
        args: Array.isArray(item.args) ? item.args.join("\n") : "",
      };
    }
    if (item.kind === "skill_run") return { ...base, skillId: item.skillId || "" };
    if (item.kind === "human_approval") return { ...base, prompt: item.prompt || "" };
    if (item.kind === "dod_check") return { ...base, ref: item.ref || "" };
    return base;
  });
}

function RepoRow({ row, label, onChange, onRemove }) {
  return html`
    <fieldset style="border:1px solid #444; padding:8px; margin-bottom:8px">
      <legend>${label}</legend>
      <div style="display:flex; flex-direction:column; gap:4px">
        <label>root <input
          value=${row.root}
          onInput=${(e) => onChange({ ...row, root: e.currentTarget.value })}
          style="width:100%"
        /></label>
        <label>worktree <input
          value=${row.worktree}
          onInput=${(e) => onChange({ ...row, worktree: e.currentTarget.value })}
          style="width:100%"
        /></label>
        <label>branch <input
          value=${row.branch}
          onInput=${(e) => onChange({ ...row, branch: e.currentTarget.value })}
          style="width:100%"
        /></label>
        <label>allowed_paths (newline-separated)
          <textarea
            rows="4"
            value=${row.allowed_paths}
            onInput=${(e) => onChange({ ...row, allowed_paths: e.currentTarget.value })}
            style="width:100%"
          ></textarea>
        </label>
        ${onRemove
          ? html`<button type="button" onClick=${onRemove}>Remove</button>`
          : null}
      </div>
    </fieldset>
  `;
}

function VerifyRow({ row, index, onChange, onRemove }) {
  const kindField = (label, key, attrs = {}) => html`
    <label>${label}
      <input
        value=${row[key] ?? ""}
        onInput=${(e) => onChange({ ...row, [key]: e.currentTarget.value })}
        ...${attrs}
      />
    </label>
  `;
  return html`
    <fieldset style="border:1px solid #444; padding:8px; margin-bottom:8px">
      <legend>verify.items[${index}]</legend>
      <div style="display:flex; flex-direction:column; gap:4px">
        <label>kind
          <select
            value=${row.kind}
            onChange=${(e) => onChange(emptyVerifyRow(e.currentTarget.value))}
          >
            ${VERIFY_KINDS.map((k) => html`<option value=${k}>${k}</option>`)}
          </select>
        </label>
        ${kindField("id", "id")}
        <label>required
          <input
            type="checkbox"
            checked=${Boolean(row.required)}
            onChange=${(e) => onChange({ ...row, required: e.currentTarget.checked })}
          />
        </label>
        ${row.kind === "command"
          ? html`
              ${kindField("cmd", "cmd")}
              ${kindField("cwd", "cwd")}
              ${kindField("timeoutSec", "timeoutSec")}
              ${kindField("expectExit", "expectExit")}
            `
          : null}
        ${row.kind === "lint"
          ? html`
              ${kindField("tool", "tool")}
              <label>args (newline-separated)
                <textarea
                  rows="2"
                  value=${row.args || ""}
                  onInput=${(e) => onChange({ ...row, args: e.currentTarget.value })}
                  style="width:100%"
                ></textarea>
              </label>
            `
          : null}
        ${row.kind === "skill_run" ? kindField("skillId", "skillId") : null}
        ${row.kind === "human_approval"
          ? html`<label>prompt
              <textarea
                rows="3"
                value=${row.prompt || ""}
                onInput=${(e) => onChange({ ...row, prompt: e.currentTarget.value })}
                style="width:100%"
              ></textarea>
            </label>`
          : null}
        ${row.kind === "dod_check" ? kindField("ref", "ref") : null}
        <button type="button" onClick=${onRemove}>Remove</button>
      </div>
    </fieldset>
  `;
}

export default function TaskEditor({ task, onSave, onCancel }) {
  const initialRepos = reposFromTask(task) || { primary: emptyPrimaryRow(), secondary: [] };
  const initialVerify = verifyFromTask(task);

  const [reposState, setReposState] = useState(initialRepos);
  const [reposCleared, setReposCleared] = useState(task?.repos === null);
  const [verifyState, setVerifyState] = useState(initialVerify);
  const [verifyCleared, setVerifyCleared] = useState(task?.verify === null);
  const [error, setError] = useState(null);

  function handleSave() {
    try {
      const formState = {
        repos: reposCleared ? null : reposState,
        verify: verifyCleared ? null : verifyState,
      };
      const payload = serializeTaskExtensions(formState);
      setError(null);
      onSave?.(payload);
    } catch (err) {
      setError({ code: err.code || "ERROR", message: err.message, errors: err.errors || null });
    }
  }

  return html`
    <div class="task-editor" style="display:flex; flex-direction:column; gap:12px; padding:8px">
      <section>
        <h3 style="margin:0 0 4px 0">repos</h3>
        <label>
          <input
            type="checkbox"
            checked=${reposCleared}
            onChange=${(e) => setReposCleared(e.currentTarget.checked)}
          /> Clear repos (save as null)
        </label>
        ${reposCleared
          ? html`<div style="font-style:italic">task.repos will be cleared on save.</div>`
          : html`
              <${RepoRow}
                label="primary"
                row=${reposState.primary || emptyPrimaryRow()}
                onChange=${(next) => setReposState({ ...reposState, primary: next })}
              />
              ${(reposState.secondary || []).map(
                (row, i) => html`
                  <${RepoRow}
                    key=${i}
                    label=${`secondary[${i}]`}
                    row=${row}
                    onChange=${(next) => {
                      const sec = [...reposState.secondary];
                      sec[i] = next;
                      setReposState({ ...reposState, secondary: sec });
                    }}
                    onRemove=${() => {
                      const sec = [...reposState.secondary];
                      sec.splice(i, 1);
                      setReposState({ ...reposState, secondary: sec });
                    }}
                  />
                `
              )}
              ${(reposState.secondary || []).length < MAX_SECONDARY
                ? html`<button
                    type="button"
                    onClick=${() =>
                      setReposState({
                        ...reposState,
                        secondary: [...(reposState.secondary || []), emptySecondaryRow()],
                      })}
                  >Add secondary repo</button>`
                : null}
            `}
      </section>

      <section>
        <h3 style="margin:0 0 4px 0">verify</h3>
        <label>
          <input
            type="checkbox"
            checked=${verifyCleared}
            onChange=${(e) => setVerifyCleared(e.currentTarget.checked)}
          /> Clear verify (save as null)
        </label>
        ${verifyCleared
          ? html`<div style="font-style:italic">task.verify will be cleared on save.</div>`
          : html`
              ${verifyState.map(
                (row, i) => html`
                  <${VerifyRow}
                    key=${i}
                    index=${i}
                    row=${row}
                    onChange=${(next) => {
                      const items = [...verifyState];
                      items[i] = next;
                      setVerifyState(items);
                    }}
                    onRemove=${() => {
                      const items = [...verifyState];
                      items.splice(i, 1);
                      setVerifyState(items);
                    }}
                  />
                `
              )}
              ${verifyState.length < MAX_VERIFY_ITEMS
                ? html`<button
                    type="button"
                    onClick=${() => setVerifyState([...verifyState, emptyVerifyRow("command")])}
                  >Add verify item</button>`
                : null}
            `}
      </section>

      ${error
        ? html`<div style="color:#f66; white-space:pre-wrap">
            <strong>${error.code}:</strong> ${error.message}
            ${error.errors
              ? html`<ul>${error.errors.map((e, i) => html`<li key=${i}>${e}</li>`)}</ul>`
              : null}
          </div>`
        : null}

      <div style="display:flex; gap:8px">
        <button type="button" onClick=${handleSave}>Save</button>
        <button type="button" onClick=${() => onCancel?.()}>Cancel</button>
      </div>
    </div>
  `;
}
