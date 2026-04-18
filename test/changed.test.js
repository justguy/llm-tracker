import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangedPayload } from "../hub/changed.js";
import { validProject } from "./fixtures.js";

test("buildChangedPayload summarizes task changes since a rev", () => {
  const project = validProject();
  project.meta.rev = 6;
  project.tasks[0].status = "complete";
  project.tasks[0].comment = "Finished";

  const payload = buildChangedPayload({
    slug: "test-project",
    data: project,
    fromRev: 3,
    history: [
      { rev: 2, delta: { tasks: { t1: { status: "in_progress" } } } },
      { rev: 4, delta: { meta: { scratchpad: "updated" }, tasks: { t1: { status: "complete", comment: "Finished" } } } },
      { rev: 5, delta: { tasks: { t2: { __removed__: true } }, order: ["t1", "t3"] } }
    ]
  });

  assert.equal(payload.fromRev, 3);
  assert.equal(payload.changed.length, 2);
  assert.equal(payload.changed[0].id, "t2");
  assert.equal(payload.changed[0].removed, true);
  assert.equal(payload.changed[1].id, "t1");
  assert.ok(payload.changed[1].changeKinds.includes("status"));
  assert.ok(payload.changed[1].changedKeys.includes("comment"));
  assert.deepEqual(payload.metaChanges, [{ key: "scratchpad", lastChangedRev: 4 }]);
  assert.deepEqual(payload.orderChangedRevs, [5]);
});

test("buildChangedPayload limits output and keeps newest revisions first", () => {
  const project = validProject();
  project.meta.rev = 10;

  const payload = buildChangedPayload({
    slug: "test-project",
    data: project,
    fromRev: 0,
    limit: 1,
    history: [
      { rev: 8, delta: { tasks: { t1: { comment: "updated" } } } },
      { rev: 9, delta: { tasks: { t2: { assignee: "codex" } } } }
    ]
  });

  assert.equal(payload.changed.length, 1);
  assert.equal(payload.changed[0].id, "t2");
  assert.deepEqual(payload.changed[0].changedInRevs, [9]);
});
