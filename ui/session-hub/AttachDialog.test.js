import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AttachDialogView,
  attachContractText,
  buildAttachSessionRequest,
  inferAttachPathsFromProjectFile,
  validateAttachDraft,
} from "./AttachDialog.js";

function flattenRenderedNodes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => flattenRenderedNodes(item, acc));
    return acc;
  }
  if (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number"
  ) {
    return acc;
  }
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

test("inferAttachPathsFromProjectFile derives repo-local cwd/repo/worktree defaults", () => {
  assert.deepEqual(
    inferAttachPathsFromProjectFile("/repo/.llm-tracker/trackers/llm-tracker.json"),
    { cwd: "/repo", repoRoot: "/repo", worktreePath: "/repo" },
  );
  assert.deepEqual(inferAttachPathsFromProjectFile("/workspace/trackers/demo.json"), {
    cwd: "/workspace/trackers",
    repoRoot: "",
    worktreePath: "",
  });
});

test("buildAttachSessionRequest keeps cwd required and omits unknown repo root", () => {
  assert.deepEqual(
    buildAttachSessionRequest({
      projectSlug: "demo",
      taskId: "t1",
      agent: "codex",
      cwd: "/repo",
      repoRoot: "",
      worktreePath: "/repo-wt",
    }),
    {
      name: "codex:demo/t1",
      tier: "manual",
      projectSlug: "demo",
      taskId: "t1",
      agent: "codex",
      cwd: "/repo",
      worktreePath: "/repo-wt",
    },
  );
  assert.equal(validateAttachDraft({ projectSlug: "demo", taskId: "t1", agent: "codex", cwd: "/repo" }), null);
});

test("AttachDialogView exposes readonly cwd and editable repoRoot/worktreePath", () => {
  const vnode = AttachDialogView({
    draft: {
      projectSlug: "demo",
      taskId: "t1",
      agent: "codex",
      cwd: "/repo",
      repoRoot: "",
      worktreePath: "/repo-wt",
    },
  });
  const inputs = flattenRenderedNodes(vnode).filter((node) => node.type === "input");
  const cwd = inputs.find((input) => input.props.value === "/repo");
  const repo = inputs.find((input) => input.props.placeholder === "repo unknown");
  const worktree = inputs.find((input) => input.props.value === "/repo-wt");
  assert.equal(cwd.props.readOnly, true);
  assert.equal(repo.props.readOnly, undefined);
  assert.equal(worktree.props.readOnly, undefined);
  assert.match(collectVNodeText(vnode), /repo unknown/);
});

test("attachContractText includes session token env contract", () => {
  const text = attachContractText({
    session: { id: "ses_abc", activeJobId: "job_abc" },
    token: "secret-token",
    workspacePath: "/workspace",
  });
  assert.match(text, /LT_SESSION_ID='ses_abc'/);
  assert.match(text, /LT_JOB_ID='job_abc'/);
  assert.match(text, /LT_SESSION_TOKEN='secret-token'/);
  assert.match(text, /LT_MCP_URL='stdio:\/\/llm-tracker-mcp'/);
  assert.match(text, /LT_MCP_COMMAND='llm-tracker mcp --path '\\''\/workspace'\\'''/);
});
