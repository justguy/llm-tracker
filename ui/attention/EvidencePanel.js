// ui/attention/EvidencePanel.js -- SH-4-13
//
// Self-contained evidence drill-down trigger + panel. Callers can render the
// trigger around an attention badge or critical status chip without duplicating
// the evidence-field mapping.

import { html } from "htm/preact";
import { useState } from "preact/hooks";

import { defaultClearConditionForKind } from "../../hub/attention/types.js";
import { timelineEvidenceHref } from "../session-hub/TimelinePanel.js";

const EVIDENCE_ID_FIELDS = Object.freeze([
  ["evidenceRef", "evidence"],
  ["runtimeEventId", "runtime event"],
  ["providerEventId", "provider event"],
  ["conflictId", "conflict"],
  ["trackerRev", "tracker rev"],
  ["evidenceId", "evidence"],
  ["id", "attention"],
]);
export const TIMELINE_EVIDENCE_HIGHLIGHT_CLASS = "timeline-panel__item--evidence-highlight";
const TIMELINE_EVIDENCE_HIGHLIGHT_MS = 1600;

export function evidencePanelModel(item = {}) {
  const source = text(item.source) || text(item.evidence?.source) || "unknown";
  const evidence = evidenceIdFor(item);
  return {
    id: text(item.id),
    title: text(item.title) || "Attention evidence",
    severity: text(item.severity) || "low",
    kind: text(item.kind) || "attention",
    source,
    confidence: confidenceLabel(item.confidence ?? item.evidence?.confidence),
    evidenceId: evidence.value,
    evidenceKind: evidence.kind,
    evidenceHref: timelineEvidenceHref(evidence.value),
    timestamp: timestampLabel(item.timestamp || item.createdAt || item.updatedAt || item.evidence?.timestamp),
    why: text(item.why) || text(item.reason) || text(item.detail) || "No rationale recorded.",
    recommendedAction: recommendedActionLabel(item),
    clearCondition: clearConditionLabel(item),
    context: contextLabel(item),
  };
}

export function EvidencePanel({
  item = null,
  trigger = "badge",
  defaultOpen = false,
  onOpen,
  onClose,
} = {}) {
  const [open, setOpen] = useState(defaultOpen === true);
  const model = evidencePanelModel(item || {});
  const openPanel = (nextModel) => {
    setOpen(true);
    if (typeof onOpen === "function") onOpen(nextModel || model);
  };
  const closePanel = (nextModel) => {
    setOpen(false);
    if (typeof onClose === "function") onClose(nextModel || model);
  };

  return html`<${EvidencePanelShellView} model=${model} trigger=${trigger} open=${open} onOpen=${openPanel} onClose=${closePanel} />`;
}

export function EvidencePanelShellView({ model, trigger = "badge", open = false, onOpen, onClose } = {}) {
  return html`
    <div class="evidence-panel-shell">
      <${EvidencePanelTrigger} model=${model} variant=${trigger} onOpen=${onOpen} />
      ${open ? html`<${EvidencePanelView} model=${model} onClose=${onClose} />` : null}
    </div>
  `;
}

export function EvidencePanelTrigger({ model, variant = "badge", onOpen } = {}) {
  const m = model || evidencePanelModel();
  const isCritical = variant === "critical" || m.severity === "critical";
  const handleClick = () => {
    jumpToTimelineEvidence(m.evidenceId);
    if (typeof onOpen === "function") onOpen(m);
  };
  return html`
    <button
      class=${`evidence-panel-trigger evidence-panel-trigger--${isCritical ? "critical" : "badge"}`}
      type="button"
      title=${`Open evidence for ${m.title}`}
      data-evidence-id=${m.evidenceId}
      onClick=${handleClick}
    >
      <span class="evidence-panel-trigger__label">${isCritical ? "Critical" : "Evidence"}</span>
      <span class="evidence-panel-trigger__id">${m.evidenceId}</span>
    </button>
  `;
}

export function EvidencePanelView({ model, onClose } = {}) {
  const m = model || evidencePanelModel();
  return html`
    <section
      class="evidence-panel"
      role="dialog"
      aria-label=${`Evidence details for ${m.title}`}
      data-evidence-id=${m.evidenceId}
    >
      <header class="evidence-panel__head">
        <div class="evidence-panel__identity">
          <strong class="evidence-panel__title">${m.title}</strong>
          <span class="evidence-panel__meta">${m.kind} · ${m.severity}</span>
        </div>
        <button
          class="evidence-panel__close"
          type="button"
          aria-label="Close evidence panel"
          onClick=${typeof onClose === "function" ? () => onClose(m) : undefined}
        >
          Close
        </button>
      </header>

      <dl class="evidence-panel__grid">
        <${EvidenceRow} label="Source" value=${m.source} />
        <${EvidenceRow} label="Confidence" value=${m.confidence} />
        <${EvidenceRow} label=${m.evidenceKind} value=${m.evidenceId} mono=${true} href=${m.evidenceHref} />
        <${EvidenceRow} label="Timestamp" value=${m.timestamp} mono=${true} />
        <${EvidenceRow} label="Why" value=${m.why} wide=${true} />
        <${EvidenceRow} label="Recommended action" value=${m.recommendedAction} wide=${true} />
        <${EvidenceRow} label="Clear condition" value=${m.clearCondition} wide=${true} />
        <${EvidenceRow} label="Context" value=${m.context} wide=${true} />
      </dl>
    </section>
  `;
}

function EvidenceRow({ label, value, wide = false, mono = false, href = "" } = {}) {
  return html`
    <div class=${`evidence-panel__row ${wide ? "evidence-panel__row--wide" : ""}`}>
      <dt>${label}</dt>
      <dd class=${mono ? "evidence-panel__mono" : ""}>
        ${href
          ? html`
              <a
                class="evidence-panel__evidence"
                href=${href}
                data-evidence-ref=${value}
                onClick=${(event) => handleEvidenceLinkClick(event, value)}
              >
                ${value}
              </a>
            `
          : value || "not recorded"}
      </dd>
    </div>
  `;
}

function handleEvidenceLinkClick(event, evidenceRef) {
  if (jumpToTimelineEvidence(evidenceRef)) {
    event?.preventDefault?.();
  }
}

export function jumpToTimelineEvidence(
  evidenceRef,
  { documentRef = globalThis.document, timerRef = globalThis, highlightMs = TIMELINE_EVIDENCE_HIGHLIGHT_MS } = {}
) {
  const ref = text(evidenceRef);
  if (!ref || !documentRef || typeof documentRef.querySelectorAll !== "function") return false;

  const evidenceNode = Array.from(documentRef.querySelectorAll("[data-evidence-ref]"))
    .find((node) => node?.getAttribute?.("data-evidence-ref") === ref && node?.closest?.(".timeline-panel__item"));
  const target = evidenceNode?.closest?.(".timeline-panel__item");
  if (!target) return false;

  target.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
  target.classList?.add?.(TIMELINE_EVIDENCE_HIGHLIGHT_CLASS);
  if (typeof timerRef?.setTimeout === "function" && typeof target.classList?.remove === "function") {
    timerRef.setTimeout(() => {
      target.classList.remove(TIMELINE_EVIDENCE_HIGHLIGHT_CLASS);
    }, highlightMs);
  }
  return true;
}

function evidenceIdFor(item) {
  for (const [field, kind] of EVIDENCE_ID_FIELDS) {
    const value = text(item?.[field]);
    if (value) return { value, kind };
  }
  return { value: "unrecorded", kind: "evidence" };
}

function recommendedActionLabel(item) {
  const explicit = text(item.recommendedAction);
  if (explicit) return explicit;
  const actions = Array.isArray(item.recommendedActions) ? item.recommendedActions : [];
  const firstEnabled = actions.find((action) => action?.enabled !== false) || actions[0];
  return text(firstEnabled?.label) || text(firstEnabled?.kind) || "No recommended action recorded.";
}

function clearConditionLabel(item) {
  const explicit = text(item.clearCondition);
  if (explicit) return explicit;
  const fallback = defaultClearConditionForKind(text(item.kind));
  return text(fallback) || "No clear condition recorded.";
}

function contextLabel(item) {
  const parts = [
    ["project", item.projectSlug],
    ["task", item.taskId],
    ["job", item.jobId],
    ["session", item.sessionId],
    ["dedupe", item.dedupeKey],
  ]
    .map(([label, value]) => {
      const out = text(value);
      return out ? `${label}: ${out}` : "";
    })
    .filter(Boolean);
  return parts.join(" · ") || "No context recorded.";
}

function confidenceLabel(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value <= 1 ? value * 100 : value;
    return `${Math.round(normalized)}%`;
  }
  return text(value) || "unknown";
}

function timestampLabel(value) {
  const raw = text(value);
  if (!raw) return "not recorded";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString();
}

function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
