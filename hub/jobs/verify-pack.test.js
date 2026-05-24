import { test } from "node:test";
import assert from "node:assert/strict";
import { stampVerifyPack } from "./verify-pack.js";

test("stampVerifyPack accepts future options shape and returns an empty VerifyPack with no sources", () => {
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

test("stampVerifyPack composes task, profile, and workspace items with earlier source winning", () => {
  const pack = stampVerifyPack({
    jobId: "job_123",
    task: {
      id: "t1",
      verify: {
        items: [{ kind: "command", id: "shared", required: true, cmd: "npm test" }]
      }
    },
    profile: {
      verify: {
        items: [
          { kind: "lint", id: "shared", required: true, tool: "eslint" },
          { kind: "skill_run", id: "profile-only", required: true, skillId: "lt.verify" }
        ]
      }
    },
    workspace: {
      verifyDefaults: {
        items: [
          { kind: "human_approval", id: "profile-only", required: true, prompt: "Approve?" },
          { kind: "dod_check", id: "workspace-only", required: false, ref: "DoD#1" }
        ]
      }
    },
    stampedAt: "2026-05-24T12:00:00.000Z",
    stampedFromRev: 7
  });

  assert.deepEqual(
    pack.items.map((item) => item.id),
    ["shared", "profile-only", "workspace-only"]
  );
  assert.deepEqual(pack.items[0], {
    kind: "command",
    id: "shared",
    required: true,
    cmd: "npm test",
    expectExit: 0
  });
  assert.equal(pack.items[1].kind, "skill_run");
  assert.equal(pack.items[2].kind, "dod_check");
});

test("stampVerifyPack resolves task from tracker and rejects invalid task.verify", () => {
  assert.throws(
    () =>
      stampVerifyPack({
        jobId: "job_123",
        taskId: "t1",
        tracker: {
          meta: { rev: 42 },
          tasks: [
            {
              id: "t1",
              verify: {
                items: [{ kind: "command", id: "BadID", required: true, cmd: "npm test" }]
              }
            }
          ]
        }
      }),
    /invalid task\.verify/
  );
});

test("stampVerifyPack preserves supplied pack fields and freezes a clone", () => {
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
