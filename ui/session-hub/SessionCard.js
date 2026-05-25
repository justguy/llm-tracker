import { html } from "htm/preact";
import { StdioBadge } from "./StdioBadge.js";

function sessionTitle(session) {
  if (typeof session?.name === "string" && session.name.length > 0) return session.name;
  if (typeof session?.id === "string" && session.id.length > 0) return session.id;
  return "Untitled session";
}

function warningSourceLabel(warning) {
  if (!warning || typeof warning !== "object") return null;
  if (typeof warning.source === "string" && warning.source.length > 0) return warning.source;
  if (typeof warning.kind === "string" && warning.kind.length > 0) return warning.kind;
  return null;
}

export function SessionCard({ session } = {}) {
  if (!session || typeof session !== "object") return null;
  const warnings = Array.isArray(session.warnings) ? session.warnings : [];

  return html`
    <article class="session-card" data-session-id=${session.id || ""}>
      <header class="session-card__header">
        <div class="session-card__identity">
          <span class="session-card__id">${session.id || "session"}</span>
          <strong class="session-card__title">${sessionTitle(session)}</strong>
        </div>
        <${StdioBadge} session=${session} />
      </header>

      <div class="session-card__meta">
        <span class=${`session-card__status session-card__status--${session.status || "unknown"}`}>
          ${session.status || "unknown"}
        </span>
        ${session.tier ? html`<span class="session-card__tier">${session.tier}</span>` : null}
      </div>

      ${warnings.length
        ? html`
            <ul class="session-card__warnings">
              ${warnings.map((warning, index) => html`
                <li key=${`${warning?.kind || "warning"}:${index}`} class="session-card__warning">
                  ${warningSourceLabel(warning)
                    ? html`<span class="session-card__warning-source">${warningSourceLabel(warning)}</span>`
                    : null}
                  ${warning?.evidenceRef
                    ? html`<span class="session-card__warning-evidence">${warning.evidenceRef}</span>`
                    : null}
                  <span>${warning?.message || warning?.kind || "Session warning"}</span>
                </li>
              `)}
            </ul>
          `
        : null}
    </article>
  `;
}
