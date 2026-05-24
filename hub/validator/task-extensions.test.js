import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateTaskExtensions,
  validateAllTaskExtensions
} from "./task-extensions.js";

function ok(res, msg) {
  assert.equal(res.ok, true, msg + (res.errors.length ? " — errors: " + res.errors.join("; ") : ""));
  assert.deepEqual(res.errors, []);
}

function bad(res, needle) {
  assert.equal(res.ok, false, "expected failure");
  assert.ok(
    res.errors.some((e) => e.includes(needle)),
    `expected an error containing "${needle}", got: ${res.errors.join("; ")}`
  );
}

test("missing repos and verify is valid (additive)", () => {
  ok(validateTaskExtensions({}));
  ok(validateTaskExtensions({ id: "t1", title: "x" }));
});

test("null/non-object task is valid (no-op)", () => {
  ok(validateTaskExtensions(null));
  ok(validateTaskExtensions(undefined));
  ok(validateTaskExtensions("not-an-object"));
});

test("valid task.repos with primary + secondary + allowed_paths", () => {
  ok(
    validateTaskExtensions({
      repos: {
        primary: {
          root: "/abs/path/to/repo",
          worktree: "worktrees/foo",
          branch: "feature/x",
          allowed_paths: ["src/**", "test/**"]
        },
        secondary: [{ root: "../sibling-repo" }]
      }
    })
  );
});

test("repos.secondary exceeds 16 entries fails", () => {
  const refs = Array.from({ length: 17 }, () => ({ root: "x" }));
  bad(validateTaskExtensions({ repos: { secondary: refs } }), "≤ 16");
});

test("TaskRepoRef missing root fails", () => {
  bad(validateTaskExtensions({ repos: { primary: { branch: "main" } } }), "root");
});

test("root over 1024 chars fails", () => {
  const long = "x".repeat(1025);
  bad(validateTaskExtensions({ repos: { primary: { root: long } } }), "1024");
});

test("branch over 256 chars fails", () => {
  const long = "x".repeat(257);
  bad(
    validateTaskExtensions({ repos: { primary: { root: "r", branch: long } } }),
    "256"
  );
});

test("root with NUL byte fails", () => {
  bad(
    validateTaskExtensions({ repos: { primary: { root: "abc\u0000def" } } }),
    "NUL"
  );
});

test("allowed_paths over 256 entries fails", () => {
  const paths = Array.from({ length: 257 }, (_, i) => `p${i}`);
  bad(
    validateTaskExtensions({ repos: { primary: { root: "r", allowed_paths: paths } } }),
    "256"
  );
});

test("allowed_paths entry > 512 chars fails", () => {
  bad(
    validateTaskExtensions({
      repos: { primary: { root: "r", allowed_paths: ["a".repeat(513)] } }
    }),
    "512"
  );
});

test("allowed_paths leading / rejected", () => {
  bad(
    validateTaskExtensions({
      repos: { primary: { root: "r", allowed_paths: ["/abs/file.js"] } }
    }),
    'must not start with "/"'
  );
});

test("allowed_paths Windows drive rejected", () => {
  bad(
    validateTaskExtensions({
      repos: { primary: { root: "r", allowed_paths: ["C:/Users/x"] } }
    }),
    "Windows-drive"
  );
});

test("allowed_paths .. segment rejected", () => {
  bad(
    validateTaskExtensions({
      repos: { primary: { root: "r", allowed_paths: ["src/../etc/passwd"] } }
    }),
    '".." segment'
  );
});

test("allowed_paths NUL byte rejected", () => {
  bad(
    validateTaskExtensions({
      repos: { primary: { root: "r", allowed_paths: ["a\u0000b"] } }
    }),
    "NUL"
  );
});

test("unknown property in TaskRepoRef rejected", () => {
  bad(
    validateTaskExtensions({ repos: { primary: { root: "r", whatever: 1 } } }),
    "whatever"
  );
});

test("valid task.verify with mixed item kinds", () => {
  ok(
    validateTaskExtensions({
      verify: {
        items: [
          { kind: "command", id: "lt.test", required: true, cmd: "npm test", timeoutSec: 600 },
          { kind: "lint", id: "lt.lint", required: false, tool: "eslint", args: ["--max-warnings", "0"] },
          { kind: "skill_run", id: "lt.closeout", required: true, skillId: "tracker-closeout-sweep" },
          { kind: "human_approval", id: "lt.approve", required: true, prompt: "OK to ship?" },
          { kind: "dod_check", id: "lt.dod", required: true, ref: "DoD#3" }
        ],
        notes: "merge gate"
      }
    })
  );
});

test("verify.items over 128 items fails", () => {
  const items = Array.from({ length: 129 }, (_, i) => ({
    kind: "command",
    id: `c${i}`,
    required: true,
    cmd: "true"
  }));
  bad(validateTaskExtensions({ verify: { items } }), "128");
});

test("verify item missing id fails", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "command", required: true, cmd: "true" }] }
    }),
    "id"
  );
});

test("verify item with bad id pattern fails", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "command", id: "BadID", required: true, cmd: "true" }] }
    }),
    "pattern"
  );
});

test("verify item id length > 64 fails", () => {
  const id = "a".repeat(65);
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "command", id, required: true, cmd: "true" }] }
    }),
    "pattern"
  );
});

test("verify item duplicate ids rejected", () => {
  bad(
    validateTaskExtensions({
      verify: {
        items: [
          { kind: "command", id: "dup", required: true, cmd: "a" },
          { kind: "lint", id: "dup", required: false, tool: "eslint" }
        ]
      }
    }),
    'duplicate verify-item id "dup"'
  );
});

test("verify command.cmd over 4096 fails", () => {
  const cmd = "x".repeat(4097);
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "command", id: "c1", required: true, cmd }] }
    }),
    "4096"
  );
});

test("verify command.timeoutSec out of range fails", () => {
  bad(
    validateTaskExtensions({
      verify: {
        items: [{ kind: "command", id: "c1", required: true, cmd: "x", timeoutSec: 0 }]
      }
    }),
    "/timeoutSec"
  );
  bad(
    validateTaskExtensions({
      verify: {
        items: [{ kind: "command", id: "c2", required: true, cmd: "x", timeoutSec: 3601 }]
      }
    }),
    "/timeoutSec"
  );
});

test("verify command.cwd absolute path rejected", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "command", id: "c1", required: true, cmd: "x", cwd: "/abs" }] }
    }),
    'must not start with "/"'
  );
});

test("verify command.cwd .. rejected", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "command", id: "c1", required: true, cmd: "x", cwd: "../outside" }] }
    }),
    '".." segment'
  );
});

test("verify lint.tool pattern enforced", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "lint", id: "l1", required: true, tool: "bad tool!" }] }
    }),
    "pattern"
  );
});

test("verify lint.args over 128 entries fails", () => {
  const args = Array.from({ length: 129 }, (_, i) => `a${i}`);
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "lint", id: "l1", required: true, tool: "eslint", args }] }
    }),
    "128"
  );
});

test("verify skill_run.skillId pattern enforced", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "skill_run", id: "s1", required: true, skillId: "BadSkill" }] }
    }),
    "pattern"
  );
});

test("verify human_approval.prompt over 2000 fails", () => {
  const prompt = "x".repeat(2001);
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "human_approval", id: "h1", required: true, prompt }] }
    }),
    "2000"
  );
});

test("verify dod_check.ref over 256 fails", () => {
  const ref = "x".repeat(257);
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "dod_check", id: "d1", required: true, ref }] }
    }),
    "256"
  );
});

test("verify item with unknown kind rejected", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "magic", id: "m1", required: true }] }
    }),
    "/items/0"
  );
});

test("verify item missing required boolean fails", () => {
  bad(
    validateTaskExtensions({
      verify: { items: [{ kind: "command", id: "c1", cmd: "x" }] }
    }),
    "required"
  );
});

test("validateAllTaskExtensions aggregates per-task errors with /tasks/N prefix", () => {
  const res = validateAllTaskExtensions([
    { id: "ok-1" },
    { id: "bad-1", verify: { items: [{ kind: "command", id: "Bad", required: true, cmd: "x" }] } }
  ]);
  assert.equal(res.ok, false);
  assert.ok(res.errors.every((e) => e.startsWith("/tasks/")));
  assert.ok(res.errors.some((e) => e.startsWith("/tasks/1/")));
});

test("validateAllTaskExtensions returns ok on empty/missing tasks array", () => {
  ok(validateAllTaskExtensions([]));
  ok(validateAllTaskExtensions(undefined));
  ok(validateAllTaskExtensions(null));
});
