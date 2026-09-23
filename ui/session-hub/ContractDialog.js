import { html } from "htm/preact";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

export function mcpSessionContractText({ sessionId, jobId } = {}) {
  const sid = nonEmpty(sessionId);
  const jid = nonEmpty(jobId);
  const attachedLine = jid
    ? `You are attached to llm-tracker session ${sid} and job ${jid}.`
    : `You are attached to llm-tracker session ${sid}.`;
  return [
    attachedLine,
    "Use these tools:",
    "- tracker_session_heartbeat every 5 minutes",
    "- tracker_job_checkpoint after meaningful progress",
    "- tracker_session_blocked when blocked",
    "- tracker_session_context_usage if your runtime can measure context",
    "- tracker_skill_run_complete when a required skill is complete",
    "- tracker_session_handoff before stopping or rolling over",
    "",
    "Do not mark complete until verify gates are satisfied.",
  ].join("\n");
}

export function ContractDialogView({
  sessionId = "",
  jobId = "",
  copied = false,
  onCopy,
  onClose,
} = {}) {
  const contract = mcpSessionContractText({ sessionId, jobId });
  return html`
    <div class="modal-overlay contract-dialog-overlay" onClick=${onClose}>
      <section
        class="modal contract-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="MCP session contract"
        onClick=${(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <span class="brand">[MCP CONTRACT]</span>
          <button class="icon-btn" type="button" aria-label="Close dialog" onClick=${onClose} title="Close">x</button>
        </div>
        <div class="modal-body contract-dialog__body">
          <pre class="contract-dialog__text">${contract}</pre>
          <div class="contract-dialog__actions">
            <button class="icon-btn" type="button" onClick=${() => onCopy?.(contract)}>
              ${copied ? "[COPIED]" : "[COPY]"}
            </button>
          </div>
        </div>
      </section>
    </div>
  `;
}

export function ContractDialog({ open = false, ...props } = {}) {
  if (!open) return null;
  return html`<${ContractDialogView} ...${props} />`;
}
