// ui/triage/TriagePage.js — SH-4-07 (TDD v0.5 §8A.3, §8A.4, §23.2 #16)
//
// Triage page: full ordered AttentionItem inventory laid out as four severity
// lanes (Critical / High / Medium / Low), each grouped by kind. Cards mirror
// the AttentionStrip primitives — kind/title, source label, recommendedActions
// chips. sh-4-06 owns ui/attention/AttentionStrip.* and that file is being
// built in parallel; we keep local card primitives here so this module stays
// inside its allowed_paths (`ui/triage/**`) and does not import from a sibling
// that may not yet exist. The duplication is small (~20 lines) and the action
// wiring is identical in both surfaces because sh-4-08 will own the live
// dispatch.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { decorateAttentionActions, dispatchAttentionAction } from "../attention/actions.js";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

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
 * Drop items the Triage page should never surface. Per §23.2 #16
 * `attention.cleared` is the source's "this is done" signal — we hide cleared
 * items entirely. Acked and snoozed items remain visible (dimmed) so the
 * operator can still re-engage from Triage.
 *
 * @param {AttentionItem[]} items
 * @returns {AttentionItem[]}
 */
export function filterTriageItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (typeof item.clearedAt === "string" && item.clearedAt.length > 0) return false;
    return true;
  });
}

/**
 * True when the item is acked OR snoozed-until-future relative to `now`.
 * Dimmed cards remain in Triage per §23.2 #16.
 *
 * @param {AttentionItem} item
 * @param {Date} now
 * @returns {boolean}
 */
export function isItemDimmed(item, now) {
  if (!item) return false;
  if (typeof item.acknowledgedAt === "string" && item.acknowledgedAt.length > 0) {
    return true;
  }
  if (typeof item.snoozedUntil === "string" && item.snoozedUntil.length > 0) {
    const until = Date.parse(item.snoozedUntil);
    if (Number.isFinite(until) && until > now.getTime()) return true;
  }
  return false;
}

/**
 * Pivot the active item list into the lane-by-kind shape the page renders.
 * Severities follow §8A.3 highest→lowest; kinds within a lane sort by their
 * §8A.3 priority slot for stable display order.
 *
 * @param {AttentionItem[]} items
 * @returns {{severity: string, count: number, kinds: { kind: string, items: AttentionItem[] }[] }[]}
 */
export function groupBySeverityThenKind(items) {
  const filtered = filterTriageItems(items);
  /** @type {Record<string, Map<string, AttentionItem[]>>} */
  const buckets = {};
  for (const sev of SEVERITY_ORDER) buckets[sev] = new Map();

  for (const item of filtered) {
    const sev = SEVERITY_ORDER.includes(item.severity) ? item.severity : "low";
    const bucket = buckets[sev];
    const list = bucket.get(item.kind) || [];
    list.push(item);
    bucket.set(item.kind, list);
  }

  return SEVERITY_ORDER.map((severity) => {
    const bucket = buckets[severity];
    const kindRows = [];
    for (const [kind, list] of bucket) {
      kindRows.push({ kind, items: list });
    }
    // Stable ordering within a lane: kinds with more items first, then
    // alphabetical by kind for determinism in tests.
    kindRows.sort((a, b) => {
      if (a.items.length !== b.items.length) return b.items.length - a.items.length;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    });
    const count = kindRows.reduce((acc, k) => acc + k.items.length, 0);
    return { severity, count, kinds: kindRows };
  });
}

/**
 * Single attention card. Mirrors the AttentionStrip primitives — severity
 * chip, title, source label, detail, recommendedAction chips. The card itself
 * is non-interactive on its container click except via the explicit
 * onItemClick callback (avoids accidental drills when the operator clicks a
 * chip).
 */
function TriageCard({ item, dimmed, onAction, onItemClick, actionOptions }) {
  if (!item) return null;
  const sevLabel = SEVERITY_LABELS[item.severity] || item.severity;
  const sourceLabel = item.source || "unknown";
  const cardClass =
    `triage__card triage__card--sev-${item.severity}` +
    (dimmed ? " triage__card--dimmed" : "");
  return html`
    <div
      class=${cardClass}
      onClick=${onItemClick ? () => onItemClick(item) : undefined}
      role=${onItemClick ? "button" : undefined}
    >
      <div class="triage__card-head">
        <span class=${`triage__sev triage__sev--${item.severity}`}>${sevLabel}</span>
        <span class="triage__title">${item.title}</span>
        <span class="triage__source" title=${`source: ${sourceLabel}`}>${sourceLabel}</span>
        ${dimmed ? html`<span class="triage__dim-label">muted</span>` : null}
      </div>
      ${item.detail ? html`<div class="triage__detail">${item.detail}</div>` : null}
      ${renderActions(item.recommendedActions, item, onAction, actionOptions)}
    </div>
  `;
}

function renderActions(actions, item, onAction, actionOptions) {
  const decorated = decorateAttentionActions(actions, item, actionOptions);
  if (decorated.length === 0) return null;
  return html`
    <div class="triage__actions">
      ${decorated.map(
        (action) => html`
          <button
            key=${action.id}
            class=${`triage__action ${action.enabled === false ? "triage__action--disabled" : ""}`}
            type="button"
            disabled=${action.enabled === false}
            title=${action.disabledReason || action.label}
            onClick=${(e) => {
              e.stopPropagation();
              if (action.enabled === false) return;
              runAttentionAction(item, action, onAction, actionOptions);
            }}
          >
            ${action.label}
          </button>
        `
      )}
    </div>
  `;
}

function runAttentionAction(item, action, onAction, actionOptions) {
  if (typeof onAction === "function") {
    onAction(item, action);
    return;
  }
  dispatchAttentionAction(item, action, actionOptions).catch((err) => {
    console.error("Attention action dispatch failed:", err?.message || err);
  });
}

/**
 * Pure render component. No hooks — safe to call directly in tests via the
 * vnode-walk pattern used elsewhere in this codebase. Tests target this view.
 *
 * @param {{
 *   items: AttentionItem[],
 *   now: Date,
 *   loadError?: string,
 *   onAction?: (item: AttentionItem, action: object) => void,
 *   onItemClick?: (item: AttentionItem) => void,
 *   actionOptions?: object,
 * }} props
 */
export function TriagePageView(props = {}) {
  const {
    items: itemsProp,
    now: nowProp,
    loadError,
    onAction,
    onItemClick,
    actionOptions,
  } = props;
  const items = Array.isArray(itemsProp) ? itemsProp : [];
  const now = nowProp instanceof Date ? nowProp : new Date();
  const lanes = groupBySeverityThenKind(items);

  return html`
    <section class="triage">
      <header class="triage__head">
        <h1 class="triage__heading">Triage</h1>
        ${loadError ? html`<div class="triage__error">Couldn't load attention (${loadError})</div>` : null}
      </header>
      <div class="triage__lanes">
        ${lanes.map(
          (lane) => html`
            <section
              key=${lane.severity}
              class=${`triage__lane triage__lane--${lane.severity}`}
              data-severity=${lane.severity}
            >
              <header class="triage__lane-head">
                <span class="triage__lane-title">${SEVERITY_LABELS[lane.severity]}</span>
                <span class="triage__lane-count">${lane.count}</span>
              </header>
              ${lane.count === 0
                ? html`<div class="triage__empty">All clear</div>`
                : lane.kinds.map(
                    (cluster) => html`
                      <div key=${cluster.kind} class="triage__cluster">
                        <h3 class="triage__kind">
                          ${KIND_LABELS[cluster.kind] || cluster.kind}
                          <span class="triage__kind-count">· ${cluster.items.length}</span>
                        </h3>
                        ${cluster.items.map(
                          (item) => html`
                            <${TriageCard}
                              key=${item.id}
                              item=${item}
                              dimmed=${isItemDimmed(item, now)}
                              onAction=${onAction}
                              onItemClick=${onItemClick}
                              actionOptions=${actionOptions}
                            />
                          `
                        )}
                      </div>
                    `
                  )}
            </section>
          `
        )}
      </div>
    </section>
  `;
}

/**
 * Stateful container. Fetches `/api/attention?scope=global` on mount unless
 * `items` is supplied. Endpoint absence renders a graceful empty state.
 *
 * @param {{
 *   items?: AttentionItem[],
 *   fetchUrl?: string,
 *   now?: Date,
 *   onAction?: (item: AttentionItem, action: object) => void,
 *   onItemClick?: (item: AttentionItem) => void,
 *   actionOptions?: object,
 * }} props
 */
export function TriagePage(props = {}) {
  const {
    items: itemsProp,
    fetchUrl = "/api/attention?scope=global",
    now,
    onAction,
    onItemClick,
    actionOptions,
  } = props;

  const [fetched, setFetched] = useState(/** @type {AttentionItem[] | null} */ (null));
  const [loadError, setLoadError] = useState("");

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
    <${TriagePageView}
      items=${items}
      now=${now}
      loadError=${loadError}
      onAction=${onAction}
      onItemClick=${onItemClick}
      actionOptions=${actionOptions}
    />
  `;
}

export const TRIAGE_SEVERITY_ORDER = SEVERITY_ORDER;
export const TRIAGE_SEVERITY_LABELS = SEVERITY_LABELS;
export const TRIAGE_KIND_LABELS = KIND_LABELS;
