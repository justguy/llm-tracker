// ui/attention/AttentionItemCard.js — SH-4-12 (TDD v0.5 §8A; addendum §15)
//
// Shared attention card. Renders one AttentionItem with severity chip, kind
// label, source, title, optional detail, and the §15-required clearCondition
// string under the body. Recommended-action chips at the bottom mirror the
// AttentionStrip card so the look is consistent across surfaces (Triage,
// drill-down panels, action wiring).
//
// The component is intentionally pure: no hooks, no fetches, no global state.
// Tests target the view directly via the same vnode-walk pattern used in
// attention-strip-ui.test.js.

import { html } from "htm/preact";

import {
  ATTENTION_KINDS,
  ATTENTION_SEVERITIES,
  defaultClearConditionForKind,
} from "../../hub/attention/types.js";

const SEVERITY_LABELS = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const KIND_LABELS = {
  approval_needed: "Approval needed",
  blocked: "Blocked",
  conflict: "Conflict",
  outside_allowed_paths: "Outside allowed paths",
  not_responding: "Not responding",
  quiet: "Quiet terminal",
  context_high: "Context high",
  done_needs_closeout: "Done · needs closeout",
  done_claimed_verify_missing: "Done claimed · verify missing",
  verify_missing: "Verify missing",
  unbound_session: "Unbound session",
  sandbox_escape_requested: "Sandbox escape requested",
  provider_error: "Provider error",
};

/**
 * @typedef {import("../../hub/attention/types.js").AttentionItem} AttentionItem
 * @typedef {import("../../hub/attention/types.js").AttentionAction} AttentionAction
 */

/**
 * Resolve the clearCondition string for `item`, falling back to the §15
 * default for the item's kind when the field is absent. Returns an empty
 * string when the kind is unknown so the renderer can omit the row entirely.
 *
 * @param {AttentionItem} item
 * @returns {string}
 */
export function resolveClearCondition(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.clearCondition === "string" && item.clearCondition.length > 0) {
    return item.clearCondition;
  }
  const fallback = defaultClearConditionForKind(item.kind);
  return typeof fallback === "string" ? fallback : "";
}

function renderActions(actions, item, onAction) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  return html`
    <div class="attention-item-card__actions">
      ${actions.map(
        (action) => html`
          <button
            key=${action.id}
            class=${`attention-item-card__action ${action.enabled === false ? "attention-item-card__action--disabled" : ""}`}
            type="button"
            disabled=${action.enabled === false}
            title=${action.disabledReason || action.label}
            onClick=${(e) => {
              e.stopPropagation();
              if (action.enabled === false) return;
              if (typeof onAction === "function") onAction(item, action);
            }}
          >
            ${action.label}
          </button>
        `,
      )}
    </div>
  `;
}

/**
 * Render a single attention card. Pure view; no hooks.
 *
 * @param {{
 *   item: AttentionItem,
 *   onAction?: (item: AttentionItem, action: AttentionAction) => void,
 *   onItemClick?: (item: AttentionItem) => void,
 * }} props
 */
export function AttentionItemCard(props = {}) {
  const { item, onAction, onItemClick } = props;
  if (!item || typeof item !== "object") return null;

  const severity = ATTENTION_SEVERITIES.includes(item.severity)
    ? item.severity
    : "low";
  const sevLabel = SEVERITY_LABELS[severity] || severity;
  const kindLabel = KIND_LABELS[item.kind] || item.kind;
  const sourceLabel = item.source || "unknown";
  const clearCondition = resolveClearCondition(item);
  const isUnknownKind = !ATTENTION_KINDS.includes(item.kind);

  return html`
    <article
      class=${`attention-item-card attention-item-card--sev-${severity}`}
      data-kind=${item.kind}
      data-severity=${severity}
      onClick=${onItemClick ? () => onItemClick(item) : undefined}
      role=${onItemClick ? "button" : undefined}
    >
      <header class="attention-item-card__head">
        <span class=${`attention-item-card__sev attention-item-card__sev--${severity}`}>${sevLabel}</span>
        <span class="attention-item-card__kind" data-unknown-kind=${isUnknownKind ? "true" : undefined}>${kindLabel}</span>
        <span class="attention-item-card__source" title=${`source: ${sourceLabel}`}>${sourceLabel}</span>
      </header>
      <div class="attention-item-card__title">${item.title}</div>
      ${typeof item.detail === "string" && item.detail.length > 0
        ? html`<div class="attention-item-card__detail">${item.detail}</div>`
        : null}
      ${clearCondition
        ? html`
            <div class="attention-item-card__clear" data-field="clearCondition">
              <span class="attention-item-card__clear-label">Clears when</span>
              <span class="attention-item-card__clear-text">${clearCondition}</span>
            </div>
          `
        : null}
      ${renderActions(item.recommendedActions, item, onAction)}
    </article>
  `;
}

export const ATTENTION_ITEM_CARD_KIND_LABELS = KIND_LABELS;
export const ATTENTION_ITEM_CARD_SEVERITY_LABELS = SEVERITY_LABELS;
