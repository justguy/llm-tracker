import { useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { SegBar } from "./primitives.js";

// ─────── Overview drawer ───────
export function Drawer({ open, pinned, onTogglePin, onClose, projects, activeSlug, onSelect, onDelete, pinnedSlugs, onTogglePinProject }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !pinned) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pinned, onClose]);

  if (!open) return null;

  const slugs = Object.keys(projects).sort();

  const drawerEl = html`
    <aside class=${`drawer ${pinned ? "pinned" : ""}`} role="dialog" aria-label="Project overview" aria-modal=${!pinned ? "true" : "false"} onClick=${(e) => e.stopPropagation()}>
        <div class="drawer-header">
          <span class="brand">[OVERVIEW] · ALL PROJECTS</span>
          <div class="drawer-header-actions">
            <button
              class=${`icon-btn ${pinned ? "active" : ""}`}
              onClick=${onTogglePin}
              aria-label=${pinned ? "Unpin drawer" : "Pin drawer open"}
              title=${pinned ? "Unpin" : "Pin drawer (persists)"}
            >${pinned ? "[PINNED]" : "[PIN]"}</button>
            <button class="icon-btn" aria-label="Close drawer" onClick=${onClose} title="Close (Esc)">×</button>
          </div>
        </div>
        <div class="drawer-body">
          ${slugs.length === 0
            ? html`<div class="drawer-empty">No projects yet.</div>`
            : slugs.map((s) => {
                const p = projects[s];
                const d = p.derived;
                const active = s === activeSlug;
                const err = p.error;
                return html`
                  <div
                    key=${s}
                    class=${`drawer-project ${active ? "active" : ""}`}
                    role="button"
                    tabIndex="0"
                    onClick=${() => onSelect(s)}
                    onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s); } }}
                  >
                    <div class="drawer-project-row">
                      <span class="drawer-project-name">${p.data?.meta?.name || s}</span>
                      ${err ? html`<span class="badge blocked">${err.kind}</span>` : null}
                      <span class="drawer-project-pct">${d?.pct ?? 0}%</span>
                      ${onTogglePinProject
                        ? html`<button
                            class=${`drawer-project-pin ${pinnedSlugs?.includes(s) ? "active" : ""}`}
                            title=${pinnedSlugs?.includes(s) ? "Unpin from workspace" : "Pin to workspace"}
                            onClick=${(e) => {
                              e.stopPropagation();
                              onTogglePinProject(s);
                            }}
                          >${pinnedSlugs?.includes(s) ? "[PINNED]" : "[PIN]"}</button>`
                        : null}
                      <button
                        class="drawer-project-delete"
                        aria-label=${`Delete project ${s}`}
                        title=${`Delete ${s}`}
                        onClick=${(e) => {
                          e.stopPropagation();
                          onDelete(s);
                        }}
                      >×</button>
                    </div>
                    <div class="drawer-project-slug">${s}</div>
                    ${d
                      ? html`
                        <${SegBar} counts=${d.counts} total=${d.total} thin />
                        <div class="drawer-project-meta">
                          <span>${d.total} TASKS</span>
                          <span class="active-count">${d.counts.in_progress || 0} ACTIVE</span>
                          <span>${d.counts.complete || 0} DONE</span>
                          ${(d.counts.not_started || 0) > 0
                            ? html`<span>${d.counts.not_started} TODO</span>`
                            : null}
                        </div>
                      `
                      : html`<div class="drawer-project-meta"><span>NOT YET LOADED</span></div>`}
                  </div>
                `;
              })}
        </div>
      </aside>
  `;

  if (pinned) return drawerEl;

  return html`
    <div class="drawer-overlay" onClick=${onClose}>${drawerEl}</div>
  `;
}

// ─────── Empty state ───────
export function EmptyState({ workspace, onOpenHelp }) {
  return html`
    <div class="empty-state">
      <h2>${">"} No projects registered</h2>
      <p>
        The tracker auto-discovers projects in the trackers/ folder. Click <b>[HELP]</b> for the paste-ready prompt to give your LLM.
      </p>
      <button class="big-btn" onClick=${onOpenHelp}>[HELP · HOW TO REGISTER A PROJECT]</button>
    </div>
  `;
}

export function ConnectionPip({ up }) {
  return html`
    <div class=${`connection-pip ${up ? "" : "down"}`}>
      <span class="dot"></span>
      <span>${up ? "live" : "reconnecting"}</span>
    </div>
  `;
}
