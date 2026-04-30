import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLookupFromEntries,
  parseDependencyRef
} from "../hub/cross-project-deps.js";
import { validateProject } from "../hub/validator.js";
import { buildBlockersPayload } from "../hub/blockers.js";
import { buildBriefPayload } from "../hub/briefs.js";
import { buildExecutePayload } from "../hub/execute.js";
import { buildHandoffPayload } from "../hub/handoff.js";
import { buildFuzzySearchPayload } from "../hub/search.js";
import { deriveProject } from "../hub/progress.js";
import { resolvePickSelection } from "../hub/pick.js";
import {
  blockingDependencies,
  buildProjectTaskContext,
  externalDependencyDetails,
  summarizeTask
} from "../hub/task-metadata.js";
import { validProject } from "./fixtures.js";

test("parseDependencyRef distinguishes local and external references", () => {
  assert.deepEqual(parseDependencyRef("t1"), { kind: "local", taskId: "t1", raw: "t1" });
  assert.deepEqual(parseDependencyRef("other:t9"), {
    kind: "external",
    slug: "other",
    taskId: "t9",
    raw: "other:t9"
  });
  assert.equal(parseDependencyRef("   "), null);
  assert.equal(parseDependencyRef(":missing-slug"), null);
  assert.equal(parseDependencyRef("missing-task:"), null);
  assert.equal(parseDependencyRef(null), null);
});

test("validator accepts cross-project deps without requiring the slug to exist", () => {
  const project = validProject();
  project.tasks[1].dependencies = ["t1", "other:t9"];
  const { ok, errors } = validateProject(project);
  assert.equal(ok, true, errors.join("; "));
});

test("validator still rejects unknown LOCAL deps after cross-project allowance", () => {
  const project = validProject();
  project.tasks[1].dependencies = ["t1", "missing-local"];
  const { ok, errors } = validateProject(project);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing-local")));
});

test("blockingDependencies treats incomplete external deps as blockers", () => {
  const project = validProject();
  project.tasks[1].dependencies = ["t1", "other:t9"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: {
        meta: { slug: "other" },
        tasks: [
          { id: "t9", title: "External", status: "in_progress" }
        ]
      }
    }
  ]);

  const context = buildProjectTaskContext({ data: project, externalLookup });
  const blocking = blockingDependencies(project.tasks[1], context);
  assert.deepEqual(blocking, ["t1", "other:t9"]);
});

test("blockingDependencies treats completed external deps as satisfied", () => {
  const project = validProject();
  project.tasks[0].status = "complete";
  project.tasks[1].dependencies = ["t1", "other:t9"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: {
        meta: { slug: "other" },
        tasks: [{ id: "t9", title: "External", status: "complete" }]
      }
    }
  ]);

  const context = buildProjectTaskContext({ data: project, externalLookup });
  const blocking = blockingDependencies(project.tasks[1], context);
  assert.deepEqual(blocking, []);
});

test("blockingDependencies treats missing external tasks as blockers", () => {
  const project = validProject();
  project.tasks[1].dependencies = ["other:does-not-exist"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: { meta: { slug: "other" }, tasks: [] }
    }
  ]);

  const context = buildProjectTaskContext({ data: project, externalLookup });
  const blocking = blockingDependencies(project.tasks[1], context);
  assert.deepEqual(blocking, ["other:does-not-exist"]);
});

test("externalDependencyDetails surfaces title/status/exists for downstream consumers", () => {
  const project = validProject();
  project.tasks[1].dependencies = ["t1", "other:t9", "ghost:tx"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: {
        meta: { slug: "other" },
        tasks: [{ id: "t9", title: "External", status: "complete" }]
      }
    }
  ]);

  const context = buildProjectTaskContext({ data: project, externalLookup });
  const details = externalDependencyDetails(project.tasks[1], context);
  assert.equal(details.length, 2);
  const otherDep = details.find((d) => d.slug === "other");
  assert.equal(otherDep.exists, true);
  assert.equal(otherDep.status, "complete");
  assert.equal(otherDep.title, "External");
  assert.equal(otherDep.blocking, false);
  const ghostDep = details.find((d) => d.slug === "ghost");
  assert.equal(ghostDep.exists, false);
  assert.equal(ghostDep.blocking, true);
});

test("summarizeTask exposes external_dependencies in the summary", () => {
  const project = validProject();
  project.tasks[1].dependencies = ["other:t9"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: { meta: { slug: "other" }, tasks: [{ id: "t9", title: "External", status: "in_progress" }] }
    }
  ]);

  const context = buildProjectTaskContext({ data: project, externalLookup });
  const summary = summarizeTask(project.tasks[1], context);
  assert.equal(summary.external_dependencies.length, 1);
  assert.equal(summary.external_dependencies[0].slug, "other");
  assert.deepEqual(summary.blocking_on, ["other:t9"]);
});

test("buildBlockersPayload reports external blockers with project metadata", () => {
  const project = validProject();
  project.tasks[1].dependencies = ["other:t9"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: {
        meta: { slug: "other" },
        tasks: [{ id: "t9", title: "External", status: "in_progress" }]
      }
    }
  ]);

  const payload = buildBlockersPayload({
    slug: "test-project",
    data: project,
    externalLookup
  });

  assert.equal(payload.blocked.length, 1);
  assert.equal(payload.blocked[0].id, "t2");
  assert.deepEqual(payload.blocked[0].blocking_on, ["other:t9"]);
  const detail = payload.blocked[0].blocking_task_details[0];
  assert.equal(detail.external, true);
  assert.equal(detail.project, "other");
  assert.equal(detail.taskId, "t9");
  assert.equal(detail.status, "in_progress");

  // The reverse blocking view should also surface the external task as a blocker.
  assert.equal(payload.blocking.length, 1);
  assert.equal(payload.blocking[0].external, true);
  assert.equal(payload.blocking[0].project, "other");
  assert.equal(payload.blocking[0].blockedCount, 1);
});

test("brief, execute, and handoff packs surface external dependencies", () => {
  const project = validProject();
  project.meta.rev = 4;
  project.tasks[1].dependencies = ["other:t9"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: {
        meta: { slug: "other" },
        tasks: [{ id: "t9", title: "External", status: "in_progress" }]
      }
    }
  ]);

  const brief = buildBriefPayload({
    slug: "test-project",
    data: project,
    externalLookup,
    assignee: "claude",
    taskId: "t2"
  });
  assert.equal(brief.task.external_dependencies.length, 1);
  assert.equal(brief.task.external_dependencies[0].slug, "other");

  const execute = buildExecutePayload({
    slug: "test-project",
    data: project,
    externalLookup,
    taskId: "t2"
  });
  const planKinds = execute.executionPlan.map((step) => step.kind);
  assert.ok(planKinds.includes("external_blocker"));

  const handoff = buildHandoffPayload({
    slug: "test-project",
    data: project,
    externalLookup,
    taskId: "t2"
  });
  assert.match(handoff.handoffPrompt, /## External dependencies/);
  assert.match(handoff.handoffPrompt, /other:t9/);
});

test("pick, status derivation, and fuzzy search honor completed external dependencies", () => {
  const project = validProject();
  project.tasks[0].status = "complete";
  project.tasks[1].dependencies = ["other:t9"];

  const externalLookup = buildLookupFromEntries([
    {
      ok: true,
      slug: "other",
      data: {
        meta: { slug: "other" },
        tasks: [{ id: "t9", title: "External", status: "complete" }]
      }
    }
  ]);

  const picked = resolvePickSelection({
    slug: "test-project",
    data: project,
    externalLookup,
    assignee: "claude",
    taskId: "t2"
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.task.ready, true);

  const derived = deriveProject(project, { externalLookup });
  assert.equal(derived.actionability.byTask.t2.actionability, "executable");
  assert.deepEqual(derived.blocked, {});

  const fuzzy = buildFuzzySearchPayload({
    slug: "test-project",
    data: project,
    externalLookup,
    query: "Task 2"
  });
  const match = fuzzy.matches.find((item) => item.id === "t2");
  assert.equal(match.actionability, "executable");
});
