// test/run-session-task-claim.test.js — SH-3-04 (TDD v0.5 §8A.1, §6.6)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_MODES,
  isClaimMode,
  evaluateTaskClaim,
} from "../hub/run-session/task-claim.js";

/**
 * Build a minimal valid `ClaimInput`. Tests override only the field(s) they
 * care about; mirrors `validJobInput` in test/jobs-api.test.js.
 */
function validInput(overrides = {}) {
  return {
    projectSlug: "demo",
    taskId: "t-1",
    currentTrackerRev: 7,
    activeJobs: [],
    ...overrides,
  };
}

function activeJob(overrides = {}) {
  return {
    id: "job_active_1",
    projectSlug: "demo",
    taskId: "t-1",
    status: "running",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// constants / guards
// ---------------------------------------------------------------------------

test("CLAIM_MODES exposes exactly the §8A.1 modes (frozen)", () => {
  assert.deepEqual([...CLAIM_MODES], ["fail_if_active", "join", "force"]);
  assert.equal(Object.isFrozen(CLAIM_MODES), true);
});

test("isClaimMode accepts the three modes and rejects everything else", () => {
  for (const m of CLAIM_MODES) assert.equal(isClaimMode(m), true);
  for (const bad of [null, undefined, "", "FAIL_IF_ACTIVE", 42, "later", {}]) {
    assert.equal(isClaimMode(bad), false);
  }
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

test("invalid_input: non-object input", () => {
  for (const bad of [null, undefined, "x", 42, []]) {
    const r = evaluateTaskClaim(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
  }
});

test("invalid_input: missing/blank projectSlug", () => {
  for (const bad of [undefined, "", 42, null]) {
    const r = evaluateTaskClaim(validInput({ projectSlug: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /projectSlug/);
  }
});

test("invalid_input: missing/blank taskId", () => {
  for (const bad of [undefined, "", 42, null]) {
    const r = evaluateTaskClaim(validInput({ taskId: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /taskId/);
  }
});

test("invalid_input: non-integer / negative currentTrackerRev", () => {
  for (const bad of [undefined, -1, 1.5, "7", Number.NaN]) {
    const r = evaluateTaskClaim(validInput({ currentTrackerRev: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /currentTrackerRev/);
  }
});

test("invalid_input: non-array activeJobs", () => {
  for (const bad of [undefined, null, "x", {}, 0]) {
    const r = evaluateTaskClaim(validInput({ activeJobs: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /activeJobs/);
  }
});

test("invalid_input: bad claimMode", () => {
  for (const bad of ["", "FAIL", "later", 1, {}]) {
    const r = evaluateTaskClaim(validInput({ claimMode: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /claimMode/);
  }
});

test("invalid_input: bad expectedTrackerRev when present", () => {
  for (const bad of [-1, 1.5, "7", Number.NaN]) {
    const r = evaluateTaskClaim(validInput({ expectedTrackerRev: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_input");
    assert.match(r.detail, /expectedTrackerRev/);
  }
});

// ---------------------------------------------------------------------------
// DoD 1 — expectedTrackerRev gate
// ---------------------------------------------------------------------------

test("DoD 1: expectedTrackerRev equal to currentTrackerRev passes the gate", () => {
  const r = evaluateTaskClaim(
    validInput({ expectedTrackerRev: 7, currentTrackerRev: 7 }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, "created");
});

test("DoD 1: stale_tracker_rev when expectedTrackerRev !== currentTrackerRev", () => {
  const r = evaluateTaskClaim(
    validInput({ expectedTrackerRev: 6, currentTrackerRev: 7 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "stale_tracker_rev");
  assert.equal(r.currentRev, 7);
});

test("DoD 1: expectedTrackerRev omitted → gate is skipped, mode dispatch continues", () => {
  const r = evaluateTaskClaim(validInput({ currentTrackerRev: 7 }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, "created");
});

test("DoD 1: stale_tracker_rev takes precedence over a task_claim_conflict", () => {
  const r = evaluateTaskClaim(
    validInput({
      expectedTrackerRev: 6,
      currentTrackerRev: 7,
      activeJobs: [activeJob()],
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "stale_tracker_rev");
});

// ---------------------------------------------------------------------------
// DoD 2 — claimMode dispatch
// ---------------------------------------------------------------------------

test("DoD 2: fail_if_active is the default when claimMode is omitted", () => {
  const r = evaluateTaskClaim(validInput({ activeJobs: [activeJob()] }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "task_claim_conflict");
  assert.equal(r.activeJobId, "job_active_1");
});

test("DoD 2: fail_if_active on a free task → created", () => {
  const r = evaluateTaskClaim(validInput({ claimMode: "fail_if_active" }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, "created");
  assert.equal(r.activeJobId, null);
  assert.equal(r.overrideEvent, null);
});

test("DoD 2: fail_if_active with active job → task_claim_conflict carries that job id", () => {
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "fail_if_active",
      activeJobs: [activeJob({ id: "job_blocker" })],
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "task_claim_conflict");
  assert.equal(r.activeJobId, "job_blocker");
});

test("DoD 2: join with active job → joined w/ activeJobId, overrideEvent null", () => {
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "join",
      activeJobs: [activeJob({ id: "job_pred" })],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, "joined");
  assert.equal(r.activeJobId, "job_pred");
  assert.equal(r.overrideEvent, null);
});

test("DoD 2: join with no active job → behaves like created (documented parity)", () => {
  const r = evaluateTaskClaim(validInput({ claimMode: "join" }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, "created");
  assert.equal(r.activeJobId, null);
  assert.equal(r.overrideEvent, null);
});

test("DoD 2: terminal-status jobs do NOT block fail_if_active", () => {
  for (const status of ["completed", "cancelled", "rolled_over"]) {
    const r = evaluateTaskClaim(
      validInput({ activeJobs: [activeJob({ status })] }),
    );
    assert.equal(r.ok, true, `status=${status}`);
    assert.equal(r.mode, "created");
    assert.equal(r.activeJobId, null);
  }
});

test("DoD 2: jobs for a different (projectSlug, taskId) are ignored", () => {
  const r = evaluateTaskClaim(
    validInput({
      activeJobs: [
        activeJob({ id: "job_other_project", projectSlug: "other" }),
        activeJob({ id: "job_other_task", taskId: "t-2" }),
      ],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, "created");
  assert.equal(r.activeJobId, null);
});

test("DoD 2: multiple matching active jobs → first by array order wins", () => {
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "fail_if_active",
      activeJobs: [
        activeJob({ id: "job_first" }),
        activeJob({ id: "job_second" }),
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "task_claim_conflict");
  assert.equal(r.activeJobId, "job_first");
});

// ---------------------------------------------------------------------------
// DoD 3 — force requires reason; emits override event
// ---------------------------------------------------------------------------

test("DoD 3: force without reason → force_requires_reason", () => {
  const r = evaluateTaskClaim(validInput({ claimMode: "force" }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "force_requires_reason");
  assert.match(r.detail, /reason/);
});

test("DoD 3: force with empty/whitespace-ish reason → force_requires_reason", () => {
  for (const bad of ["", undefined, null, 42]) {
    const r = evaluateTaskClaim(
      validInput({ claimMode: "force", forceReason: bad }),
    );
    assert.equal(r.ok, false, `forceReason=${JSON.stringify(bad)}`);
    assert.equal(r.error, "force_requires_reason");
  }
});

test("DoD 3: force with reason and no active job → forced, preemptedJobId null", () => {
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "force",
      forceReason: "operator override",
      expectedTrackerRev: 7,
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, "forced");
  assert.equal(r.activeJobId, null);
  assert.ok(r.overrideEvent);
  assert.equal(r.overrideEvent.type, "human.override");
  assert.equal(r.overrideEvent.reason, "operator override");
  assert.equal(r.overrideEvent.context.kind, "task_claim_force");
  assert.equal(r.overrideEvent.context.projectSlug, "demo");
  assert.equal(r.overrideEvent.context.taskId, "t-1");
  assert.equal(r.overrideEvent.context.preemptedJobId, null);
  assert.equal(r.overrideEvent.context.observedTrackerRev, 7);
  assert.equal(r.overrideEvent.context.expectedTrackerRev, 7);
});

test("DoD 3: force with reason pre-empting an active job → overrideEvent records preemptedJobId", () => {
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "force",
      forceReason: "supersede stalled session",
      activeJobs: [activeJob({ id: "job_to_stomp" })],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.mode, "forced");
  assert.equal(r.activeJobId, "job_to_stomp");
  assert.equal(r.overrideEvent.context.preemptedJobId, "job_to_stomp");
});

test("DoD 3: force with forceUser records user on the override event", () => {
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "force",
      forceReason: "manual recovery",
      forceUser: "user:adi",
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.overrideEvent.user, "user:adi");
});

test("DoD 3: force without forceUser omits the user field from the override event", () => {
  const r = evaluateTaskClaim(
    validInput({ claimMode: "force", forceReason: "manual recovery" }),
  );
  assert.equal(r.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(r.overrideEvent, "user"), false);
});

test("DoD 3: force-without-reason wins over an existing active job (auth check first)", () => {
  // force is special: even with an active job present, missing reason is
  // rejected before mode-dispatch concludes. This documents that we don't
  // silently fall back to fail_if_active.
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "force",
      activeJobs: [activeJob()],
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "force_requires_reason");
});

test("DoD 3: force still respects stale_tracker_rev — rev gate runs first", () => {
  const r = evaluateTaskClaim(
    validInput({
      claimMode: "force",
      forceReason: "doesn't matter",
      expectedTrackerRev: 6,
      currentTrackerRev: 7,
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "stale_tracker_rev");
});

test("DoD 3: forced overrideEvent.source defaults to 'system' (caller may override before append)", () => {
  const r = evaluateTaskClaim(
    validInput({ claimMode: "force", forceReason: "operator override" }),
  );
  assert.equal(r.overrideEvent.source, "system");
});

test("DoD 3: forced overrideEvent omits expectedTrackerRev from context when caller didn't supply one", () => {
  const r = evaluateTaskClaim(
    validInput({ claimMode: "force", forceReason: "manual recovery" }),
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(r.overrideEvent.context, "expectedTrackerRev"),
    false,
  );
  assert.equal(r.overrideEvent.context.observedTrackerRev, 7);
});

// ---------------------------------------------------------------------------
// Immutability of returned descriptors
// ---------------------------------------------------------------------------

test("returned allow descriptors are deeply frozen", () => {
  const r = evaluateTaskClaim(
    validInput({ claimMode: "force", forceReason: "auditable" }),
  );
  assert.equal(Object.isFrozen(r), true);
  assert.equal(Object.isFrozen(r.overrideEvent), true);
  assert.equal(Object.isFrozen(r.overrideEvent.context), true);
  assert.throws(
    () => {
      r.mode = "created";
    },
    /Cannot|read only|not extensible/,
  );
  assert.throws(
    () => {
      r.overrideEvent.reason = "tampered";
    },
    /Cannot|read only|not extensible/,
  );
});

test("returned reject descriptors are frozen", () => {
  const r = evaluateTaskClaim(
    validInput({ expectedTrackerRev: 6, currentTrackerRev: 7 }),
  );
  assert.equal(Object.isFrozen(r), true);
  assert.throws(
    () => {
      r.error = "other";
    },
    /Cannot|read only|not extensible/,
  );
});
