import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProject } from "../hub/validator.js";
import { validProject } from "./fixtures.js";

test("valid project passes", () => {
  const { ok, errors } = validateProject(validProject());
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("rejects invalid status", () => {
  const p = validProject();
  p.tasks[0].status = "done";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("must be one of")));
});

test("rejects task placement with unknown swimlane", () => {
  const p = validProject();
  p.tasks[0].placement.swimlaneId = "ghost";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("ghost") && e.includes("swimlanes")));
});

test("rejects task placement with unknown priority", () => {
  const p = validProject();
  p.tasks[0].placement.priorityId = "p9";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("p9") && e.includes("priorities")));
});

test("rejects duplicate task ids", () => {
  const p = validProject();
  p.tasks[1].id = "t1";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("duplicate")));
});

test("rejects dependency pointing at nonexistent task", () => {
  const p = validProject();
  p.tasks[0].dependencies = ["does-not-exist"];
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("does-not-exist")));
});

test("rejects bad slug pattern", () => {
  const p = validProject();
  p.meta.slug = "Bad Slug!";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("pattern")));
});

test("allows additional context keys", () => {
  const p = validProject();
  p.tasks[0].context.files_touched = ["src/a.js"];
  p.tasks[0].context.custom_key = { anything: "goes" };
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("requires at least one swimlane and priority", () => {
  const p = validProject();
  p.meta.swimlanes = [];
  const { ok } = validateProject(p);
  assert.equal(ok, false);
});
