import { html } from "htm/preact";

export const TIMELINE_KIND_ICONS = Object.freeze({
  message: "[M]",
  reasoning: "[R]",
  command: "[>]",
  file_change: "[F]",
  approval: "[A]",
  checkpoint: "[C]",
  skill: "[S]",
  verify: "[V]",
  repo_change: "[G]",
  warning: "[!]",
  handoff: "[H]",
  status: "[*]",
});

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTimelineItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(isRecord).map((item, index) => {
    const kind = text(item.kind) || "status";
    const evidenceRef = text(item.evidenceRef) || text(item.evidence) || text(item.id);
    return {
      id: text(item.id) || `timeline-${index}`,
      kind,
      icon: TIMELINE_KIND_ICONS[kind] || "[*]",
      title: text(item.title) || kind,
      detail: text(item.detail),
      source: text(item.source) || "system",
      confidence: text(item.confidence) || "unknown",
      evidenceRef,
      ts: text(item.ts),
    };
  });
}

export function timelineEvidenceHref(evidenceRef) {
  const ref = text(evidenceRef);
  return ref ? `#runtime-event-${encodeURIComponent(ref)}` : "";
}

export function TimelinePanelView({ items = [] } = {}) {
  const rows = normalizeTimelineItems(items);
  return html`
    <section class="timeline-panel" role="region" aria-label="Timeline">
      ${rows.length
        ? html`
            <ol class="timeline-panel__items">
              ${rows.map((item) => html`
                <li key=${item.id} class="timeline-panel__item" data-kind=${item.kind}>
                  <span class="timeline-panel__icon" aria-label=${item.kind}>${item.icon}</span>
                  <div class="timeline-panel__body">
                    <div class="timeline-panel__main">
                      <strong class="timeline-panel__title">${item.title}</strong>
                      ${item.ts ? html`<time class="timeline-panel__time" datetime=${item.ts}>${item.ts}</time>` : null}
                    </div>
                    ${item.detail ? html`<p class="timeline-panel__detail">${item.detail}</p>` : null}
                    <div class="timeline-panel__meta">
                      <span class="timeline-panel__chip timeline-panel__chip--source">${item.source}</span>
                      <span class="timeline-panel__chip timeline-panel__chip--confidence">${item.confidence}</span>
                      ${item.evidenceRef
                        ? html`
                            <a
                              class="timeline-panel__evidence"
                              href=${timelineEvidenceHref(item.evidenceRef)}
                              data-evidence-ref=${item.evidenceRef}
                            >
                              ${item.evidenceRef}
                            </a>
                          `
                        : null}
                    </div>
                  </div>
                </li>
              `)}
            </ol>
          `
        : html`<div class="timeline-panel__empty">No timeline items</div>`}
    </section>
  `;
}
