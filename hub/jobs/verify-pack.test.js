import { test } from "node:test";
import assert from "node:assert/strict";
import { stampVerifyPack } from "./verify-pack.js";

test("stampVerifyPack stub accepts future options shape and returns an empty VerifyPack", () => {
  const pack = stampVerifyPack({
    jobId: "job_123",
    tracker: { meta: { rev: 42 } },
    stampedAt: "2026-05-24T12:00:00.000Z"
  });

  assert.deepEqual(pack, {
    jobId: "job_123",
    stampedAt: "2026-05-24T12:00:00.000Z",
    stampedFromRev: 42,
    items: []
  });
});

test("stampVerifyPack stub preserves supplied pack fields and freezes a clone", () => {
  const input = {
    jobId: "job_123",
    stampedAt: "2026-05-24T12:00:00.000Z",
    stampedFromRev: 42,
    items: [{ kind: "command", id: "lt.test", required: true, cmd: "npm test" }]
  };

  const pack = stampVerifyPack(input);

  assert.notEqual(pack, input);
  assert.notEqual(pack.items, input.items);
  assert.deepEqual(pack, input);
  assert.equal(Object.isFrozen(pack), true);
  assert.equal(Object.isFrozen(pack.items), true);
  assert.equal(Object.isFrozen(pack.items[0]), true);
});
