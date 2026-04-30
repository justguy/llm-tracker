import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProject } from "../hub/validator.js";
import { buildBriefPayload } from "../hub/briefs.js";
import { buildExecutePayload } from "../hub/execute.js";
import { buildHandoffPayload } from "../hub/handoff.js";
import { buildVerifyPayload } from "../hub/verify.js";
import { taskRepos, taskRequiresApproval } from "../hub/task-metadata.js";
import { buildProjectTaskContext, summarizeTask } from "../hub/task-metadata.js";
import { validProject } from "./fixtures.js";

function withRepos(project, taskIndex, repos) {
  project.tasks[taskIndex].repos = repos;
  return project;
}

test("validator accepts a well-formed task.repos block", () => {
  const project = withRepos(validProject(), 0, {
    primary: "core",
    secondary: ["docs"],
    allowed_paths: { core: ["src/"], docs: ["docs/"] },
    approval_required_for: ["docs"]
  });
  const { ok, errors } = validateProject(project);
  assert.equal(ok, true, errors.join("; "));
});

test("validator rejects allowed_paths keys that are not declared repos", () => {
  const project = withRepos(validProject(), 0, {
    primary: "core",
    allowed_paths: { other: ["src/"] }
  });
  const { ok, errors } = validateProject(project);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("repos/allowed_paths") && e.includes("other")));
});

test("validator rejects approval_required_for entries that are not declared repos", () => {
  const project = withRepos(validProject(), 0, {
    primary: "core",
    secondary: ["docs"],
    approval_required_for: ["frontend"]
  });
  const { ok, errors } = validateProject(project);
  assert.equal(ok, false);
  assert.ok(
    errors.some((e) => e.includes("repos/approval_required_for") && e.includes("frontend"))
  );
});

test("validator rejects secondary repo equal to the primary repo", () => {
  const project = withRepos(validProject(), 0, {
    primary: "core",
    secondary: ["core"]
  });
  const { ok, errors } = validateProject(project);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("repos/secondary") && e.includes("core")));
});

test("validator rejects secondary repos that duplicate primary after trimming", () => {
  const project = withRepos(validProject(), 0, {
    primary: "core",
    secondary: [" core "]
  });
  const { ok, errors } = validateProject(project);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("repos/secondary") && e.includes("core")));
});

test("taskRepos and taskRequiresApproval surface repo data and prefixed approvals", () => {
  const task = {
    id: "t1",
    title: "x",
    status: "not_started",
    placement: { swimlaneId: "exec", priorityId: "p0" },
    approval_required_for: ["security review"],
    repos: {
      primary: "core",
      secondary: ["docs"],
      allowed_paths: { core: ["src/"] },
      approval_required_for: ["docs"]
    }
  };
  const repos = taskRepos(task);
  assert.equal(repos.primary, "core");
  assert.deepEqual(repos.secondary, ["docs"]);
  assert.deepEqual(repos.allowed_paths, { core: ["src/"] });
  assert.deepEqual(repos.approval_required_for, ["docs"]);

  assert.deepEqual(taskRequiresApproval(task), ["security review", "repo:docs"]);
});

test("summarizeTask makes cross-repo edits decision_gated", () => {
  const project = withRepos(validProject(), 0, {
    primary: "core",
    secondary: ["docs"],
    approval_required_for: ["docs"]
  });
  const context = buildProjectTaskContext({ data: project });
  const summary = summarizeTask(project.tasks[0], context);
  assert.equal(summary.actionability, "decision_gated");
  assert.deepEqual(summary.decision_required, ["repo:docs"]);
  assert.equal(summary.repos.primary, "core");
});

test("brief, execute, and handoff packs surface task.repos", () => {
  const project = withRepos(validProject(), 0, {
    primary: "core",
    secondary: ["docs"],
    allowed_paths: { core: ["src/"], docs: ["docs/"] },
    approval_required_for: ["docs"]
  });
  project.meta.rev = 4;

  const brief = buildBriefPayload({ slug: "test-project", data: project, taskId: "t1" });
  assert.equal(brief.task.repos.primary, "core");
  assert.deepEqual(brief.task.repos.secondary, ["docs"]);

  const execute = buildExecutePayload({ slug: "test-project", data: project, taskId: "t1" });
  assert.equal(execute.executionContract.repos.primary, "core");
  const planKinds = execute.executionPlan.map((step) => step.kind);
  assert.ok(planKinds.includes("primary_repo"));
  assert.ok(planKinds.includes("secondary_repos"));
  assert.ok(planKinds.includes("repo_allowed_paths"));
  assert.ok(planKinds.includes("repo_approval"));
  assert.equal(planKinds.filter((kind) => kind === "approval").length, 0);

  const handoff = buildHandoffPayload({ slug: "test-project", data: project, taskId: "t1" });
  assert.equal(handoff.executionContract.repos.primary, "core");
  assert.match(handoff.handoffPrompt, /## Cross-repo scope/);
  assert.match(handoff.handoffPrompt, /primary: core/);
  assert.match(handoff.handoffPrompt, /secondary: docs/);
  assert.match(handoff.handoffPrompt, /approval required before editing: docs/);

  const verify = buildVerifyPayload({ slug: "test-project", data: project, taskId: "t1" });
  assert.equal(verify.verificationContract.repos.primary, "core");
  const checkKinds = verify.checks.map((check) => check.kind);
  assert.ok(checkKinds.includes("repo_allowed_path"));
  assert.ok(checkKinds.includes("repo_approval"));
});

test("taskRepos returns null when no repo metadata is present", () => {
  const project = validProject();
  assert.equal(taskRepos(project.tasks[0]), null);
});
