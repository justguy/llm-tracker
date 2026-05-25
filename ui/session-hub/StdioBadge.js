import { html } from "htm/preact";

export const STDIO_SECRETS_CAVEAT_HREF =
  "https://github.com/justguy/llm-tracker/blob/main/docs/session-hub/capture-and-secrets.md#secrets-caveat";

const RAW_STDIO_TIERS = new Set(["dumb_terminal", "hybrid"]);

function readRawStdioCapability(session) {
  const candidates = [
    session?.providerCapabilities,
    session?.capabilities,
    session?.provider?.capabilities,
    session?.stdio,
  ];
  for (const caps of candidates) {
    if (caps && typeof caps === "object" && typeof caps.rawStdio === "boolean") {
      return caps.rawStdio;
    }
  }
  return null;
}

function hasRawStdio(session) {
  if (!session || typeof session !== "object") return false;
  const explicitRawStdio = readRawStdioCapability(session);
  if (explicitRawStdio !== null) return explicitRawStdio;
  return RAW_STDIO_TIERS.has(session.tier);
}

function isCaptureEnabled(session) {
  const capture = session?.stdioCapture;
  if (capture && typeof capture === "object") {
    return capture.enabled === true || capture.captureToDisk === true;
  }
  const stdio = session?.stdio;
  return !!(stdio && typeof stdio === "object" && stdio.captureToDisk === true);
}

export function resolveStdioMode(session) {
  if (!hasRawStdio(session)) {
    return {
      mode: "off",
      label: "STDIO OFF",
      title: "Provider does not expose raw stdio (manual/structured-only).",
    };
  }
  if (isCaptureEnabled(session)) {
    return {
      mode: "captured",
      label: "STDIO CAPTURED",
      title: "Raw stdio is live and persisted to rolling logs. Review the secrets caveat before enabling capture.",
      href: STDIO_SECRETS_CAVEAT_HREF,
    };
  }
  return {
    mode: "live",
    label: "STDIO LIVE",
    title: "Raw stdio is available in the in-memory ring only; nothing is written to disk.",
  };
}

export function StdioBadge({ session, className = "" } = {}) {
  const mode = resolveStdioMode(session);
  const classes = ["session-stdio-badge", `session-stdio-badge--${mode.mode}`, className]
    .filter(Boolean)
    .join(" ");

  if (mode.href) {
    return html`
      <a
        class=${classes}
        href=${mode.href}
        title=${mode.title}
        aria-label=${mode.title}
        target="_blank"
        rel="noreferrer"
      >${mode.label}</a>
    `;
  }

  return html`
    <span
      class=${classes}
      title=${mode.title}
      aria-label=${mode.title}
    >${mode.label}</span>
  `;
}
