// test/run-session-preflight.test.js — sh-3-18 (TDD v0.5 §6.7, §8A.1)

import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultProviderCapabilities } from "../hub/providers/capabilities.js";
import { createDraftStore } from "../hub/run-session/drafts.js";
import { buildRunSessionPreflightWarnings } from "../hub/run-session/preflight.js";

function caps(overrides = {}) {
  return { ...defaultProviderCapabilities(), ...overrides };
}

function provider(capabilities = caps()) {
  return { id: "codex", capabilities: () => capabilities };
}

function registry(entries = {}) {
  return {
    get(providerId) {
      return entries[providerId];
    },
  };
}

function baseDraft(overrides = {}) {
  return {
    source: "task_card",
    mode: "task_backed",
    projectSlug: "demo",
    taskId: "t-1",
    taskLocked: true,
    runtime: "manual",
    ...overrides,
  };
}

test("emits provider_unavailable when selected provider is missing", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ providerId: "missing-provider" }),
    providerRegistry: registry({}),
  });

  assert.deepEqual(warnings, [
    { kind: "provider_unavailable", providerId: "missing-provider", severity: "high" },
  ]);
});

test("emits provider_unavailable when provider capability reporting is unusable", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ providerId: "broken-provider" }),
    providerRegistry: registry({
      "broken-provider": { id: "broken-provider", capabilities: () => ({ rawStdio: "yes" }) },
    }),
  });

  assert.deepEqual(warnings, [
    { kind: "provider_unavailable", providerId: "broken-provider", severity: "high" },
  ]);
});

test("emits capability_mismatch for required session capabilities disabled by provider caps", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ providerId: "codex" }),
    providerRegistry: registry({
      codex: provider(caps({ structuredCommandEvents: false, stdinWrite: true })),
    }),
    requiredCapabilities: ["structuredCommands", "stdinWrite"],
  });

  assert.deepEqual(warnings, [
    { kind: "capability_mismatch", requiredCap: "structuredCommands", severity: "high" },
  ]);
});

test("emits sandbox_disallowed when the requested sandbox violates launch policy", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ sandbox: "full-auto" }),
    sandboxPolicy: {
      allowedSandboxes: ["readonly", "workspace-write"],
      reason: "full-auto requires an explicit operator approval",
    },
  });

  assert.deepEqual(warnings, [
    {
      kind: "sandbox_disallowed",
      sandbox: "full-auto",
      reason: "full-auto requires an explicit operator approval",
      severity: "high",
    },
  ]);
});

test("emits context_injection_unsupported when refreshed context is requested without provider support", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({
      refreshContext: true,
      capabilityPreview: caps({ directContextInjection: false }),
    }),
  });

  assert.deepEqual(warnings, [
    { kind: "context_injection_unsupported", severity: "medium" },
  ]);
});

test("emits task_already_bound_other_session for active task jobs owned by another session", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ projectSlug: "demo", taskId: "t-1" }),
    jobs: [
      { id: "job_other_project", projectSlug: "other", taskId: "t-1", sessionId: "ses_other", status: "running" },
      { id: "job_done", projectSlug: "demo", taskId: "t-1", sessionId: "ses_done", status: "completed" },
      { id: "job_live", projectSlug: "demo", taskId: "t-1", sessionId: "ses_live", status: "running" },
    ],
  });

  assert.deepEqual(warnings, [
    {
      kind: "task_already_bound_other_session",
      otherSessionId: "ses_live",
      otherJobId: "job_live",
      severity: "high",
    },
  ]);
});

test("task_already_bound_other_session follows terminal job status authority", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ projectSlug: "demo", taskId: "t-1" }),
    jobs: [
      { id: "job_completed", projectSlug: "demo", taskId: "t-1", sessionId: "ses_completed", status: "completed" },
      { id: "job_cancelled", projectSlug: "demo", taskId: "t-1", sessionId: "ses_cancelled", status: "cancelled" },
      { id: "job_rollover", projectSlug: "demo", taskId: "t-1", sessionId: "ses_rollover", status: "rolled_over" },
    ],
  });

  assert.deepEqual(warnings, []);
});

test("does not emit task_already_bound_other_session for the attach target session itself", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({
      source: "attach",
      mode: "attach_existing",
      taskId: null,
      attachTaskId: "t-1",
      attachExistingSessionId: "ses_current",
    }),
    jobs: [
      { id: "job_current", projectSlug: "demo", taskId: "t-1", sessionId: "ses_current", status: "running" },
    ],
  });

  assert.deepEqual(warnings, []);
});

test("emits task_already_bound_other_session from active session fallback when job projection is missing", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ projectSlug: "demo", taskId: "t-1" }),
    sessions: [
      { id: "ses_live", projectSlug: "demo", taskId: "t-1", activeJobId: "job_live", status: "running" },
    ],
  });

  assert.deepEqual(warnings, [
    {
      kind: "task_already_bound_other_session",
      otherSessionId: "ses_live",
      otherJobId: "job_live",
      severity: "high",
    },
  ]);
});

test("emits attach_context_overflow when estimated attach context exceeds capacity", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ source: "attach", mode: "attach_existing", taskId: null, attachTaskId: "t-1" }),
    contextBudget: { currentUsed: 900, estBriefTokens: 200, capacity: 1000 },
  });

  assert.deepEqual(warnings, [
    {
      kind: "attach_context_overflow",
      currentUsed: 900,
      estBriefTokens: 200,
      capacity: 1000,
      severity: "medium",
    },
  ]);
});

test("does not emit attach_context_overflow for non-attach drafts", () => {
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({ mode: "task_backed", source: "task_card" }),
    contextBudget: { currentUsed: 900, estBriefTokens: 200, capacity: 1000 },
  });

  assert.deepEqual(warnings, []);
});

test("preflight warnings are accepted by RunSessionDraft validation", () => {
  const store = createDraftStore({ now: () => 1_700_000_000_000 });
  const warnings = buildRunSessionPreflightWarnings({
    draft: baseDraft({
      source: "attach",
      mode: "attach_existing",
      taskId: null,
      attachTaskId: "t-1",
      attachExistingSessionId: "ses_current",
      providerId: "codex",
      sandbox: "full-auto",
      refreshContext: true,
      capabilityPreview: caps({ directContextInjection: false }),
    }),
    providerRegistry: registry({ codex: provider(caps({ directContextInjection: false })) }),
    requiredCapabilities: ["structuredCommands"],
    sandboxPolicy: { allowedSandboxes: ["readonly"], reason: "full-auto disabled in CI" },
    jobs: [{ id: "job_live", projectSlug: "demo", taskId: "t-1", sessionId: "ses_live", status: "running" }],
    contextBudget: { currentUsed: 100, estBriefTokens: 950, capacity: 1000 },
  });

  const draft = store.create({
    ...baseDraft({
      source: "attach",
      mode: "attach_existing",
      taskId: null,
      attachTaskId: "t-1",
      attachExistingSessionId: "ses_current",
    }),
    warnings,
  });
  assert.deepEqual(
    draft.warnings.map((warning) => warning.kind),
    [
      "capability_mismatch",
      "sandbox_disallowed",
      "context_injection_unsupported",
      "task_already_bound_other_session",
      "attach_context_overflow",
    ],
  );
});
