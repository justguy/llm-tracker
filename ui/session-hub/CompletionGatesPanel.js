import { html } from "htm/preact";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function completionGateMissingItems(result) {
  const missing = Array.isArray(result?.missing)
    ? result.missing
    : Array.isArray(result?.missing_gates)
      ? result.missing_gates
      : [];
  return missing.filter(isRecord);
}

export function completionGateLabel(gate) {
  return text(gate?.label) || text(gate?.title) || text(gate?.prompt) || text(gate?.id) || "gate";
}

export function isHumanApprovalGate(gate) {
  return gate?.humanApproval === true ||
    gate?.verifyItemKind === "human_approval" ||
    gate?.itemKind === "human_approval" ||
    gate?.kind === "human_approval";
}

function isRunnableVerifyGate(gate) {
  return gate?.kind === "verify_pack" && !isHumanApprovalGate(gate);
}

function formValue(event, name) {
  const form = event?.currentTarget;
  const control = typeof form?.elements?.namedItem === "function"
    ? form.elements.namedItem(name)
    : form?.elements?.[name];
  return text(control?.value);
}

function safeDomId(value) {
  return text(value).replace(/[^a-zA-Z0-9_-]/g, "-") || "job";
}

function evidenceNode(gate) {
  const evidenceRef = text(gate?.evidenceRef) || text(gate?.evidence);
  if (!evidenceRef) return html`<span class="completion-gates-panel__evidence completion-gates-panel__evidence--empty">none</span>`;
  return html`
    <a
      class="completion-gates-panel__evidence"
      href=${`#runtime-event-${encodeURIComponent(evidenceRef)}`}
      data-evidence-ref=${evidenceRef}
    >
      ${evidenceRef}
    </a>
  `;
}

export function CompletionGatesPanel({
  result = null,
  session = null,
  jobId = "",
  busyAction = null,
  message = null,
  error = null,
  onClose,
  onRunMissing,
  onResolveHumanApproval,
  onSpawnReviewer,
  onOverrideComplete,
  onValidationError,
} = {}) {
  const missing = completionGateMissingItems(result);
  if (!result || result.mode !== "gates_pending") return null;

  const disabled = Boolean(busyAction);
  const idPrefix = `completion-gates-${safeDomId(jobId)}`;
  const actionPayload = (extra = {}) => ({
    jobId,
    session,
    missing,
    result,
    ...extra,
  });
  const handleOverride = (event) => {
    event.preventDefault();
    const reason = formValue(event, "reason");
    if (!reason) {
      if (typeof onValidationError === "function") onValidationError("Override reason is required", actionPayload());
      return;
    }
    if (typeof onOverrideComplete === "function") onOverrideComplete(actionPayload({ reason }));
  };

  return html`
    <section class="completion-gates-panel" role="region" aria-label="Completion gates" data-job-id=${jobId}>
      <div class="completion-gates-panel__head">
        <div>
          <strong class="completion-gates-panel__title">Completion gates</strong>
          <span class="completion-gates-panel__count">${missing.length} missing</span>
        </div>
        ${typeof onClose === "function"
          ? html`<button class="completion-gates-panel__close" type="button" onClick=${() => onClose(actionPayload())}>[CLOSE]</button>`
          : null}
      </div>

      ${message ? html`<div class="completion-gates-panel__message" role="status">${message}</div>` : null}
      ${error ? html`<div class="completion-gates-panel__error" role="status">${error}</div>` : null}

      <ul class="completion-gates-panel__missing" aria-label="Missing completion gates">
        ${missing.map((gate, index) => {
          const gateId = text(gate.id) || `gate-${index + 1}`;
          const gateKey = `${gateId}:${index}`;
          const isHuman = isHumanApprovalGate(gate);
          const runnable = isRunnableVerifyGate(gate);
          const resolveReasonId = `${idPrefix}-resolve-${index}`;
          return html`
            <li key=${gateKey} class="completion-gates-panel__gate" data-gate-id=${gateId}>
              <div class="completion-gates-panel__gate-main">
                <strong class="completion-gates-panel__gate-label">${completionGateLabel(gate)}</strong>
                <span class="completion-gates-panel__gate-id">${gateId}</span>
              </div>
              <div class="completion-gates-panel__gate-meta">
                <span>${gate.kind || "gate"}</span>
                <span>${gate.required === true ? "required" : "optional"}</span>
                <span>${gate.status || "pending"}</span>
                ${evidenceNode(gate)}
              </div>
              <div class="completion-gates-panel__gate-action">
                ${isHuman
                  ? html`
                      <form
                        class="completion-gates-panel__resolve-form"
                        onSubmit=${(event) => {
                          event.preventDefault();
                          if (typeof onResolveHumanApproval === "function") {
                            onResolveHumanApproval(actionPayload({
                              gate,
                              reason: formValue(event, "reason"),
                            }));
                          }
                        }}
                      >
                        <label class="completion-gates-panel__field">
                          <span>reason</span>
                          <input id=${resolveReasonId} name="reason" type="text" autocomplete="off" />
                        </label>
                        <button class="completion-gates-panel__action" type="submit" disabled=${disabled}>
                          [RESOLVE HUMAN APPROVAL]
                        </button>
                      </form>
                    `
                  : html`
                      <button
                        class="completion-gates-panel__action"
                        type="button"
                        disabled=${disabled || !runnable}
                        title=${runnable ? "Run missing verify item" : "No runnable verify item"}
                        onClick=${() => {
                          if (typeof onRunMissing === "function") onRunMissing(actionPayload({ gate, missing: [gate] }));
                        }}
                      >
                        [RUN MISSING]
                      </button>
                    `}
              </div>
            </li>
          `;
        })}
      </ul>

      <div class="completion-gates-panel__actions">
        <button
          class="completion-gates-panel__action completion-gates-panel__action--primary"
          type="button"
          disabled=${disabled}
          onClick=${() => {
            if (typeof onRunMissing === "function") onRunMissing(actionPayload());
          }}
        >
          [RUN MISSING]
        </button>
        <button
          class="completion-gates-panel__action"
          type="button"
          disabled=${disabled}
          onClick=${() => {
            if (typeof onSpawnReviewer === "function") onSpawnReviewer(actionPayload());
          }}
        >
          [SPAWN REVIEWER]
        </button>
      </div>

      <form class="completion-gates-panel__override" onSubmit=${handleOverride}>
        <label class="completion-gates-panel__field" for=${`${idPrefix}-override-reason`}>
          <span>override reason</span>
          <textarea id=${`${idPrefix}-override-reason`} name="reason" required rows="2"></textarea>
        </label>
        <button
          class="completion-gates-panel__action completion-gates-panel__action--danger"
          type="submit"
          disabled=${disabled}
        >
          [OVERRIDE & COMPLETE]
        </button>
      </form>
    </section>
  `;
}
