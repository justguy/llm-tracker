import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function rolloverPackTitle(pack = {}) {
  return text(pack.title) || text(pack.kind) || "Rollover pack";
}

export function rolloverPackSections(pack = {}) {
  return asArray(pack.sections).filter(isRecord).map((section, index) => ({
    id: text(section.id) || `section-${index + 1}`,
    title: text(section.title) || text(section.kind) || `Section ${index + 1}`,
    value: section.value ?? section.content ?? section.items ?? "",
  }));
}

export function serializeRolloverPack(pack = {}) {
  if (typeof pack === "string") return pack;
  return JSON.stringify(pack || {}, null, 2);
}

export function buildRolloverLaunchPayload({
  session = {},
  job = {},
  jobId = "",
  pack = {},
  packText = "",
  reason = "",
} = {}) {
  return {
    sessionId: text(session.id) || text(pack.sessionId),
    jobId: text(job.id) || text(jobId) || text(pack.jobId),
    projectSlug: text(session.projectSlug) || text(job.projectSlug) || text(pack.projectSlug),
    taskId: text(session.taskId) || text(job.taskId) || text(pack.taskId),
    reason: text(reason) || "rollover_dialog",
    pack,
    packText,
  };
}

function sectionValueText(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function statusText({ saving, copied, launched }) {
  if (saving) return "working";
  if (launched) return "successor launch requested";
  if (copied) return "copied";
  return "";
}

export function RolloverDialogView({
  session = {},
  job = {},
  jobId = "",
  pack = {},
  packText = serializeRolloverPack(pack),
  reason = "",
  saving = false,
  copied = false,
  launched = false,
  error = null,
  onPackTextChange,
  onReasonChange,
  onCopy,
  onLaunch,
  onClose,
} = {}) {
  const sections = rolloverPackSections(pack);
  const resolvedJobId = text(job.id) || text(jobId) || text(pack.jobId);
  const resolvedSessionId = text(session.id) || text(pack.sessionId);
  const status = statusText({ saving, copied, launched });
  const actionPayload = () =>
    buildRolloverLaunchPayload({ session, job, jobId: resolvedJobId, pack, packText, reason });

  return html`
    <div class="modal-overlay rollover-dialog-overlay" onClick=${onClose}>
      <section
        class="modal rollover-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Rollover session"
        onClick=${(event) => event.stopPropagation()}
      >
        <div class="modal-header">
          <span class="brand">[ROLLOVER]</span>
          <button class="icon-btn" type="button" aria-label="Close dialog" onClick=${onClose} title="Close">x</button>
        </div>

        <div class="modal-body rollover-dialog__body">
          <div class="rollover-dialog__summary">
            <strong>${rolloverPackTitle(pack)}</strong>
            <span>${resolvedSessionId || "session"}</span>
            ${resolvedJobId ? html`<span>${resolvedJobId}</span>` : null}
          </div>

          <div class="rollover-dialog__preview" aria-label="Rollover pack preview">
            ${sections.length > 0
              ? sections.map(
                  (section) => html`
                    <article class="rollover-dialog__section" key=${section.id} data-section-id=${section.id}>
                      <div class="rollover-dialog__section-title">${section.title}</div>
                      <pre class="rollover-dialog__section-value">${sectionValueText(section.value)}</pre>
                    </article>
                  `,
                )
              : html`<div class="rollover-dialog__empty">No pack sections</div>`}
          </div>

          <label class="rollover-dialog__field">
            <span>Editable handoff pack</span>
            <textarea
              class="rollover-dialog__textarea"
              rows="12"
              value=${packText}
              onInput=${(event) => onPackTextChange?.(event.currentTarget.value)}
            />
          </label>

          <label class="rollover-dialog__field">
            <span>Rollover reason</span>
            <input
              class="text-input"
              value=${reason}
              placeholder="rollover_dialog"
              onInput=${(event) => onReasonChange?.(event.currentTarget.value)}
            />
          </label>

          ${error ? html`<div class="rollover-dialog__error" role="alert">${error}</div>` : null}
          ${status ? html`<div class="rollover-dialog__status" role="status">${status}</div>` : null}

          <div class="rollover-dialog__actions">
            <button class="icon-btn" type="button" onClick=${() => onCopy?.(packText, actionPayload())} disabled=${saving}>
              ${copied ? "[COPIED]" : "[COPY]"}
            </button>
            <button class="icon-btn active" type="button" onClick=${() => onLaunch?.(actionPayload())} disabled=${saving}>
              ${saving ? "[LAUNCHING]" : "[LAUNCH SUCCESSOR]"}
            </button>
          </div>
        </div>
      </section>
    </div>
  `;
}

export function RolloverDialog({
  open = false,
  session = {},
  job = {},
  jobId = "",
  pack = {},
  clipboard = globalThis.navigator?.clipboard,
  onCopy,
  onLaunch,
  onClose,
} = {}) {
  const initialText = useMemo(() => serializeRolloverPack(pack), [pack]);
  const [packText, setPackText] = useState(initialText);
  const [reason, setReason] = useState("");
  const [copied, setCopied] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setPackText(initialText);
    setReason("");
    setCopied(false);
    setLaunched(false);
    setSaving(false);
    setError(null);
  }, [open, initialText]);

  if (!open) return null;

  const copy = async (value, payload) => {
    try {
      if (clipboard && typeof clipboard.writeText === "function") await clipboard.writeText(value);
      setCopied(true);
      setError(null);
      onCopy?.(value, payload);
    } catch (err) {
      setError(err?.message || "copy failed");
    }
  };

  const launch = async (payload) => {
    setSaving(true);
    setError(null);
    try {
      await onLaunch?.(payload);
      setLaunched(true);
    } catch (err) {
      setError(err?.message || "launch failed");
    } finally {
      setSaving(false);
    }
  };

  return html`
    <${RolloverDialogView}
      session=${session}
      job=${job}
      jobId=${jobId}
      pack=${pack}
      packText=${packText}
      reason=${reason}
      saving=${saving}
      copied=${copied}
      launched=${launched}
      error=${error}
      onPackTextChange=${setPackText}
      onReasonChange=${setReason}
      onCopy=${copy}
      onLaunch=${launch}
      onClose=${onClose}
    />
  `;
}
