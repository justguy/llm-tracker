import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";

function text(value) {
  return typeof value === "string" ? value : "";
}

function nonEmpty(value) {
  const s = text(value).trim();
  return s.length > 0 ? s : null;
}

export function inferAttachPathsFromProjectFile(file) {
  const path = text(file);
  const marker = "/.llm-tracker/trackers/";
  const index = path.indexOf(marker);
  if (index > 0) {
    const repoRoot = path.slice(0, index);
    return { cwd: repoRoot, repoRoot, worktreePath: repoRoot };
  }
  const slash = path.lastIndexOf("/");
  return { cwd: slash > 0 ? path.slice(0, slash) : "", repoRoot: "", worktreePath: "" };
}

export function buildAttachSessionRequest(draft = {}) {
  const projectSlug = nonEmpty(draft.projectSlug);
  const taskId = nonEmpty(draft.taskId);
  const agent = nonEmpty(draft.agent) || "codex";
  const cwd = nonEmpty(draft.cwd);
  const payload = {
    name: `${agent}:${projectSlug}/${taskId}`,
    tier: "manual",
    projectSlug,
    taskId,
    agent,
    cwd,
  };
  const repoRoot = nonEmpty(draft.repoRoot);
  const worktreePath = nonEmpty(draft.worktreePath);
  if (repoRoot) payload.repoRoot = repoRoot;
  if (worktreePath) payload.worktreePath = worktreePath;
  return payload;
}

export function validateAttachDraft(draft = {}) {
  if (!nonEmpty(draft.projectSlug)) return "project is required";
  if (!nonEmpty(draft.taskId)) return "task is required";
  if (!nonEmpty(draft.agent)) return "agent is required";
  if (!nonEmpty(draft.cwd)) return "cwd is required";
  return null;
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function mcpCommand({ workspacePath } = {}) {
  const parts = ["llm-tracker", "mcp"];
  if (workspacePath) parts.push("--path", shellQuote(workspacePath));
  return parts.join(" ");
}

export function attachContractText({ session, token, workspacePath } = {}) {
  const sessionId = session?.id || "";
  const jobId = session?.activeJobId || "";
  return [
    `export LT_SESSION_ID='${sessionId}'`,
    `export LT_JOB_ID='${jobId}'`,
    `export LT_SESSION_TOKEN='${token || ""}'`,
    "export LT_MCP_URL='stdio://llm-tracker-mcp'",
    `export LT_MCP_COMMAND=${shellQuote(mcpCommand({ workspacePath }))}`,
  ].join("\n");
}

export function AttachDialogView({
  draft = {},
  error = null,
  result = null,
  saving = false,
  onDraftChange,
  onSubmit,
  onClose,
} = {}) {
  const repoKnown = !!nonEmpty(draft.repoRoot);
  return html`
    <div class="modal-overlay attach-dialog-overlay" onClick=${onClose}>
      <form
        class="modal attach-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Attach session"
        onClick=${(e) => e.stopPropagation()}
        onSubmit=${(e) => {
          e.preventDefault();
          if (typeof onSubmit === "function") onSubmit();
        }}
      >
        <div class="modal-header">
          <span class="brand">[ATTACH SESSION]</span>
          <button class="icon-btn" type="button" aria-label="Close dialog" onClick=${onClose} title="Close">×</button>
        </div>
        <div class="modal-body attach-dialog__body">
          <section class="attach-dialog__grid">
            <label>
              <span>Project</span>
              <input
                class="text-input"
                value=${text(draft.projectSlug)}
                onInput=${(e) => onDraftChange?.({ projectSlug: e.currentTarget.value })}
              />
            </label>
            <label>
              <span>Task</span>
              <input
                class="text-input"
                value=${text(draft.taskId)}
                onInput=${(e) => onDraftChange?.({ taskId: e.currentTarget.value })}
              />
            </label>
            <label>
              <span>Agent</span>
              <input
                class="text-input"
                value=${text(draft.agent)}
                onInput=${(e) => onDraftChange?.({ agent: e.currentTarget.value })}
              />
            </label>
            <label class="attach-dialog__wide">
              <span>CWD</span>
              <input class="text-input" value=${text(draft.cwd)} readonly readOnly />
            </label>
            <label class="attach-dialog__wide">
              <span>Repo root</span>
              <input
                class="text-input"
                value=${text(draft.repoRoot)}
                placeholder="repo unknown"
                onInput=${(e) => onDraftChange?.({ repoRoot: e.currentTarget.value })}
              />
            </label>
            <label class="attach-dialog__wide">
              <span>Worktree path</span>
              <input
                class="text-input"
                value=${text(draft.worktreePath)}
                onInput=${(e) => onDraftChange?.({ worktreePath: e.currentTarget.value })}
              />
            </label>
          </section>
          <div class=${`attach-dialog__repo ${repoKnown ? "attach-dialog__repo--known" : "attach-dialog__repo--unknown"}`}>
            ${repoKnown ? text(draft.repoRoot) : "repo unknown"}
          </div>
          ${error ? html`<div class="attach-dialog__error" role="alert">${error}</div>` : null}
          ${result
            ? html`
                <pre class="attach-dialog__contract">${result.contract}</pre>
              `
            : null}
          <div class="attach-dialog__actions">
            <button class="icon-btn" type="button" onClick=${onClose}>[CANCEL]</button>
            <button class="icon-btn active" type="submit" disabled=${saving}>
              ${saving ? "[ATTACHING]" : "[ATTACH]"}
            </button>
          </div>
        </div>
      </form>
    </div>
  `;
}

export function AttachDialog({
  open = false,
  projectSlug = "",
  taskId = "",
  agent = "codex",
  projectFile = "",
  workspacePath = "",
  fetcher = globalThis.fetch,
  onAttached,
  onClose,
} = {}) {
  const inferred = useMemo(() => inferAttachPathsFromProjectFile(projectFile), [projectFile]);
  const [draft, setDraft] = useState(() => ({
    projectSlug,
    taskId,
    agent,
    cwd: inferred.cwd,
    repoRoot: inferred.repoRoot,
    worktreePath: inferred.worktreePath,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDraft({
      projectSlug,
      taskId,
      agent,
      cwd: inferred.cwd,
      repoRoot: inferred.repoRoot,
      worktreePath: inferred.worktreePath,
    });
    setSaving(false);
    setError(null);
    setResult(null);
  }, [open, projectSlug, taskId, agent, inferred.cwd, inferred.repoRoot, inferred.worktreePath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    const validation = validateAttachDraft(draft);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetcher("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAttachSessionRequest(draft)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error?.message || body?.error || response.statusText || "attach failed");
        setSaving(false);
        return;
      }
      const contract = attachContractText({ session: body.session, token: body.token?.token, workspacePath });
      const nextResult = { ...body, contract };
      setResult(nextResult);
      onAttached?.(body);
    } catch (err) {
      setError(err?.message || "attach failed");
    }
    setSaving(false);
  };

  return html`
    <${AttachDialogView}
      draft=${draft}
      error=${error}
      result=${result}
      saving=${saving}
      onDraftChange=${(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
      onSubmit=${submit}
      onClose=${onClose}
    />
  `;
}
