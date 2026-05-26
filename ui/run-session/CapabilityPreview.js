import { html } from "htm/preact";

const CHECK_MARK = "✓";
const EMPTY_MARK = "○";

const PROVIDER_CAPABILITY_KEYS = Object.freeze([
  "structuredThread",
  "structuredTurns",
  "structuredItems",
  "structuredApprovals",
  "structuredFileChanges",
  "structuredCommandEvents",
  "structuredContextUsage",
  "providerTimeline",
  "providerDiffs",
  "providerReview",
  "modelList",
  "skillList",
  "threadResume",
  "threadFork",
  "turnSteer",
  "turnInterrupt",
  "rawStdio",
  "stdinWrite",
  "processLifecycle",
  "directContextInjection",
]);

const RUNTIME_LABELS = Object.freeze({
  codex_app_server: "Codex app-server",
  dumb_terminal: "Generic terminal",
  generic_terminal: "Generic terminal",
  generic_pty: "Generic terminal",
  mcp_tracked: "MCP tracked terminal",
  manual: "Manual",
});

export const CAPABILITY_PREVIEW_LAYOUTS = Object.freeze({
  codex_app_server: Object.freeze({
    label: "Codex app-server",
    rows: Object.freeze([
      { id: "structured-chat", label: "structured chat", keys: Object.freeze(["structuredTurns"]) },
      { id: "structured-approvals", label: "structured approvals", keys: Object.freeze(["structuredApprovals"]) },
      { id: "provider-timeline", label: "provider timeline", keys: Object.freeze(["providerTimeline"]) },
      { id: "provider-file-changes", label: "provider file changes", keys: Object.freeze(["structuredFileChanges"]) },
      { id: "context-usage", label: "context usage", keys: Object.freeze(["structuredContextUsage"]) },
      { id: "thread-resume-fork", label: "thread resume/fork", keys: Object.freeze(["threadResume", "threadFork"]) },
      { id: "provider-review", label: "provider review", keys: Object.freeze(["providerReview"]) },
      { id: "direct-context-injection", label: "direct context injection", keys: Object.freeze(["directContextInjection"]) },
    ]),
  }),
  generic_terminal: Object.freeze({
    label: "Generic terminal",
    rows: Object.freeze([
      { id: "raw-stdio", label: "raw stdio", keys: Object.freeze(["rawStdio"]) },
      { id: "stdin", label: "stdin", keys: Object.freeze(["stdinWrite"]) },
      { id: "stop-restart", label: "stop/restart", keys: Object.freeze(["processLifecycle"]) },
      {
        id: "structured-approvals",
        label: "structured approvals",
        unavailableLabel: "structured approvals unavailable",
        keys: Object.freeze(["structuredApprovals"]),
      },
      {
        id: "context-usage",
        label: "context usage",
        unavailableLabel: "context usage unavailable unless reported via MCP",
        keys: Object.freeze(["structuredContextUsage"]),
      },
      {
        id: "provider-file-changes",
        label: "provider file changes",
        unavailableLabel: "provider file changes unavailable; git diff still available",
        keys: Object.freeze(["structuredFileChanges"]),
      },
    ]),
  }),
});

function text(value) {
  return typeof value === "string" ? value : "";
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function draftValue(input, key) {
  return input?.[key] ?? input?.draft?.[key] ?? null;
}

function resolvedCapabilities(input) {
  return (
    draftValue(input, "capabilities") ||
    draftValue(input, "providerCapabilities") ||
    draftValue(input, "capabilityPreview") ||
    null
  );
}

export function normalizeProviderCapabilities(capabilities) {
  const caps = isRecord(capabilities) ? capabilities : {};
  const normalized = {};
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    normalized[key] = caps[key] === true;
  }
  return normalized;
}

export function capabilityPreviewLayoutFor(input = {}) {
  const explicit = text(draftValue(input, "layout"));
  if (CAPABILITY_PREVIEW_LAYOUTS[explicit]) return explicit;

  const runtimeLabel = text(draftValue(input, "runtimeLabel")).toLowerCase();
  if (runtimeLabel === "codex app-server") return "codex_app_server";
  if (runtimeLabel === "generic terminal") return "generic_terminal";

  const runtime = text(draftValue(input, "runtime"));
  const providerId = text(draftValue(input, "providerId"));
  if (runtime === "codex_app_server" || providerId === "codex_app_server") {
    return "codex_app_server";
  }
  return "generic_terminal";
}

export function runtimeLabelFor(input = {}) {
  const explicit = text(draftValue(input, "runtimeLabel")).trim();
  if (explicit) return explicit;

  const runtime = text(draftValue(input, "runtime"));
  if (RUNTIME_LABELS[runtime]) return RUNTIME_LABELS[runtime];

  const providerId = text(draftValue(input, "providerId"));
  if (providerId === "codex_app_server") return RUNTIME_LABELS.codex_app_server;
  if (providerId === "generic_pty" || providerId === "codex_cli") {
    return RUNTIME_LABELS.generic_terminal;
  }

  const layout = capabilityPreviewLayoutFor(input);
  return CAPABILITY_PREVIEW_LAYOUTS[layout].label;
}

export function capabilityPreviewRows(input = {}) {
  const capabilities = normalizeProviderCapabilities(resolvedCapabilities(input));
  const layout = CAPABILITY_PREVIEW_LAYOUTS[capabilityPreviewLayoutFor(input)];
  return layout.rows.map((row) => {
    const supported = row.keys.every((key) => capabilities[key] === true);
    return {
      id: row.id,
      supported,
      marker: supported ? CHECK_MARK : EMPTY_MARK,
      label: supported ? row.label : row.unavailableLabel || `${row.label} unavailable`,
      keys: [...row.keys],
    };
  });
}

export function CapabilityPreview({
  draft = null,
  capabilities = null,
  providerCapabilities = null,
  capabilityPreview = null,
  runtime = null,
  runtimeLabel = null,
  providerId = null,
  layout = null,
  className = "",
} = {}) {
  const input = {
    draft,
    capabilities,
    providerCapabilities,
    capabilityPreview,
    runtime,
    runtimeLabel,
    providerId,
    layout,
  };
  const rows = capabilityPreviewRows(input);
  const classes = ["capability-preview", className].filter(Boolean).join(" ");

  return html`
    <section class=${classes} aria-label="Capability preview">
      <div class="capability-preview__runtime">
        <span>Runtime:</span>
        <strong>${runtimeLabelFor(input)}</strong>
      </div>
      <ul class="capability-preview__list">
        ${rows.map((row) => html`
          <li
            key=${row.id}
            class=${`capability-preview__item ${row.supported ? "capability-preview__item--supported" : "capability-preview__item--unavailable"}`}
            data-capability=${row.id}
            data-supported=${row.supported ? "true" : "false"}
          >
            <span
              class="capability-preview__marker"
              aria-label=${row.supported ? "supported" : "unavailable"}
            >${row.marker}</span>
            <span class="capability-preview__label">${row.label}</span>
          </li>
        `)}
      </ul>
    </section>
  `;
}
