import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RunSessionWizardView,
  buildInitialRunSessionDraft,
  buildRunSessionCliCommand,
  buildRunSessionDraftPatch,
  copyRunSessionPrompt,
  createRunSessionDraft,
  fetchRunCandidates,
  hasUnresolvedHighWarnings,
  launchDisabledReasonFor,
  launchRunSessionDraft,
  normalizeRunCandidates,
  patchRunSessionDraft,
} from "./RunSessionWizard.js";
import { buildRunSessionCopyPrompt } from "../../hub/api/run-session.js";

function flattenRenderedNodes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => flattenRenderedNodes(item, acc));
    return acc;
  }
  if (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number"
  ) {
    return acc;
  }
  if (typeof node.type === "function") {
    return flattenRenderedNodes(node.type(node.props || {}), acc);
  }
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    statusText: init.statusText || "",
    async json() {
      return body;
    },
  };
}

test("buildInitialRunSessionDraft defaults tracked Codex launches to Codex App Server", () => {
  assert.deepEqual(
    buildInitialRunSessionDraft({
      projectSlug: "llm-tracker",
      taskId: "sh-3-09",
      source: "task_card",
      expectedTrackerRev: 315,
    }),
    {
      source: "task_card",
      mode: "task_backed",
      projectSlug: "llm-tracker",
      taskId: "sh-3-09",
      taskLocked: true,
      runtime: "codex_app_server",
      providerId: "codex_app_server",
      profileId: "code-implementer",
      sandbox: "workspace-write",
      claimMode: "fail_if_active",
      refreshContext: true,
      expectedTrackerRev: 315,
    },
  );
});

test("buildInitialRunSessionDraft lets candidate reselection replace the previous task", () => {
  assert.deepEqual(
    buildInitialRunSessionDraft({
      taskId: "old-task",
      candidate: { taskId: "new-task" },
      source: "hub_run",
      taskLocked: false,
    }),
    {
      source: "hub_run",
      mode: "task_backed",
      taskId: "new-task",
      taskLocked: false,
      runtime: "codex_app_server",
      providerId: "codex_app_server",
      profileId: "code-implementer",
      sandbox: "workspace-write",
      claimMode: "fail_if_active",
      refreshContext: true,
    },
  );
});

test("buildInitialRunSessionDraft keeps manual runtime providerless by default", () => {
  assert.equal(
    buildInitialRunSessionDraft({ runtime: "manual" }).providerId,
    null,
  );
});

test("buildRunSessionDraftPatch strips immutable draft fields before PATCH", () => {
  assert.deepEqual(
    buildRunSessionDraftPatch({
      id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: "2026-05-26T00:00:00.000Z",
      expiresAt: "2026-05-26T00:30:00.000Z",
      projectSlug: "demo",
      runtime: "codex_app_server",
    }),
    {
      projectSlug: "demo",
      runtime: "codex_app_server",
    },
  );
});

test("normalizeRunCandidates filters malformed candidates but preserves rev", () => {
  assert.deepEqual(
    normalizeRunCandidates({
      candidates: [{ taskId: "t2", score: 9 }, null, { taskId: "" }, { score: 1 }],
      projectSlug: "demo",
      laneId: "lane-a",
      rev: 12,
    }),
    {
      candidates: [{ taskId: "t2", score: 9 }],
      projectSlug: "demo",
      laneId: "lane-a",
      rev: 12,
    },
  );
});

test("high severity preflight warnings block launch with a concrete reason", () => {
  const warnings = [
    { kind: "provider_unavailable", providerId: "codex_app_server", severity: "high" },
  ];
  assert.equal(hasUnresolvedHighWarnings(warnings), true);
  assert.equal(
    launchDisabledReasonFor({ draft: { id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa" }, warnings }),
    "Resolve high severity preflight warnings",
  );
});

test("buildRunSessionCliCommand renders the launch brief command", () => {
  assert.equal(
    buildRunSessionCliCommand({
      projectSlug: "demo",
      mode: "task_backed",
      taskId: "t1",
      profileId: "code-implementer",
      providerId: "codex_app_server",
      model: "gpt 5",
      sandbox: "workspace-write",
      worktreePath: "/tmp/demo worktree",
      branch: "feature/run-session",
      claimMode: "fail_if_active",
      refreshContext: true,
    }),
    "llm-tracker run session --project demo --task t1 --profile code-implementer --adapter codex-app-server --model 'gpt 5' --sandbox workspace-write --worktree '/tmp/demo worktree' --branch feature/run-session --claim-mode fail-if-active --refresh-context",
  );
});

test("buildRunSessionCopyPrompt materializes draft fields and CLI for clipboard", () => {
  const { cli, prompt } = buildRunSessionCopyPrompt({
    id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
    source: "task_card",
    mode: "task_backed",
    projectSlug: "demo",
    taskId: "t1",
    profileId: "code-implementer",
    providerId: "codex_app_server",
    runtime: "codex_app_server",
    sandbox: "workspace-write",
    claimMode: "fail_if_active",
    refreshContext: true,
  }, {
    rev: 12,
    task: { title: "Implement launch brief", status: "not_started" },
  });

  assert.match(cli, /llm-tracker run session --project demo --task t1/);
  assert.match(prompt, /CLI equivalent:\nllm-tracker run session/);
  assert.match(prompt, /- Draft: draft_aaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(prompt, /- Project: demo/);
  assert.match(prompt, /- Task: t1/);
  assert.match(prompt, /- Task title: Implement launch brief/);
  assert.match(prompt, /- Start rev: 12/);
  assert.match(prompt, /- Refresh context: yes/);
});

test("RunSessionWizardView renders task, runtime, preflight severity, and disabled launch", () => {
  const vnode = RunSessionWizardView({
    draft: {
      id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      source: "task_card",
      mode: "task_backed",
      taskId: "sh-3-09",
      taskLocked: true,
      runtime: "codex_app_server",
      providerId: "codex_app_server",
      profileId: "code-implementer",
      sandbox: "workspace-write",
      warnings: [
        { kind: "provider_unavailable", providerId: "codex_app_server", severity: "high" },
      ],
    },
  });
  const renderedText = collectVNodeText(vnode);
  assert.match(renderedText, /sh-3-09/);
  assert.match(renderedText, /codex_app_server/);
  assert.match(renderedText, /llm-tracker run session --task sh-3-09/);
  assert.match(renderedText, /provider_unavailable/);
  assert.match(renderedText, /Resolve high severity preflight warnings/);
  const buttons = flattenRenderedNodes(vnode).filter((node) => node.type === "button");
  const launch = buttons.find((button) => collectVNodeText(button).includes("[LAUNCH]"));
  assert.equal(launch.props.disabled, true);
  const copyPrompt = buttons.find((button) => collectVNodeText(button).includes("[COPY PROMPT]"));
  assert.equal(copyPrompt.props.disabled, false);
});

test("RunSessionWizardView orders preflight warnings by severity", () => {
  const vnode = RunSessionWizardView({
    draft: {
      id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
      mode: "task_backed",
      taskId: "sh-3-09",
      warnings: [
        { kind: "verify_pack_empty", severity: "medium" },
        { kind: "context_injection_unsupported", severity: "low" },
        { kind: "provider_unavailable", providerId: "codex_app_server", severity: "high" },
      ],
    },
  });
  const severities = flattenRenderedNodes(vnode)
    .filter((node) => node.type === "li")
    .map((node) => node.props["data-severity"]);
  assert.deepEqual(severities, ["high", "medium", "low"]);
});

test("RunSessionWizard API helpers call the real run-session endpoint contract", async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith("/api/run-candidates")) {
      return jsonResponse({ candidates: [{ taskId: "t1", score: 42 }], projectSlug: "demo", rev: 7 });
    }
    if (url === "/api/run-session/draft") {
      return jsonResponse({
        draft: {
          id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
          ...JSON.parse(options.body),
          warnings: [],
        },
      });
    }
    if (url === "/api/run-session/drafts/draft_aaaaaaaaaaaaaaaaaaaaaaaa") {
      return jsonResponse({
        draft: {
          id: "draft_aaaaaaaaaaaaaaaaaaaaaaaa",
          ...JSON.parse(options.body),
          warnings: [{ kind: "verify_pack_empty", severity: "medium" }],
        },
      });
    }
    if (url === "/api/run-session/launch") {
      return jsonResponse({ mode: "created", sessionId: "ses_a", jobId: "job_a" });
    }
    if (url === "/api/run-session/draft/draft_aaaaaaaaaaaaaaaaaaaaaaaa/copy-prompt") {
      return jsonResponse({ draftId: "draft_aaaaaaaaaaaaaaaaaaaaaaaa", cli: "llm-tracker run session", prompt: "ready" });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const candidates = await fetchRunCandidates({ projectSlug: "demo", fetcher });
  assert.equal(candidates.candidates[0].taskId, "t1");

  const draft = await createRunSessionDraft({
    fetcher,
    draft: buildInitialRunSessionDraft({ taskId: "t1", expectedTrackerRev: candidates.rev }),
  });
  assert.equal(draft.runtime, "codex_app_server");
  assert.equal(draft.providerId, "codex_app_server");

  const patched = await patchRunSessionDraft({
    fetcher,
    draftId: draft.id,
    patch: { runtime: "mcp_tracked", providerId: "codex_cli" },
  });
  assert.equal(patched.warnings[0].severity, "medium");

  const launch = await launchRunSessionDraft({ fetcher, draft });
  assert.equal(launch.mode, "created");

  const copied = await copyRunSessionPrompt({ fetcher, draftId: draft.id });
  assert.equal(copied.prompt, "ready");

  assert.deepEqual(
    calls.map((call) => [call.url, call.options.method || "GET"]),
    [
      ["/api/run-candidates?projectSlug=demo", "GET"],
      ["/api/run-session/draft", "POST"],
      ["/api/run-session/drafts/draft_aaaaaaaaaaaaaaaaaaaaaaaa", "PATCH"],
      ["/api/run-session/launch", "POST"],
      ["/api/run-session/draft/draft_aaaaaaaaaaaaaaaaaaaaaaaa/copy-prompt", "POST"],
    ],
  );
});
