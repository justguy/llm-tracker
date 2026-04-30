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

test("accepts task tree grouping with kind and parent_id", () => {
  const p = validProject();
  p.tasks[0].kind = "group";
  p.tasks[1].parent_id = "t1";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, true, errors.join("; "));
});

test("rejects parent_id pointing at nonexistent task", () => {
  const p = validProject();
  p.tasks[1].parent_id = "does-not-exist";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("parent_id") && e.includes("does-not-exist")));
});

test("rejects parent_id cycles", () => {
  const p = validProject();
  p.tasks[0].parent_id = "t2";
  p.tasks[1].parent_id = "t1";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("parent chain contains a cycle")));
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

test("accepts a well-formed task reference", () => {
  const p = validProject();
  p.tasks[0].reference = "src/hub/store.js:142";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, true, errors.join("; "));
});

test("accepts a task reference with a line range", () => {
  const p = validProject();
  p.tasks[0].reference = "hub/versioning.js:59-85";
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("accepts additive references[] alongside legacy reference", () => {
  const p = validProject();
  p.tasks[0].reference = "hub/store.js:1-20";
  p.tasks[0].references = ["ARCHITECTURE.md:10-40", "hub/server.js:1-20"];
  const { ok, errors } = validateProject(p);
  assert.equal(ok, true, errors.join("; "));
});

test("accepts the partial_slice_landed outcome marker", () => {
  const p = validProject();
  p.tasks[0].outcome = "partial_slice_landed";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, true, errors.join("; "));
});

test("rejects unsupported outcome values", () => {
  const p = validProject();
  p.tasks[0].outcome = "half_done";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("outcome")));
  assert.ok(errors.some((e) => e.includes("must be one of")));
});

test("rejects malformed references[] entries", () => {
  const p = validProject();
  p.tasks[0].references = ["hub/server.js"];
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("references")));
  assert.ok(errors.some((e) => e.includes("path:line")));
  assert.ok(errors.some((e) => e.includes("bare URLs are invalid")));
});

test("rejects a task reference without a line number", () => {
  const p = validProject();
  p.tasks[0].reference = "src/hub/store.js";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("reference")));
  assert.ok(errors.some((e) => e.includes("path:line")));
});

test("allows task reference to be null (clears the field)", () => {
  const p = validProject();
  p.tasks[0].reference = null;
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("accepts a task comment under 500 chars", () => {
  const p = validProject();
  p.tasks[0].comment = "needs review from @claude before merging";
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("accepts supported effort values", () => {
  const p = validProject();
  p.tasks[0].effort = "m";
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("rejects unsupported effort values", () => {
  const p = validProject();
  p.tasks[0].effort = "xxl";
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("effort")));
});

test("rejects a task comment over 500 chars", () => {
  const p = validProject();
  p.tasks[0].comment = "x".repeat(501);
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("task.comment is too long")));
  assert.ok(errors.some((e) => e.includes("context.notes")));
});

test("allows task comment to be null (clears the field)", () => {
  const p = validProject();
  p.tasks[0].comment = null;
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("accepts a scratchpad up to 5000 chars", () => {
  const p = validProject();
  p.meta.scratchpad = "x".repeat(5000);
  const { ok } = validateProject(p);
  assert.equal(ok, true);
});

test("rejects a scratchpad over 5000 chars", () => {
  const p = validProject();
  p.meta.scratchpad = "x".repeat(5001);
  const { ok, errors } = validateProject(p);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("meta.scratchpad is too long")));
  assert.ok(errors.some((e) => e.includes("short live status banner")));
});

test("requires at least one swimlane and priority", () => {
  const p = validProject();
  p.meta.swimlanes = [];
  const { ok } = validateProject(p);
  assert.equal(ok, false);
});
