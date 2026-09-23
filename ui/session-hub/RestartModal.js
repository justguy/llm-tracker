import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

const SANDBOXES = Object.freeze(["readonly", "workspace-write", "autoedit", "full-auto"]);

function text(value) {
  return typeof value === "string" ? value : "";
}

export function buildRestartRequest({ preset, model, keepCtx = true, sandbox, reason } = {}) {
  const payload = { preset, keepCtx };
  if (preset === "model") payload.model = text(model).trim();
  if (preset === "sandbox") payload.sandbox = text(sandbox).trim();
  const rationale = text(reason).trim();
  if (rationale) payload.reason = rationale;
  return payload;
}

export function validateRestartRequest(payload = {}) {
  if (payload.preset === "model") {
    if (!text(payload.model).trim()) return "model is required";
    return null;
  }
  if (payload.preset === "sandbox") {
    if (!SANDBOXES.includes(payload.sandbox)) return "sandbox is required";
    return null;
  }
  return "restart preset is required";
}

export function buildRestartQuietRequest({ dryRun = false, reason } = {}) {
  const payload = { dryRun: Boolean(dryRun) };
  const rationale = text(reason).trim();
  if (rationale) payload.reason = rationale;
  return payload;
}

export function validateRestartQuietRequest(payload = {}) {
  if (typeof payload.dryRun !== "boolean") return "dry run flag is required";
  return null;
}

export function RestartModalView({
  session = {},
  draft = {},
  saving = false,
  error = null,
  result = null,
  onDraftChange,
  onSubmit,
  onClose,
} = {}) {
  const preset = draft.preset || "model";
  return html`
    <div class="modal-overlay restart-modal-overlay" onClick=${onClose}>
      <form
        class="modal restart-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Restart session"
        onClick=${(event) => event.stopPropagation()}
        onSubmit=${(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <div class="modal-header">
          <span class="brand">[RESTART SESSION]</span>
          <button class="icon-btn" type="button" aria-label="Close dialog" onClick=${onClose} title="Close">×</button>
        </div>
        <div class="modal-body restart-modal__body">
          <div class="restart-modal__session">${text(session.name) || text(session.id)}</div>
          <div class="restart-modal__tabs" role="tablist" aria-label="Restart mode">
            <button
              class=${`restart-modal__tab ${preset === "model" ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected=${preset === "model"}
              onClick=${() => onDraftChange?.({ preset: "model" })}
            >
              Restart with new model
            </button>
            <button
              class=${`restart-modal__tab ${preset === "sandbox" ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected=${preset === "sandbox"}
              onClick=${() => onDraftChange?.({ preset: "sandbox" })}
            >
              Restart with stricter sandbox
            </button>
          </div>
          ${preset === "model"
            ? html`
                <label class="restart-modal__field">
                  <span>Model</span>
                  <input
                    class="text-input"
                    value=${text(draft.model)}
                    onInput=${(event) => onDraftChange?.({ model: event.currentTarget.value })}
                  />
                </label>
                <label class="restart-modal__check">
                  <input
                    type="checkbox"
                    checked=${draft.keepCtx !== false}
                    onInput=${(event) => onDraftChange?.({ keepCtx: event.currentTarget.checked })}
                  />
                  <span>Keep context pack</span>
                </label>
              `
            : html`
                <label class="restart-modal__field">
                  <span>Sandbox</span>
                  <select
                    class="text-input"
                    value=${text(draft.sandbox) || "readonly"}
                    onInput=${(event) => onDraftChange?.({ sandbox: event.currentTarget.value })}
                  >
                    ${SANDBOXES.map((sandbox) => html`<option value=${sandbox}>${sandbox}</option>`)}
                  </select>
                </label>
                <div class="restart-modal__notice">Pending approvals are not carried over.</div>
              `}
          <label class="restart-modal__field">
            <span>Reason</span>
            <input
              class="text-input"
              value=${text(draft.reason)}
              onInput=${(event) => onDraftChange?.({ reason: event.currentTarget.value })}
            />
          </label>
          ${error ? html`<div class="restart-modal__error" role="alert">${error}</div>` : null}
          ${result ? html`<div class="restart-modal__result">${text(result.successorSessionId)}</div>` : null}
          <div class="restart-modal__actions">
            <button class="icon-btn" type="button" onClick=${onClose}>[CANCEL]</button>
            <button class="icon-btn active" type="submit" disabled=${saving}>
              ${saving ? "[RESTARTING]" : "[RESTART]"}
            </button>
          </div>
        </div>
      </form>
    </div>
  `;
}

export function RestartQuietScopePanelView({
  draft = {},
  saving = false,
  error = null,
  result = null,
  onDraftChange,
  onDryRun,
  onSubmit,
} = {}) {
  const affectedCount = Array.isArray(result?.affected) ? result.affected.length : null;
  const restartedCount = Array.isArray(result?.restarted) ? result.restarted.length : null;
  return html`
    <section class="restart-modal__scope" aria-label="Restart quiet sessions">
      <div class="restart-modal__scope-head">
        <span>Restart all quiet terminal sessions</span>
        ${affectedCount !== null
          ? html`<strong>${result?.dryRun ? affectedCount : restartedCount} matched</strong>`
          : null}
      </div>
      <label class="restart-modal__field">
        <span>Reason</span>
        <input
          class="text-input"
          value=${text(draft.reason)}
          onInput=${(event) => onDraftChange?.({ reason: event.currentTarget.value })}
        />
      </label>
      <div class="restart-modal__notice">
        Only sessions with quiet status and quiet_terminal warning are eligible.
      </div>
      ${error ? html`<div class="restart-modal__error" role="alert">${error}</div>` : null}
      ${result
        ? html`
            <div class="restart-modal__result">
              ${result.dryRun
                ? `${affectedCount || 0} sessions would restart.`
                : `${restartedCount || 0} sessions restarted.`}
            </div>
          `
        : null}
      <div class="restart-modal__actions">
        <button class="icon-btn" type="button" disabled=${saving} onClick=${onDryRun}>[DRY RUN]</button>
        <button class="icon-btn active" type="button" disabled=${saving} onClick=${onSubmit}>
          ${saving ? "[RESTARTING]" : "[RESTART QUIET]"}
        </button>
      </div>
    </section>
  `;
}

export function RestartQuietScopePanel({
  fetcher = globalThis.fetch,
  onCompleted,
} = {}) {
  const [draft, setDraft] = useState({ reason: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async (dryRun) => {
    const payload = buildRestartQuietRequest({ ...draft, dryRun });
    const validation = validateRestartQuietRequest(payload);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetcher("/api/sessions/scope/restart-quiet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || `restart quiet failed (${res.status})`);
      setResult(body);
      onCompleted?.(body);
    } catch (err) {
      setError(err?.message || "restart quiet failed");
    } finally {
      setSaving(false);
    }
  };

  return html`
    <${RestartQuietScopePanelView}
      draft=${draft}
      saving=${saving}
      error=${error}
      result=${result}
      onDraftChange=${(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onDryRun=${() => submit(true)}
      onSubmit=${() => submit(false)}
    />
  `;
}

export function RestartModal({
  open = false,
  session = {},
  fetcher = globalThis.fetch,
  onRestarted,
  onClose,
} = {}) {
  const [draft, setDraft] = useState({
    preset: "model",
    model: text(session.model),
    sandbox: "readonly",
    keepCtx: true,
    reason: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDraft({
      preset: "model",
      model: text(session.model),
      sandbox: "readonly",
      keepCtx: true,
      reason: "",
    });
    setSaving(false);
    setError(null);
    setResult(null);
  }, [open, session?.id, session?.model]);

  if (!open) return null;

  const submit = async () => {
    const payload = buildRestartRequest(draft);
    const validation = validateRestartRequest(payload);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetcher(`/api/sessions/${encodeURIComponent(session.id)}/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || `restart failed (${res.status})`);
      setResult(body);
      onRestarted?.(body);
    } catch (err) {
      setError(err?.message || "restart failed");
    } finally {
      setSaving(false);
    }
  };

  return html`
    <${RestartModalView}
      session=${session}
      draft=${draft}
      saving=${saving}
      error=${error}
      result=${result}
      onDraftChange=${(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onSubmit=${submit}
      onClose=${onClose}
    />
  `;
}
