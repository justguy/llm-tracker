import { html } from "htm/preact";
import { SwimlaneRunNextButton } from "./SwimlaneRunNextButton.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function SwimlaneHeaderView({
  projectSlug = "",
  lane = null,
  candidates = [],
  total = 0,
  active = 0,
  onRunNext,
} = {}) {
  if (!lane || typeof lane !== "object") return null;
  const label = text(lane.label) || text(lane.id) || "swimlane";
  return html`
    <header class="swimlane-header" data-swimlane-id=${text(lane.id)}>
      <div class="swimlane-header__main">
        <strong class="swimlane-header__title" title=${label}>${label}</strong>
        <div class="swimlane-header__stats">
          <span>${Number.isFinite(total) ? total : 0} tasks</span>
          <span>${Number.isFinite(active) ? active : 0} active</span>
        </div>
      </div>
      <${SwimlaneRunNextButton}
        projectSlug=${projectSlug}
        lane=${lane}
        candidates=${candidates}
        onRunNext=${onRunNext}
      />
    </header>
  `;
}
