import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReposInput,
  normalizeVerifyItems,
  validateTaskExtensions,
  serializeTaskExtensions,
  EMPTY_FORM_STATE,
} from "../ui/board/TaskEditor.js";

const NUL = "\u0000";

function assertThrowsCode(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected fn to throw");
  assert.equal(caught.code, code, `expected code=${code}, got ${caught.code} (${caught.message})`);
}

test("normalizeReposInput(null) and {} return null", () => {
  assert.equal(normalizeReposInput(null), null);
  assert.equal(normalizeReposInput(undefined), null);
  assert.equal(normalizeReposInput({}), null);
  assert.equal(normalizeReposInput({ primary: null, secondary: [] }), null);
  assert.equal(
    normalizeReposInput({
      primary: { root: " ", worktree: "", branch: "", allowed_paths: "" },
      secondary: [],
    }),
    null
  );
});

test("serializeTaskExtensions allows verify-only save with untouched blank repos row", () => {
  const payload = serializeTaskExtensions({
    repos: {
      primary: { root: "", worktree: "", branch: "", allowed_paths: "" },
      secondary: [],
    },
    verify: [{ kind: "command", id: "build", cmd: "npm test" }],
  });
  assert.deepEqual(payload, {
    repos: null,
    verify: {
      items: [
        { kind: "command", id: "build", required: false, cmd: "npm test", expectExit: 0 },
      ],
    },
  });
});

test("normalizeReposInput primary happy path with newline-separated allowed_paths (trim/split/dedupe)", () => {
  const out = normalizeReposInput({
    primary: { root: "  src  ", allowed_paths: "a.js\nb.js\n a.js \n" },
  });
  assert.deepEqual(out, {
    primary: { root: "src", allowed_paths: ["a.js", "b.js"] },
  });
});

test("normalizeReposInput parses comma-separated allowed_paths", () => {
  const out = normalizeReposInput({
    primary: { root: "src", allowed_paths: "a.js, b.js , c.js" },
  });
  assert.deepEqual(out, {
    primary: { root: "src", allowed_paths: ["a.js", "b.js", "c.js"] },
  });
});

test("normalizeReposInput round-trips secondary repos up to 16 entries", () => {
  const secondary = Array.from({ length: 16 }, (_, i) => ({
    root: `repo-${i}`,
    branch: i === 0 ? "main" : "",
  }));
  const out = normalizeReposInput({
    primary: { root: "primary" },
    secondary,
  });
  assert.equal(out.secondary.length, 16);
  assert.equal(out.secondary[0].root, "repo-0");
  assert.equal(out.secondary[0].branch, "main");
  assert.equal(out.secondary[15].root, "repo-15");
  assert.equal(out.secondary[15].branch, undefined);
});

test("normalizeReposInput throws INVALID_REPOS when >16 secondary repos", () => {
  const secondary = Array.from({ length: 17 }, (_, i) => ({ root: `r-${i}` }));
  assertThrowsCode(
    () => normalizeReposInput({ primary: { root: "p" }, secondary }),
    "INVALID_REPOS"
  );
});

test("normalizeReposInput throws when allowed_paths >256 entries", () => {
  const paths = Array.from({ length: 257 }, (_, i) => `p${i}.js`).join("\n");
  assertThrowsCode(
    () => normalizeReposInput({ primary: { root: "src", allowed_paths: paths } }),
    "INVALID_REPOS"
  );
});

test("normalizeReposInput rejects '..', absolute, and NUL allowed_paths entries", () => {
  assertThrowsCode(
    () => normalizeReposInput({ primary: { root: "src", allowed_paths: "../outside/x" } }),
    "INVALID_REPOS"
  );
  assertThrowsCode(
    () => normalizeReposInput({ primary: { root: "src", allowed_paths: "/etc/passwd" } }),
    "INVALID_REPOS"
  );
  assertThrowsCode(
    () => normalizeReposInput({ primary: { root: "src", allowed_paths: `bad${NUL}path` } }),
    "INVALID_REPOS"
  );
  assertThrowsCode(
    () => normalizeReposInput({ primary: { root: "src", allowed_paths: "file:///tmp/secret" } }),
    "INVALID_REPOS"
  );
});

test("normalizeReposInput ignores fully empty repo row but rejects partial row without root", () => {
  assert.equal(normalizeReposInput({ primary: { root: "   " } }), null);
  assertThrowsCode(
    () => normalizeReposInput({ primary: { root: "", allowed_paths: "a.js" } }),
    "INVALID_REPOS"
  );
});

test("normalizeVerifyItems(null) and [] return null (also array of empty rows)", () => {
  assert.equal(normalizeVerifyItems(null), null);
  assert.equal(normalizeVerifyItems(undefined), null);
  assert.equal(normalizeVerifyItems([]), null);
  assert.equal(normalizeVerifyItems([{ kind: "command", id: "", cmd: "" }]), null);
});

test("normalizeVerifyItems happy path: single command item", () => {
  const out = normalizeVerifyItems([
    { kind: "command", id: "build", cmd: "make build" },
  ]);
  assert.deepEqual(out, {
    items: [
      { kind: "command", id: "build", required: false, cmd: "make build", expectExit: 0 },
    ],
  });
});

test("normalizeVerifyItems round-trips one of each kind deterministically", () => {
  const rows = [
    { kind: "command", id: "cmd1", required: true, cmd: "echo hi", timeoutSec: "30" },
    { kind: "lint", id: "lint1", required: false, tool: "eslint", args: "--fix\nsrc/" },
    { kind: "skill_run", id: "skill1", required: true, skillId: "code-implementer" },
    { kind: "human_approval", id: "hum1", required: true, prompt: "Approve please" },
    { kind: "dod_check", id: "dod1", required: false, ref: "definition_of_done[0]" },
  ];
  const out = normalizeVerifyItems(rows);
  assert.deepEqual(out, {
    items: [
      { kind: "command", id: "cmd1", required: true, cmd: "echo hi", timeoutSec: 30, expectExit: 0 },
      { kind: "lint", id: "lint1", required: false, tool: "eslint", args: ["--fix", "src/"] },
      { kind: "skill_run", id: "skill1", required: true, skillId: "code-implementer" },
      { kind: "human_approval", id: "hum1", required: true, prompt: "Approve please" },
      { kind: "dod_check", id: "dod1", required: false, ref: "definition_of_done[0]" },
    ],
  });
});

test("normalizeVerifyItems throws on duplicate item id", () => {
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "command", id: "dup", cmd: "a" },
        { kind: "command", id: "dup", cmd: "b" },
      ]),
    "INVALID_VERIFY"
  );
});

test("normalizeVerifyItems throws on bad id pattern", () => {
  assertThrowsCode(
    () => normalizeVerifyItems([{ kind: "command", id: "Bad-ID", cmd: "x" }]),
    "INVALID_VERIFY"
  );
  assertThrowsCode(
    () => normalizeVerifyItems([{ kind: "command", id: "-leadingdash", cmd: "x" }]),
    "INVALID_VERIFY"
  );
});

test("normalizeVerifyItems throws when >128 items", () => {
  const rows = Array.from({ length: 129 }, (_, i) => ({
    kind: "command",
    id: `cmd-${i}`,
    cmd: `c${i}`,
  }));
  assertThrowsCode(() => normalizeVerifyItems(rows), "INVALID_VERIFY");
});

test("normalizeVerifyItems enforces per-kind constraints", () => {
  // command.cmd >4096 chars
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "command", id: "big", cmd: "x".repeat(4097) },
      ]),
    "INVALID_VERIFY"
  );
  // command.timeoutSec 0
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "command", id: "ok", cmd: "x", timeoutSec: 0 },
      ]),
    "INVALID_VERIFY"
  );
  // command.cwd URI scheme
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "command", id: "cwd", cmd: "x", cwd: "file:///tmp" },
      ]),
    "INVALID_VERIFY"
  );
  // command.cwd Windows drive
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "command", id: "win", cmd: "x", cwd: "C:/repo" },
      ]),
    "INVALID_VERIFY"
  );
  // command.cwd backslash
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "command", id: "slash", cmd: "x", cwd: "src\\tests" },
      ]),
    "INVALID_VERIFY"
  );
  // lint.tool with spaces
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "lint", id: "lt", tool: "bad tool" },
      ]),
    "INVALID_VERIFY"
  );
  // skill_run.skillId uppercase
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "skill_run", id: "sr", skillId: "BadSkill" },
      ]),
    "INVALID_VERIFY"
  );
  // human_approval.prompt >2000 chars
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "human_approval", id: "ha", prompt: "x".repeat(2001) },
      ]),
    "INVALID_VERIFY"
  );
  // dod_check.ref >256 chars
  assertThrowsCode(
    () =>
      normalizeVerifyItems([
        { kind: "dod_check", id: "dc", ref: "r".repeat(257) },
      ]),
    "INVALID_VERIFY"
  );
});

test("validateTaskExtensions returns ok=true for valid input and ok=false for invalid", () => {
  const goodRepos = normalizeReposInput({ primary: { root: "src", allowed_paths: "a.js\nb.js" } });
  const goodVerify = normalizeVerifyItems([{ kind: "command", id: "build", cmd: "make" }]);
  const okResult = validateTaskExtensions({ repos: goodRepos, verify: goodVerify });
  assert.equal(okResult.ok, true);

  // Hand-craft a bad payload (bypassing the normalizer): duplicate verify-item ids.
  const badPayload = {
    verify: {
      items: [
        { kind: "command", id: "dup", required: false, cmd: "a", expectExit: 0 },
        { kind: "command", id: "dup", required: false, cmd: "b", expectExit: 0 },
      ],
    },
  };
  const badResult = validateTaskExtensions(badPayload);
  assert.equal(badResult.ok, false);
  assert.ok(Array.isArray(badResult.errors));
  assert.ok(badResult.errors.length > 0);
  assert.ok(
    badResult.errors.some((e) => e.includes("duplicate verify-item id")),
    `expected errors to mention duplicate id, got ${JSON.stringify(badResult.errors)}`
  );
});

test("serializeTaskExtensions round-trips minimal, rich, and bubbles errors", () => {
  // Minimal form state → repos null, verify null.
  const minimal = serializeTaskExtensions({ repos: null, verify: null });
  assert.deepEqual(minimal, { repos: null, verify: null });
  const emptyArrays = serializeTaskExtensions({ repos: {}, verify: [] });
  assert.deepEqual(emptyArrays, { repos: null, verify: null });

  // Rich form state.
  const rich = serializeTaskExtensions({
    repos: {
      primary: { root: "src", allowed_paths: "a.js\nb.js" },
      secondary: [{ root: "vendor", branch: "main" }],
    },
    verify: [
      { kind: "command", id: "build", required: true, cmd: "make build", timeoutSec: 60 },
      { kind: "lint", id: "eslint", required: false, tool: "eslint", args: "src/" },
    ],
  });
  assert.deepEqual(rich, {
    repos: {
      primary: { root: "src", allowed_paths: ["a.js", "b.js"] },
      secondary: [{ root: "vendor", branch: "main" }],
    },
    verify: {
      items: [
        { kind: "command", id: "build", required: true, cmd: "make build", timeoutSec: 60, expectExit: 0 },
        { kind: "lint", id: "eslint", required: false, tool: "eslint", args: ["src/"] },
      ],
    },
  });

  // Invalid state bubbles error code.
  assertThrowsCode(
    () =>
      serializeTaskExtensions({
        repos: { primary: { root: "src", allowed_paths: "/abs/path" } },
        verify: null,
      }),
    "INVALID_REPOS"
  );
});

test("EMPTY_FORM_STATE is a frozen object with null repos/verify", () => {
  assert.equal(EMPTY_FORM_STATE.repos, null);
  assert.equal(EMPTY_FORM_STATE.verify, null);
  assert.ok(Object.isFrozen(EMPTY_FORM_STATE), "EMPTY_FORM_STATE should be frozen");
});
