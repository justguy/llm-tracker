import { html } from "htm/preact";
import { timelineEvidenceHref } from "./TimelinePanel.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function verifyItemsFrom(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.items)) return input.items;
  if (Array.isArray(input?.verifyPack?.items)) return input.verifyPack.items;
  if (Array.isArray(input?.job?.verifyPack?.items)) return input.job.verifyPack.items;
  return [];
}

function gatesFrom(input) {
  if (Array.isArray(input?.completionGates)) return input.completionGates;
  if (Array.isArray(input?.gates)) return input.gates;
  if (Array.isArray(input?.job?.completionGates)) return input.job.completionGates;
  if (Array.isArray(input?.job?.verifyPack?.gates)) return input.job.verifyPack.gates;
  return [];
}

function labelFor(item) {
  return text(item.label) || text(item.title) || text(item.prompt) || text(item.command) || text(item.id) || "verify item";
}

function evidenceLink(evidenceRef) {
  const ref = text(evidenceRef);
  if (!ref) return html`<span class="session-context-tab__evidence session-context-tab__evidence--empty">none</span>`;
  return html`
    <a class="session-context-tab__evidence" href=${timelineEvidenceHref(ref)} data-evidence-ref=${ref}>
      ${ref}
    </a>
  `;
}

export function normalizeVerifyPackRows(input = {}) {
  const gatesById = new Map();
  for (const gate of gatesFrom(input)) {
    if (gate && typeof gate === "object" && text(gate.id)) gatesById.set(text(gate.id), gate);
  }

  return verifyItemsFrom(input)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const id = text(item.id) || `verify-item-${index + 1}`;
      const gate = gatesById.get(id) || {};
      return {
        id,
        label: labelFor(item),
        kind: text(item.kind) || text(gate.kind) || "verify_pack",
        required: gate.required === true || item.required === true,
        status: text(gate.status) || text(item.status) || "pending",
        evidenceRef:
          text(gate.evidenceRef) ||
          text(gate.evidence) ||
          text(item.evidenceRef) ||
          text(item.evidence) ||
          text(item.runtimeEventId),
      };
    });
}

export function SessionContextTab({ job = null, verifyPack = null, completionGates = null } = {}) {
  const rows = normalizeVerifyPackRows({ job, verifyPack, completionGates });
  return html`
    <section class="session-context-tab" role="region" aria-label="Job context">
      <header class="session-context-tab__header">
        <strong>Verify pack</strong>
        <span>${rows.length} gates</span>
      </header>
      ${rows.length
        ? html`
            <ol class="session-context-tab__items">
              ${rows.map((row) => html`
                <li key=${row.id} class="session-context-tab__item" data-gate-id=${row.id}>
                  <div class="session-context-tab__main">
                    <strong class="session-context-tab__label">${row.label}</strong>
                    <span class=${`session-context-tab__status session-context-tab__status--${row.status}`}>
                      ${row.status}
                    </span>
                  </div>
                  <div class="session-context-tab__meta">
                    <span>${row.id}</span>
                    <span>${row.kind}</span>
                    <span>${row.required ? "required" : "optional"}</span>
                    ${evidenceLink(row.evidenceRef)}
                  </div>
                </li>
              `)}
            </ol>
          `
        : html`<div class="session-context-tab__empty">No verify pack</div>`}
    </section>
  `;
}

export const JobContextTab = SessionContextTab;
