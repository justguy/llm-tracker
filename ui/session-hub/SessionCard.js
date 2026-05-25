import { html } from "htm/preact";
import { StdioBadge } from "./StdioBadge.js";

export const SESSION_CARD_SIZES = Object.freeze(["compact", "normal", "large"]);

export function normalizeSessionCardSize(size) {
  return SESSION_CARD_SIZES.includes(size) ? size : "normal";
}

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

function warningEvidenceLabel(warning) {
  if (!warning || typeof warning !== "object") return null;
  if (typeof warning.evidenceRef === "string" && warning.evidenceRef.length > 0) return warning.evidenceRef;
  if (typeof warning.evidence === "string" && warning.evidence.length > 0) return warning.evidence;
  return null;
}

export function SessionCard({ session, size = "normal" } = {}) {
  if (!session || typeof session !== "object") return null;
  const warnings = Array.isArray(session.warnings) ? session.warnings : [];
  const cardSize = normalizeSessionCardSize(size);

  return html`
    <article
      class=${`session-card session-card--${cardSize}`}
      data-session-id=${session.id || ""}
      data-card-size=${cardSize}
    >
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
              ${warnings.map((warning, index) => {
                const source = warningSourceLabel(warning) || "unknown";
                const evidence = warningEvidenceLabel(warning) || "none";
                return html`
                  <li key=${`${warning?.kind || "warning"}:${index}`} class="session-card__warning">
                    <span class="session-card__warning-source">
                      <span class="session-card__warning-label">source</span>
                      <span>${source}</span>
                    </span>
                    <span class="session-card__warning-evidence">
                      <span class="session-card__warning-label">evidence</span>
                      <span>${evidence}</span>
                    </span>
                    <span class="session-card__warning-message">${warning?.message || warning?.kind || "Session warning"}</span>
                  </li>
                `;
              })}
            </ul>
          `
        : null}
    </article>
  `;
}
