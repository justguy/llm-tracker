import { buildBriefPayload, getBriefPayload } from "./briefs.js";

function verificationContract(task) {
  return {
    definition_of_done: task.definition_of_done || [],
    constraints: task.constraints || [],
    expected_changes: task.expected_changes || [],
    allowed_paths: task.allowed_paths || [],
    repos: task.repos || null
  };
}

function dependencyEvidence(dependencies = []) {
  return dependencies.map((dependency) => ({
    id: dependency.id,
    title: dependency.title,
    status: dependency.status,
    ready: dependency.ready,
    selectedBecause: "dependency state"
  }));
}

function buildChecks(task, dependencies = []) {
  const checks = [];

  for (const item of task.definition_of_done || []) {
    checks.push({
      kind: "definition_of_done",
      text: item,
      status: task.status === "complete" ? "ready_to_review" : "pending_completion",
      evidenceFrom: ["taskState", "recentHistory"]
    });
  }

  for (const expectedChange of task.expected_changes || []) {
    checks.push({
      kind: "expected_change",
      text: expectedChange,
      status: "needs_manual_confirmation",
      evidenceFrom: ["taskContract"]
    });
  }

  for (const allowedPath of task.allowed_paths || []) {
    checks.push({
      kind: "allowed_path",
      text: allowedPath,
      status: "constraint",
      evidenceFrom: ["taskContract"]
    });
  }

  for (const [repo, paths] of Object.entries(task.repos?.allowed_paths || {})) {
    for (const allowedPath of paths || []) {
      checks.push({
        kind: "repo_allowed_path",
        text: `${repo}: ${allowedPath}`,
        status: "constraint",
        evidenceFrom: ["taskContract"]
      });
    }
  }

  for (const repo of task.repos?.approval_required_for || []) {
    checks.push({
      kind: "repo_approval",
      text: `Approval required before editing ${repo}`,
      status: task.decision_required?.includes(`repo:${repo}`) ? "open" : "needs_manual_confirmation",
      evidenceFrom: ["taskContract", "taskState"]
    });
  }

  for (const dependency of dependencies) {
    checks.push({
      kind: "dependency_state",
      text: `${dependency.id} is ${dependency.status}`,
      status: dependency.status === "complete" ? "satisfied" : "open",
      evidenceFrom: ["dependencyState"]
    });
  }

  if (checks.length === 0) {
    checks.push({
      kind: "task_status",
      text: "Task status should reflect the real outcome before sign-off",
      status: task.status === "complete" ? "ready_to_review" : "pending_completion",
      evidenceFrom: ["taskState"]
    });
  }

  return checks;
}

export function buildVerifyPayload({
  slug,
  data,
  history = [],
  externalLookup = null,
  taskId,
  references = null,
  snippets = [],
  now = new Date().toISOString()
}) {
  const brief = buildBriefPayload({
    slug,
    data,
    history,
    externalLookup,
    taskId,
    references,
    snippets,
    now
  });
  if (!brief) return null;

  const dependencyState = dependencyEvidence(brief.dependencies);

  return {
    ...brief,
    packType: "verify",
    verificationContract: verificationContract(brief.task),
    evidenceSources: {
      taskState: {
        id: brief.task.id,
        status: brief.task.status,
        actionability: brief.task.actionability,
        actionable: brief.task.actionable,
        blocked_by: brief.task.blocked_by,
        decision_required: brief.task.decision_required,
        decision_reason: brief.task.decision_reason,
        assignee: brief.task.assignee,
        lastTouchedRev: brief.task.lastTouchedRev,
        selectedBecause: "current task state"
      },
      dependencyState,
      references: brief.references,
      traceability: brief.task.traceability || {},
      snippets: brief.snippets,
      recentHistory: brief.recentHistory
    },
    checks: buildChecks(brief.task, dependencyState)
  };
}

export function getVerifyPayload({ workspace, slug, entry, externalLookup, taskId, now }) {
  const result = getBriefPayload({ workspace, slug, entry, externalLookup, taskId, now });
  if (!result.ok) return result;

  const dependencyState = dependencyEvidence(result.payload.dependencies);

  return {
    ok: true,
    payload: {
      ...result.payload,
      packType: "verify",
      verificationContract: verificationContract(result.payload.task),
      evidenceSources: {
        taskState: {
          id: result.payload.task.id,
          status: result.payload.task.status,
          actionability: result.payload.task.actionability,
          actionable: result.payload.task.actionable,
          blocked_by: result.payload.task.blocked_by,
          decision_required: result.payload.task.decision_required,
          decision_reason: result.payload.task.decision_reason,
          assignee: result.payload.task.assignee,
          lastTouchedRev: result.payload.task.lastTouchedRev,
          selectedBecause: "current task state"
        },
        dependencyState,
        references: result.payload.references,
        traceability: result.payload.task.traceability || {},
        snippets: result.payload.snippets,
        recentHistory: result.payload.recentHistory
      },
      checks: buildChecks(result.payload.task, dependencyState)
    }
  };
}
