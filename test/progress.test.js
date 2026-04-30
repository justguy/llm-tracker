import { test } from "node:test";
import assert from "node:assert/strict";
import { countsFor, pctFor, deriveBlocked, deriveProject } from "../hub/progress.js";
import { validProject } from "./fixtures.js";

test("countsFor sums statuses", () => {
  const p = validProject();
  const c = countsFor(p.tasks);
  assert.equal(c.not_started, 1);
  assert.equal(c.in_progress, 1);
  assert.equal(c.complete, 1);
  assert.equal(c.deferred, 0);
});

test("pctFor weights in_progress at 0.5 and ignores deferred", () => {
  const tasks = [
    { status: "complete" },
    { status: "complete" },
    { status: "in_progress" },
    { status: "not_started" },
    { status: "deferred" }
  ];
  // (1+1+0.5+0) / 4 = 0.625 → 63
  assert.equal(pctFor(tasks), 63);
});

test("pctFor returns 0 for empty or all-deferred", () => {
  assert.equal(pctFor([]), 0);
  assert.equal(pctFor([{ status: "deferred" }, { status: "deferred" }]), 0);
});

test("pctFor ignores outcome markers and still keys off status only", () => {
  const tasks = [
    { status: "complete", outcome: "partial_slice_landed" },
    { status: "in_progress", outcome: "partial_slice_landed" }
  ];

  assert.equal(pctFor(tasks), 75);
});

test("deriveBlocked finds open deps", () => {
  const p = validProject();
  const blocked = deriveBlocked(p.tasks);
  assert.deepEqual(blocked, { t2: ["t1"] });
});

test("deriveBlocked ignores aggregate container dependencies", () => {
  const p = validProject();
  p.tasks[0].kind = "group";

  const blocked = deriveBlocked(p.tasks);
  assert.deepEqual(blocked, {});

  const d = deriveProject(p);
  assert.equal(d.actionability.byTask.t1.actionability, "parked");
  assert.equal(d.actionability.byTask.t2.actionability, "executable");
});

test("deriveBlocked ignores parent container dependencies", () => {
  const p = validProject();
  p.tasks[2].status = "not_started";
  p.tasks[2].dependencies = ["t1"];
  p.tasks[2].parent_id = "t1";

  const blocked = deriveBlocked(p.tasks);
  assert.deepEqual(blocked, {});

  const d = deriveProject(p);
  assert.equal(d.actionability.byTask.t1.actionability, "parked");
  assert.equal(d.actionability.byTask.t2.actionability, "executable");
  assert.equal(d.actionability.byTask.t3.actionability, "executable");
});

test("deriveProject produces per-swimlane breakdown", () => {
  const d = deriveProject(validProject());
  assert.equal(d.total, 3);
  assert.equal(d.perSwimlane.exec.total, 2);
  assert.equal(d.perSwimlane.ops.total, 1);
  assert.equal(d.perSwimlane.ops.pct, 100);
});
