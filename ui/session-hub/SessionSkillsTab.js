import { html } from "htm/preact";
import { timelineEvidenceHref } from "./TimelinePanel.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boolLabel(value) {
  return value === true ? "required" : "optional";
}

function evidenceLink(evidenceRef, className) {
  const ref = text(evidenceRef);
  if (!ref) return html`<span class=${`${className} ${className}--empty`}>none</span>`;
  return html`
    <a class=${className} href=${timelineEvidenceHref(ref)} data-evidence-ref=${ref}>
      ${ref}
    </a>
  `;
}

export function normalizeSkillPlanItems(input = {}) {
  const plan = Array.isArray(input)
    ? input
    : Array.isArray(input.skillPlan)
      ? input.skillPlan
      : Array.isArray(input.job?.skillPlan)
        ? input.job.skillPlan
        : Array.isArray(input.session?.skillPlan)
          ? input.session.skillPlan
          : [];
  return plan
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: text(item.id) || `skill-plan-${index + 1}`,
      skillId: text(item.skillId) || text(item.skill) || "unknown skill",
      phase: text(item.phase) || "phase",
      status: text(item.status) || "pending",
      required: item.required === true,
      runId: text(item.runId),
      source: text(item.source),
      evidenceRef: text(item.evidenceRef) || text(item.evidence) || text(item.runtimeEventId),
    }));
}

export function SessionSkillsTab({ job = null, session = null, skillPlan = null } = {}) {
  const items = normalizeSkillPlanItems({ job, session, skillPlan });
  return html`
    <section class="session-skills-tab" role="region" aria-label="Session skills">
      <header class="session-skills-tab__header">
        <strong>Skill plan</strong>
        <span>${items.length} skills</span>
      </header>
      ${items.length
        ? html`
            <ol class="session-skills-tab__items">
              ${items.map((item) => html`
                <li key=${item.id} class="session-skills-tab__item" data-skill-id=${item.skillId}>
                  <div class="session-skills-tab__main">
                    <strong class="session-skills-tab__skill">${item.skillId}</strong>
                    <span class=${`session-skills-tab__status session-skills-tab__status--${item.status}`}>
                      ${item.status}
                    </span>
                  </div>
                  <div class="session-skills-tab__meta">
                    <span>${item.phase}</span>
                    <span>${boolLabel(item.required)}</span>
                    ${item.source ? html`<span>${item.source}</span>` : null}
                    ${item.runId ? html`<span>${item.runId}</span>` : null}
                    ${evidenceLink(item.evidenceRef, "session-skills-tab__evidence")}
                  </div>
                </li>
              `)}
            </ol>
          `
        : html`<div class="session-skills-tab__empty">No skill plan</div>`}
    </section>
  `;
}
