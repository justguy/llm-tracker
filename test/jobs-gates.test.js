// test/jobs-gates.test.js — SH-5-05 completion gate state machine

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGatesPendingResult,
  buildOverriddenCompletionGates,
  createHumanOverrideEvent,
  findMissingRequiredGates,
  isCompletionGateSatisfied,
  resolveUiCompleteMode,
  transitionCompletionGate,
  UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING,
} from "../hub/jobs/gates.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

const JOB_ID = "job_01h2x3y4z5a6b7c8d9e0f1g2h3";
const SES_ID = "ses_01h2x3y4z5a6b7c8d9e0f1g2h3";

test("findMissingRequiredGates: satisfied/overridden gates require runtime event evidence", () => {
  const evidenceRef = makeRuntimeId("evt");
  const gates = [
    { id: "pending", kind: "verify_pack", required: true, status: "pending" },
    { id: "satisfied-with-evidence", kind: "verify_pack", required: true, status: "satisfied", evidenceRef },
    { id: "satisfied-no-evidence", kind: "verify_pack", required: true, status: "satisfied" },
    {
      id: "overridden-with-evidence",
      kind: "verify_pack",
      required: true,
      status: "overridden",
      evidenceRef,
      overrideReason: "human accepted",
    },
    { id: "overridden-no-reason", kind: "verify_pack", required: true, status: "overridden", evidenceRef },
    { id: "optional-pending", kind: "verify_pack", required: false, status: "pending" },
  ];

  assert.equal(isCompletionGateSatisfied(gates[1]), true);
  assert.equal(isCompletionGateSatisfied(gates[2]), false);
  assert.deepEqual(
    findMissingRequiredGates(gates).map((gate) => gate.id),
    ["pending", "satisfied-no-evidence", "overridden-no-reason"],
  );
});

test("transitionCompletionGate: satisfied and overridden transitions require evidenceRef", () => {
  const evidenceRef = makeRuntimeId("evt");
  assert.throws(
    () => transitionCompletionGate({ id: "g1", required: true, status: "pending" }, { status: "satisfied" }),
    /evidenceRef/,
  );
  assert.throws(
    () => transitionCompletionGate({ id: "g1", required: true, status: "pending" }, { status: "overridden", evidenceRef }),
    /overrideReason/,
  );

  assert.deepEqual(
    transitionCompletionGate(
      { id: "g1", kind: "verify_pack", required: true, status: "pending" },
      { status: "satisfied", evidenceRef },
    ),
    { id: "g1", kind: "verify_pack", required: true, status: "satisfied", evidenceRef },
  );
  assert.deepEqual(
    transitionCompletionGate(
      { id: "g1", kind: "verify_pack", required: true, status: "pending" },
      { status: "overridden", evidenceRef, overrideReason: "operator accepted risk" },
    ),
    {
      id: "g1",
      kind: "verify_pack",
      required: true,
      status: "overridden",
      evidenceRef,
      overrideReason: "operator accepted risk",
    },
  );
});

test("buildOverriddenCompletionGates: overrides only missing required gates and binds evidence", () => {
  const satisfiedEvidence = makeRuntimeId("evt");
  const overrideEvidence = makeRuntimeId("evt");
  const job = {
    id: JOB_ID,
    completionGates: [
      { id: "g-missing", kind: "verify_pack", required: true, status: "pending" },
      { id: "g-satisfied", kind: "verify_pack", required: true, status: "satisfied", evidenceRef: satisfiedEvidence },
      { id: "g-optional", kind: "verify_pack", required: false, status: "pending" },
    ],
  };

  const result = buildOverriddenCompletionGates(job, {
    evidenceRef: overrideEvidence,
    reason: "operator accepted risk",
  });

  assert.deepEqual(
    result.overriddenGates.map((gate) => gate.id),
    ["g-missing"],
  );
  assert.deepEqual(result.completionGates[0], {
    id: "g-missing",
    kind: "verify_pack",
    required: true,
    status: "overridden",
    evidenceRef: overrideEvidence,
    overrideReason: "operator accepted risk",
  });
  assert.deepEqual(result.completionGates[1], job.completionGates[1]);
  assert.deepEqual(result.completionGates[2], job.completionGates[2]);
});

test("createHumanOverrideEvent: records job, gate ids, reason, user, and context", () => {
  const event = createHumanOverrideEvent({
    job: {
      id: JOB_ID,
      sessionId: SES_ID,
      projectSlug: "demo",
      taskId: "t-1",
    },
    gateIds: ["g1", "g2"],
    reason: "manual release approval",
    user: "user:adi",
    workspace: "/tmp/workspace",
    ts: "2026-05-25T00:00:00.000Z",
  });

  assert.equal(event.type, "human.override");
  assert.equal(event.jobId, JOB_ID);
  assert.deepEqual(event.gateIds, ["g1", "g2"]);
  assert.equal(event.reason, "manual release approval");
  assert.equal(event.user, "user:adi");
  assert.equal(event.context.kind, "complete_override");
  assert.equal(event.context.sessionId, SES_ID);
  assert.equal(event.context.projectSlug, "demo");
  assert.equal(event.context.taskId, "t-1");
});

test("complete-mode helpers expose the default block_required_missing result", () => {
  assert.equal(resolveUiCompleteMode(undefined), UI_COMPLETE_MODE_BLOCK_REQUIRED_MISSING);
  assert.throws(() => resolveUiCompleteMode("silent_complete"), /uiCompleteMode/);
  assert.deepEqual(buildGatesPendingResult(JOB_ID, [{ id: "g1" }]), {
    ok: false,
    mode: "gates_pending",
    missing: [{ id: "g1" }],
    missing_gates: [{ id: "g1" }],
    requiresOverride: true,
    uiCompleteMode: "block_required_missing",
    overridePromptUrl: `/api/jobs/${JOB_ID}/complete-override`,
  });
});
