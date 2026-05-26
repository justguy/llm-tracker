import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";

const DEFAULT_RUNTIME = "codex_app_server";
const DEFAULT_PROFILE = "code-implementer";
const DEFAULT_SANDBOX = "workspace-write";
const DEFAULT_CLAIM_MODE = "fail_if_active";

export const RUN_SESSION_RUNTIME_OPTIONS = Object.freeze([
  {
    id: "codex_app_server",
    label: "Codex App Server",
    providerId: "codex_app_server",
  },
  {
    id: "mcp_tracked",
    label: "MCP tracked",
    providerId: "codex_cli",
  },
  {
    id: "dumb_terminal",
    label: "Dumb terminal",
    providerId: "codex_cli",
  },
  {
    id: "manual",
    label: "Manual",
    providerId: null,
  },
]);

export const RUN_SESSION_PROFILE_OPTIONS = Object.freeze([
  { id: "code-implementer", label: "Code implementer" },
  { id: "reviewer", label: "Reviewer" },
  { id: "planner", label: "Planner" },
  { id: "prd-writer", label: "PRD writer" },
  { id: "closeout", label: "Closeout" },
]);

export const RUN_SESSION_SANDBOX_OPTIONS = Object.freeze([
  { id: "readonly", label: "Readonly" },
  { id: "workspace-write", label: "Workspace write" },
  { id: "autoedit", label: "Autoedit" },
  { id: "full-auto", label: "Full auto" },
]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function nonEmpty(value) {
  const s = text(value).trim();
  return s.length > 0 ? s : null;
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseApiError(body, response) {
  return (
    body?.error?.message ||
    body?.error ||
    response?.statusText ||
    "request failed"
  );
}

async function parseJsonBody(response) {
  return response.json().catch(() => ({}));
}

function runtimeOption(runtime) {
  return RUN_SESSION_RUNTIME_OPTIONS.find((option) => option.id === runtime) || RUN_SESSION_RUNTIME_OPTIONS[0];
}

function providerForRuntime(runtime) {
  const option = runtimeOption(runtime);
  return option.providerId;
}

export function buildInitialRunSessionDraft(input = {}) {
  const selectedCandidate = isRecord(input.candidate) ? input.candidate : null;
  const taskId = nonEmpty(selectedCandidate?.taskId) || nonEmpty(input.taskId);
  const source = nonEmpty(input.source) || (taskId ? "task_card" : "hub_run");
  const mode = nonEmpty(input.mode) || (taskId ? "task_backed" : "untasked");
  const runtime = nonEmpty(input.runtime) || DEFAULT_RUNTIME;
  const providerId =
    input.providerId === null
      ? null
      : nonEmpty(input.providerId) || providerForRuntime(runtime);
  const projectSlug = nonEmpty(input.projectSlug);

  const draft = {
    source,
    mode,
    taskLocked: Boolean(input.taskLocked ?? (source === "task_card" && taskId)),
    runtime,
    providerId,
    profileId: nonEmpty(input.profileId) || DEFAULT_PROFILE,
    sandbox: nonEmpty(input.sandbox) || DEFAULT_SANDBOX,
    claimMode: nonEmpty(input.claimMode) || DEFAULT_CLAIM_MODE,
    refreshContext: input.refreshContext !== false,
  };

  if (projectSlug) draft.projectSlug = projectSlug;
  if (mode === "task_backed") draft.taskId = taskId;
  if (Number.isInteger(input.expectedTrackerRev) && input.expectedTrackerRev >= 0) {
    draft.expectedTrackerRev = input.expectedTrackerRev;
  }
  const model = nonEmpty(input.model);
  if (model) draft.model = model;
  const worktreePath = nonEmpty(input.worktreePath);
  if (worktreePath) draft.worktreePath = worktreePath;
  const branch = nonEmpty(input.branch);
  if (branch) draft.branch = branch;

  return draft;
}

export function buildRunSessionDraftPatch(draft = {}) {
  const { id: _id, createdAt: _createdAt, expiresAt: _expiresAt, ...patch } = draft || {};
  return patch;
}

export function normalizeRunCandidates(body = {}) {
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.filter((candidate) => isRecord(candidate) && nonEmpty(candidate.taskId))
    : [];
  return {
    candidates,
    projectSlug: nonEmpty(body.projectSlug),
    laneId: nonEmpty(body.laneId),
    rev: Number.isInteger(body.rev) ? body.rev : null,
  };
}

export function hasUnresolvedHighWarnings(warnings = []) {
  return Array.isArray(warnings)
    ? warnings.some((warning) => warning?.severity === "high" && warning?.resolved !== true)
    : false;
}

export function launchDisabledReasonFor({ draft, warnings = [], loading = false, saving = false } = {}) {
  if (loading) return "Loading draft";
  if (saving) return "Launch in progress";
  if (!draft?.id) return "Create a draft before launch";
  if (hasUnresolvedHighWarnings(warnings)) return "Resolve high severity preflight warnings";
  return null;
}

export async function fetchRunCandidates({ projectSlug, laneId, fetcher = globalThis.fetch } = {}) {
  const slug = nonEmpty(projectSlug);
  if (!slug) return normalizeRunCandidates();
  const params = new URLSearchParams({ projectSlug: slug });
  const lane = nonEmpty(laneId);
  if (lane) params.set("laneId", lane);
  const response = await fetcher(`/api/run-candidates?${params.toString()}`);
  const body = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(body, response));
  return normalizeRunCandidates(body);
}

export async function createRunSessionDraft({ draft, fetcher = globalThis.fetch } = {}) {
  const response = await fetcher("/api/run-session/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const body = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(body, response));
  return body.draft;
}

export async function patchRunSessionDraft({ draftId, patch, fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(`/api/run-session/drafts/${encodeURIComponent(draftId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(body, response));
  return body.draft;
}

export async function launchRunSessionDraft({ draft, fetcher = globalThis.fetch } = {}) {
  const body = {
    draftId: draft?.id,
    ...(Number.isInteger(draft?.expectedTrackerRev) ? { expectedTrackerRev: draft.expectedTrackerRev } : {}),
    ...(nonEmpty(draft?.claimMode) ? { claimMode: draft.claimMode } : {}),
  };
  const response = await fetcher("/api/run-session/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await parseJsonBody(response);
  if (!response.ok) throw new Error(parseApiError(payload, response));
  return payload;
}

function warningSummary(warning) {
  if (!warning || typeof warning !== "object") return "unknown warning";
  switch (warning.kind) {
    case "provider_unavailable":
      return `provider unavailable: ${warning.providerId}`;
    case "capability_mismatch":
      return `capability mismatch: ${warning.requiredCap}`;
    case "sandbox_disallowed":
      return `sandbox disallowed: ${warning.sandbox}`;
    case "task_already_has_active_job":
      return `active job: ${warning.jobId}`;
    case "task_already_bound_other_session":
      return `bound to ${warning.otherSessionId}`;
    case "attach_context_overflow":
      return `context ${warning.currentUsed}+${warning.estBriefTokens}/${warning.capacity}`;
    case "shared_worktree":
      return `shared worktree: ${warning.worktreePath}`;
    case "dependencies_not_satisfied":
      return `blocked by ${Array.isArray(warning.dependencyTaskIds) ? warning.dependencyTaskIds.join(", ") : "dependencies"}`;
    case "missing_repo_metadata":
      return "missing repo metadata";
    case "verify_pack_empty":
      return "verify pack empty";
    case "context_injection_unsupported":
      return "context injection unsupported";
    default:
      return text(warning.kind) || "unknown warning";
  }
}

function selectedTaskId(draft) {
  return draft?.mode === "task_backed" ? nonEmpty(draft.taskId) : null;
}

function sortedCandidates(candidates) {
  return Array.isArray(candidates)
    ? candidates.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    : [];
}

function sortedWarnings(warnings) {
  const weights = { high: 0, medium: 1, low: 2 };
  return Array.isArray(warnings)
    ? warnings.slice().sort((a, b) => (weights[a?.severity] ?? 3) - (weights[b?.severity] ?? 3))
    : [];
}

export function RunSessionWizardView({
  draft = {},
  candidates = [],
  loading = false,
  saving = false,
  error = null,
  launchResult = null,
  onSelectCandidate,
  onDraftChange,
  onSaveDraft,
  onLaunch,
} = {}) {
  const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  const highWarnings = hasUnresolvedHighWarnings(warnings);
  const launchDisabledReason = launchDisabledReasonFor({ draft, warnings, loading, saving });
  const taskId = selectedTaskId(draft);
  const options = sortedCandidates(candidates);
  const orderedWarnings = sortedWarnings(warnings);

  return html`
    <section class="run-session-wizard" aria-label="Run session">
      <header class="run-session-wizard__header">
        <div>
          <span class="brand">[RUN SESSION]</span>
          <h2 class="run-session-wizard__title">${taskId || "New session"}</h2>
        </div>
        <div class="run-session-wizard__state" data-ready=${launchDisabledReason ? "false" : "true"}>
          ${launchDisabledReason || "Ready"}
        </div>
      </header>

      <div class="run-session-wizard__steps" role="list" aria-label="Run session steps">
        ${["Task", "Runtime", "Preflight"].map((step, index) => html`
          <div
            key=${step}
            class=${`run-session-wizard__step ${index === 0 || (index === 1 && taskId) || (index === 2 && draft.id) ? "run-session-wizard__step--active" : ""}`}
            role="listitem"
          >
            <span>${index + 1}</span>
            ${step}
          </div>
        `)}
      </div>

      <div class="run-session-wizard__body">
        <section class="run-session-wizard__panel">
          <div class="run-session-wizard__panel-head">
            <h3>Task</h3>
            ${draft.taskLocked ? html`<span class="run-session-wizard__badge">locked</span>` : null}
          </div>
          ${draft.taskLocked
            ? html`<div class="run-session-wizard__locked-task">${taskId || "No task"}</div>`
            : html`
                <div class="run-session-wizard__candidate-list" role="list">
                  ${options.length === 0
                    ? html`<div class="run-session-wizard__empty">${loading ? "Loading" : "No candidates"}</div>`
                    : options.map((candidate) => html`
                        <button
                          key=${candidate.taskId}
                          class=${`run-session-wizard__candidate ${candidate.taskId === taskId ? "run-session-wizard__candidate--selected" : ""}`}
                          type="button"
                          onClick=${() => onSelectCandidate?.(candidate)}
                        >
                          <span>${candidate.taskId}</span>
                          <strong>${candidate.score ?? 0}</strong>
                        </button>
                      `)}
                </div>
              `}
        </section>

        <section class="run-session-wizard__panel run-session-wizard__panel--settings">
          <div class="run-session-wizard__panel-head">
            <h3>Profile and runtime</h3>
            <span class="run-session-wizard__badge run-session-wizard__badge--runtime">${draft.runtime || DEFAULT_RUNTIME}</span>
          </div>
          <label>
            <span>Profile</span>
            <select
              value=${draft.profileId || DEFAULT_PROFILE}
              onChange=${(event) => onDraftChange?.({ profileId: event.currentTarget.value })}
            >
              ${RUN_SESSION_PROFILE_OPTIONS.map((option) => html`
                <option key=${option.id} value=${option.id}>${option.label}</option>
              `)}
            </select>
          </label>
          <label>
            <span>Runtime</span>
            <select
              value=${draft.runtime || DEFAULT_RUNTIME}
              onChange=${(event) => {
                const runtime = event.currentTarget.value;
                onDraftChange?.({ runtime, providerId: providerForRuntime(runtime) });
              }}
            >
              ${RUN_SESSION_RUNTIME_OPTIONS.map((option) => html`
                <option key=${option.id} value=${option.id}>${option.label}</option>
              `)}
            </select>
          </label>
          <label>
            <span>Provider</span>
            <input
              class="text-input"
              value=${draft.providerId || ""}
              placeholder="manual"
              onInput=${(event) => onDraftChange?.({ providerId: event.currentTarget.value || null })}
            />
          </label>
          <label>
            <span>Model</span>
            <input
              class="text-input"
              value=${draft.model || ""}
              placeholder="provider default"
              onInput=${(event) => onDraftChange?.({ model: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>Sandbox</span>
            <select
              value=${draft.sandbox || DEFAULT_SANDBOX}
              onChange=${(event) => onDraftChange?.({ sandbox: event.currentTarget.value })}
            >
              ${RUN_SESSION_SANDBOX_OPTIONS.map((option) => html`
                <option key=${option.id} value=${option.id}>${option.label}</option>
              `)}
            </select>
          </label>
        </section>

        <section class="run-session-wizard__panel run-session-wizard__panel--preflight">
          <div class="run-session-wizard__panel-head">
            <h3>Preflight</h3>
            <span class=${`run-session-wizard__badge ${highWarnings ? "run-session-wizard__badge--high" : ""}`}>
              ${warnings.length}
            </span>
          </div>
          ${warnings.length === 0
            ? html`<div class="run-session-wizard__empty">No warnings</div>`
            : html`
                <ul class="run-session-wizard__warnings">
                  ${orderedWarnings.map((warning, index) => html`
                    <li key=${`${warning.kind || "warning"}-${index}`} data-severity=${warning.severity || "low"}>
                      <span>${warning.severity || "low"}</span>
                      <strong>${warning.kind || "warning"}</strong>
                      <em>${warningSummary(warning)}</em>
                    </li>
                  `)}
                </ul>
              `}
          ${draft.id ? html`<div class="run-session-wizard__draft-id">${draft.id}</div>` : null}
        </section>
      </div>

      ${error ? html`<div class="run-session-wizard__error" role="alert">${error}</div>` : null}
      ${launchResult ? html`<div class="run-session-wizard__result" role="status">${launchResult.mode || "launched"}</div>` : null}

      <footer class="run-session-wizard__actions">
        <button class="icon-btn" type="button" disabled=${saving} onClick=${onSaveDraft}>
          ${draft.id ? "[REFRESH]" : "[CREATE DRAFT]"}
        </button>
        <button
          class="icon-btn active"
          type="button"
          disabled=${Boolean(launchDisabledReason)}
          title=${launchDisabledReason || "Launch"}
          onClick=${onLaunch}
        >
          ${saving ? "[LAUNCHING]" : "[LAUNCH]"}
        </button>
      </footer>
    </section>
  `;
}

export function RunSessionWizard({
  projectSlug = "",
  laneId = "",
  taskId = "",
  source = "task_card",
  taskLocked = Boolean(taskId),
  initialDraft = null,
  fetcher = globalThis.fetch,
  onLaunch,
  onDraft,
} = {}) {
  const baseDraft = useMemo(
    () => buildInitialRunSessionDraft({
      ...initialDraft,
      projectSlug,
      laneId,
      taskId,
      source,
      taskLocked,
    }),
    [initialDraft, laneId, projectSlug, source, taskId, taskLocked],
  );
  const [draft, setDraft] = useState(baseDraft);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [launchResult, setLaunchResult] = useState(null);

  useEffect(() => {
    setDraft(baseDraft);
    setLaunchResult(null);
    setError(null);
  }, [baseDraft]);

  useEffect(() => {
    let cancelled = false;
    if (!nonEmpty(projectSlug) || taskLocked) {
      setCandidates([]);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    fetchRunCandidates({ projectSlug, laneId, fetcher })
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        setDraft((prev) => ({
          ...prev,
          ...(Number.isInteger(result.rev) ? { expectedTrackerRev: result.rev } : {}),
        }));
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "candidate load failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, laneId, projectSlug, taskLocked]);

  const saveDraft = async () => {
    setSaving(true);
    setError(null);
    try {
      const nextDraft = draft.id
        ? await patchRunSessionDraft({ draftId: draft.id, patch: buildRunSessionDraftPatch(draft), fetcher })
        : await createRunSessionDraft({ draft, fetcher });
      setDraft(nextDraft);
      onDraft?.(nextDraft);
    } catch (err) {
      setError(err?.message || "draft save failed");
    }
    setSaving(false);
  };

  const launch = async () => {
    const reason = launchDisabledReasonFor({ draft, warnings: draft.warnings, loading, saving });
    if (reason) {
      setError(reason);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await launchRunSessionDraft({ draft, fetcher });
      setLaunchResult(result);
      onLaunch?.(result);
    } catch (err) {
      setError(err?.message || "launch failed");
    }
    setSaving(false);
  };

  return html`
    <${RunSessionWizardView}
      draft=${draft}
      candidates=${candidates}
      loading=${loading}
      saving=${saving}
      error=${error}
      launchResult=${launchResult}
      onSelectCandidate=${(candidate) => {
        setDraft((prev) => buildInitialRunSessionDraft({ ...prev, candidate, source: "hub_run", taskLocked: false }));
      }}
      onDraftChange=${(patch) => {
        setDraft((prev) => ({ ...prev, ...patch, id: prev.id, createdAt: prev.createdAt, expiresAt: prev.expiresAt }));
      }}
      onSaveDraft=${saveDraft}
      onLaunch=${launch}
    />
  `;
}
