import { html } from "htm/preact";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildRunSessionPickerIntent({ source = "hub_run_button", projects = [], topN = 5 } = {}) {
  const workspaceProjects = Array.isArray(projects)
    ? projects.filter(isRecord).map((project) => text(project.slug) || text(project.projectSlug) || text(project.id)).filter(Boolean)
    : [];
  return {
    source,
    scope: "workspace-local",
    projectSlugs: workspaceProjects,
    topN,
  };
}

export function RunSessionButton({
  projects = [],
  topN = 5,
  disabled = false,
  onOpenPicker,
} = {}) {
  const intent = buildRunSessionPickerIntent({ projects, topN });
  const title = intent.projectSlugs.length > 0
    ? `Show top ${topN} workspace-local run candidates`
    : "Show workspace-local run candidates";
  return html`
    <button
      class="run-session-button"
      type="button"
      disabled=${disabled}
      title=${title}
      aria-label=${title}
      data-scope="workspace-local"
      onClick=${() => {
        if (!disabled && typeof onOpenPicker === "function") onOpenPicker(intent);
      }}
    >
      [+ RUN]
    </button>
  `;
}
