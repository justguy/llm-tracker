import { html } from "htm/preact";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sessionId(session) {
  return text(session?.id) || text(session?.sessionId);
}

function sessionProjectSlug(session) {
  return text(session?.projectSlug) ||
    text(session?.project?.slug) ||
    text(session?.trackerSlug);
}

function sessionTitle(session) {
  return text(session?.name) || sessionId(session) || "session";
}

function sessionActivityValue(session) {
  return text(session?.lastActivityAt) ||
    text(session?.lastActivity) ||
    text(session?.updatedAt) ||
    text(session?.ts);
}

export function formatProjectSessionActivity(value) {
  const raw = text(value);
  if (!raw) return "activity unknown";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

export function projectLocalSessions(sessions = [], projectSlug = "") {
  const slug = text(projectSlug);
  if (!slug) return [];
  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => isRecord(session) && sessionId(session) && sessionProjectSlug(session) === slug)
    .slice()
    .sort((a, b) => sessionActivityValue(b).localeCompare(sessionActivityValue(a)) || sessionId(a).localeCompare(sessionId(b)));
}

export function buildProjectRunIntent({ projectSlug = "", source = "project_session_strip" } = {}) {
  const slug = text(projectSlug);
  if (!slug) return null;
  return {
    source,
    scope: "project-local",
    projectSlug: slug,
  };
}

export function ProjectSessionStrip({
  projectSlug = "",
  sessions = [],
  onRun,
  onSelectSession,
} = {}) {
  const localSessions = projectLocalSessions(sessions, projectSlug);
  const runIntent = buildProjectRunIntent({ projectSlug });
  const selectSession = (session) => {
    const id = sessionId(session);
    if (id && typeof onSelectSession === "function") onSelectSession(id, session);
  };
  return html`
    <section class="project-session-strip" data-project-slug=${text(projectSlug)} aria-label="Project sessions">
      <div class="project-session-strip__sessions">
        ${localSessions.length
          ? localSessions.map((session) => html`
              <article
                key=${sessionId(session)}
                class="project-session-strip__session"
                data-session-id=${sessionId(session)}
                role=${typeof onSelectSession === "function" ? "button" : null}
                tabIndex=${typeof onSelectSession === "function" ? "0" : null}
                onClick=${() => selectSession(session)}
                onKeyDown=${(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectSession(session);
                  }
                }}
              >
                <strong class="project-session-strip__session-title">${sessionTitle(session)}</strong>
                <span class="project-session-strip__session-tier">${text(session.tier) || text(session.runtime) || "session"}</span>
                <span class=${`project-session-strip__session-status project-session-strip__session-status--${text(session.status) || "unknown"}`}>
                  ${text(session.status) || "unknown"}
                </span>
                <span class="project-session-strip__session-activity">
                  ${formatProjectSessionActivity(sessionActivityValue(session))}
                </span>
              </article>
            `)
          : html`<span class="project-session-strip__empty">No project sessions</span>`}
      </div>
      <button
        class="project-session-strip__run"
        type="button"
        disabled=${!runIntent}
        data-scope="project-local"
        onClick=${() => {
          if (runIntent && typeof onRun === "function") onRun(runIntent);
        }}
      >
        [+ RUN]
      </button>
    </section>
  `;
}
