// ui/attention/AttentionStrip.js — SH-4-06 (TDD v0.5 §8A.3, §8A.4, §23.2 #7, §23.2 #16)
//
// AttentionStrip — persistent high-signal attention surface shown across the
// Hub, project board, task detail, and Triage. Renders the top items from the
// `AttentionEngine` projection (TDD §8A.4 — `GET /api/attention?scope=global
// &limit=5`), each as a compact card with a severity chip, source label,
// title/detail, and recommended-action chips.
//
// Behavior rules (per §23.2 #16):
//   - `attention.acknowledged` hides items from the strip (still visible in
//     Triage). filterStripItems drops acked entries entirely.
//   - `attention.snoozed` hides until `snoozedUntil`; severity escalation in
//     the source projection would have re-raised them by then.
//   - `attention.cleared` items are filtered too — the source has resolved.
//
// Critical-when-collapsed (§8A.4 "never silently buries critical items"):
//   - When the strip is collapsed AND at least one critical item is active,
//     the count chip is shown alongside a "critical" sub-badge listing each
//     critical title. Non-critical cards stay hidden; critical visibility is
//     forced through the collapsed surface so the operator cannot miss it.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

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
 */

/**
 * True when `item` should appear in the strip. Drops cleared, acked, and
 * future-snoozed items per §23.2 #16. Past-snoozed items revert to active.
 *
 * @param {AttentionItem} item
 * @param {Date} now
 * @returns {boolean}
 */
export function isItemActive(item, now) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.clearedAt === "string" && item.clearedAt.length > 0) return false;
  if (typeof item.acknowledgedAt === "string" && item.acknowledgedAt.length > 0) return false;
  if (typeof item.snoozedUntil === "string" && item.snoozedUntil.length > 0) {
    const until = Date.parse(item.snoozedUntil);
    if (Number.isFinite(until) && until > now.getTime()) return false;
  }
  return true;
}

/**
 * Filter the input list to active strip items.
 *
 * @param {AttentionItem[]} items
 * @param {Date} now
 * @returns {AttentionItem[]}
 */
export function filterActiveItems(items, now) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => isItemActive(item, now));
}

/**
 * Items with severity === "critical" among the active set.
 *
 * @param {AttentionItem[]} items
 * @param {Date} now
 * @returns {AttentionItem[]}
 */
export function criticalItems(items, now) {
  return filterActiveItems(items, now).filter((i) => i.severity === "critical");
}

/**
 * Strip card. Renders the severity chip, title, source label, optional
 * detail, and the recommendedActions as chips. Mirror with Triage cards by
 * design — both surfaces share the same primitive look-and-feel.
 */
function StripCard({ item, onAction, onItemClick }) {
  if (!item) return null;
  const sevLabel = SEVERITY_LABELS[item.severity] || item.severity;
  const sourceLabel = item.source || "unknown";
  return html`
    <div
      class=${`attention-strip__card attention-strip__card--sev-${item.severity}`}
      onClick=${onItemClick ? () => onItemClick(item) : undefined}
      role=${onItemClick ? "button" : undefined}
    >
      <div class="attention-strip__card-head">
        <span class=${`attention-strip__sev attention-strip__sev--${item.severity}`}>${sevLabel}</span>
        <span class="attention-strip__kind">${KIND_LABELS[item.kind] || item.kind}</span>
        <span class="attention-strip__source" title=${`source: ${sourceLabel}`}>${sourceLabel}</span>
      </div>
      <div class="attention-strip__title">${item.title}</div>
      ${renderActions(item.recommendedActions, item, onAction)}
    </div>
  `;
}

function renderActions(actions, item, onAction) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  return html`
    <div class="attention-strip__actions">
      ${actions.map(
        (action) => html`
          <button
            key=${action.id}
            class=${`attention-strip__action ${action.enabled === false ? "attention-strip__action--disabled" : ""}`}
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
        `
      )}
    </div>
  `;
}

/**
 * Pure render component. Tests target this view via the vnode-walk pattern
 * used elsewhere in the codebase. No hooks here — the hook-using container
 * lives in `AttentionStrip` below.
 *
 * @param {{
 *   items: AttentionItem[],
 *   now: Date,
 *   collapsed: boolean,
 *   onToggleCollapsed?: () => void,
 *   onAction?: (item: AttentionItem, action: object) => void,
 *   onItemClick?: (item: AttentionItem) => void,
 *   loadError?: string,
 * }} props
 */
export function AttentionStripView(props = {}) {
  const {
    items: itemsProp,
    now: nowProp,
    collapsed,
    onToggleCollapsed,
    onAction,
    onItemClick,
    loadError,
  } = props;
  const now = nowProp instanceof Date ? nowProp : new Date();
  const active = filterActiveItems(itemsProp, now);
  const crit = active.filter((i) => i.severity === "critical");

  // Hide entirely when there's nothing active AND no load error.
  if (active.length === 0 && !loadError) return null;

  return html`
    <aside
      class=${`attention-strip ${collapsed ? "attention-strip--collapsed" : ""}`}
      data-collapsed=${String(Boolean(collapsed))}
      aria-label="Attention strip"
    >
      <button
        type="button"
        class="attention-strip__toggle"
        onClick=${onToggleCollapsed}
        title=${collapsed ? "Expand attention strip" : "Collapse attention strip"}
      >
        <span class="attention-strip__count" data-count=${active.length}>${active.length}</span>
        <span class="attention-strip__label">attention</span>
        ${crit.length > 0
          ? html`<span class="attention-strip__critical-marker" data-critical=${crit.length}>${crit.length} critical</span>`
          : null}
      </button>
      ${loadError
        ? html`<div class="attention-strip__error">Couldn't load attention (${loadError})</div>`
        : null}
      ${collapsed
        ? crit.length > 0
          ? html`
              <div class="attention-strip__critical-banner" role="list">
                ${crit.map(
                  (item) => html`
                    <${StripCard}
                      key=${item.id}
                      item=${item}
                      onAction=${onAction}
                      onItemClick=${onItemClick}
                    />
                  `
                )}
              </div>
            `
          : null
        : html`
            <div class="attention-strip__items" role="list">
              ${active.map(
                (item) => html`
                  <${StripCard}
                    key=${item.id}
                    item=${item}
                    onAction=${onAction}
                    onItemClick=${onItemClick}
                  />
                `
              )}
            </div>
          `}
    </aside>
  `;
}

/**
 * Stateful container. If `items` is supplied (tests, embedded surfaces), the
 * fetch is skipped. Otherwise fetches `fetchUrl` on mount and renders the
 * view. Graceful empty state on 404/error.
 *
 * @param {{
 *   items?: AttentionItem[],
 *   fetchUrl?: string,
 *   defaultCollapsed?: boolean,
 *   now?: Date,
 *   onAction?: (item: AttentionItem, action: object) => void,
 *   onItemClick?: (item: AttentionItem) => void,
 * }} props
 */
export function AttentionStrip(props = {}) {
  const {
    items: itemsProp,
    fetchUrl = "/api/attention?scope=global&limit=5",
    defaultCollapsed = false,
    now,
    onAction,
    onItemClick,
  } = props;

  const [fetched, setFetched] = useState(/** @type {AttentionItem[] | null} */ (null));
  const [loadError, setLoadError] = useState("");
  const [collapsed, setCollapsed] = useState(Boolean(defaultCollapsed));

  useEffect(() => {
    if (Array.isArray(itemsProp)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(fetchUrl);
        if (!res.ok) {
          if (!cancelled) setLoadError(`HTTP ${res.status}`);
          return;
        }
        const body = await res.json().catch(() => null);
        const next = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
        if (!cancelled) setFetched(next);
      } catch (err) {
        if (!cancelled) setLoadError(err?.message || "fetch failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemsProp, fetchUrl]);

  const items = Array.isArray(itemsProp) ? itemsProp : Array.isArray(fetched) ? fetched : [];
  return html`
    <${AttentionStripView}
      items=${items}
      now=${now}
      collapsed=${collapsed}
      onToggleCollapsed=${() => setCollapsed((v) => !v)}
      loadError=${loadError}
      onAction=${onAction}
      onItemClick=${onItemClick}
    />
  `;
}

export const ATTENTION_STRIP_KIND_LABELS = KIND_LABELS;
export const ATTENTION_STRIP_SEVERITY_LABELS = SEVERITY_LABELS;
