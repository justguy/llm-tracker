import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";
import { buildHeroSummary } from "./lib/hero-strip.js";
import { Bracket } from "./primitives.js";

export function useOutsideClose(ref, onClose, enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [enabled]);
}

export function Header({
  slugs,
  projects,
  activeSlug,
  setActive,
  project,
  pinnedProjectNames,
  workspace,
  filter,
  setFilter,
  searchMode,
  onSearchModeChange,
  searchMeta,
  headerCollapsed,
  onToggleHeaderCollapse,
  theme,
  onToggleTheme,
  onOpenHelp,
  onOpenDrawer,
  onOpenSettings,
  onOpenHistory,
  onOpenIntel,
  onUndo,
  onRedo,
  onDeleteProject,
  onCollapseAll,
  onExpandAll,
  onOpenPalette,
  pinnedSlugs,
  onTogglePinProject
}) {
  const meta = project?.data?.meta;
  const projectName = meta?.name || activeSlug || "AWAITING PROJECT";
  const rev = project?.rev ?? null;
  const isPinned = Array.isArray(pinnedSlugs) && activeSlug ? pinnedSlugs.includes(activeSlug) : false;

  const [projectOpen, setProjectOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const projectRef = useRef(null);
  const overflowRef = useRef(null);

  useOutsideClose(projectRef, () => setProjectOpen(false), projectOpen);
  useOutsideClose(overflowRef, () => setOverflowOpen(false), overflowOpen);

  useEffect(() => {
    if (!overflowOpen) return undefined;
    const handler = (e) => { if (e.key === "Escape") setOverflowOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [overflowOpen]);

  useEffect(() => {
    if (!projectOpen) return undefined;
    const handler = (e) => { if (e.key === "Escape") setProjectOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [projectOpen]);

  const hasProject = !!project?.slug;

  if (headerCollapsed) {
    const summary = hasProject ? buildHeroSummary(project, project.slug) : null;
    return html`
      <div class="app-header app-header--collapsed">
        <div class="top-bar top-bar--collapsed">
          <div class="top-bar__identity">
            <div class="top-bar__project-row">
              <span class="top-bar__project-name" title=${projectName}>${projectName}</span>
              ${rev != null ? html`<span class="top-bar__rev">REV ${rev}</span>` : null}
            </div>
          </div>
          ${summary ? html`
            <div class="top-bar__summary" aria-label="Project summary">
              <span class="top-bar__summary-pct">${summary.pct}<span class="top-bar__summary-unit">%</span></span>
              <div class="top-bar__summary-bar" aria-hidden="true">
                <div class="top-bar__summary-seg top-bar__summary-seg--ok" style=${`width:${summary.completeW}%`}></div>
                <div class="top-bar__summary-seg top-bar__summary-seg--warn" style=${`width:${summary.warnW}%`}></div>
              </div>
              <span class="top-bar__summary-text">${summary.complete}/${summary.total} complete</span>
              ${summary.inProgress > 0 ? html`<span class="top-bar__summary-chip top-bar__summary-chip--warn">${summary.inProgress} in progress</span>` : null}
              ${summary.blockedCount > 0 ? html`<span class="top-bar__summary-chip top-bar__summary-chip--block">${summary.blockedCount} blocked</span>` : null}
            </div>
          ` : null}
          <div class="top-bar__spacer"></div>
          <${Bracket}
            label="NEXT"
            onClick=${() => onOpenIntel("next")}
            disabled=${!hasProject}
            title="Recommended next task"
          />
          <${Bracket}
            label="⌘K"
            onClick=${() => onOpenPalette && onOpenPalette()}
            title="Open command palette"
          />
          <${Bracket}
            label="▾"
            soft=${true}
            onClick=${onToggleHeaderCollapse}
            title="Expand header"
            ariaLabel="Expand header"
          />
        </div>
      </div>
    `;
  }

  return html`
    <div class="app-header">
      <div class="top-bar">

        <div class="top-bar__identity" ref=${projectRef}>
          <div class="top-bar__project-row">
            <button
              class="top-bar__project-btn"
              onClick=${() => setProjectOpen((v) => !v)}
              aria-label="Switch project"
              aria-expanded=${projectOpen ? "true" : "false"}
              aria-haspopup="menu"
              title="Switch project"
            >
              <span class="top-bar__project-name">${projectName}</span>
              <span class="top-bar__caret">▾</span>
            </button>
            ${rev != null ? html`<span class="top-bar__rev">REV ${rev}</span>` : null}
            ${onTogglePinProject && hasProject ? html`
              <${Bracket}
                label=${isPinned ? "PINNED" : "PIN"}
                active=${isPinned}
                onClick=${() => onTogglePinProject(activeSlug)}
                title=${isPinned ? "Unpin this project" : "Pin this project to the workspace"}
                ariaLabel=${isPinned ? "Unpin project" : "Pin project"}
              />
            ` : null}
          </div>
          ${projectOpen ? html`
            <div class="project-menu" role="menu">
              <div class="project-menu__header">
                <span>PROJECTS</span>
                <span class="project-menu__count">${slugs.length} total</span>
              </div>
              ${slugs.map((s) => {
                const p = projects[s];
                const d = p?.derived;
                const name = p?.data?.meta?.name || s;
                const isActive = s === activeSlug;
                return html`
                  <div
                    key=${s}
                    class=${`project-menu__item${isActive ? " project-menu__item--active" : ""}`}
                    role="menuitem"
                    tabIndex="0"
                    onClick=${() => { setActive(s); setProjectOpen(false); }}
                    onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive(s); setProjectOpen(false); } }}
                  >
                    <span class="project-menu__dot">${isActive ? "●" : ""}</span>
                    <span class="project-menu__name">${name}</span>
                    <span class="project-menu__meta">rev ${p?.rev ?? "—"} · ${d?.pct ?? 0}%</span>
                  </div>
                `;
              })}
              <div class="project-menu__divider"></div>
              <div
                class="project-menu__footer"
                role="menuitem"
                tabIndex="0"
                onClick=${() => { setProjectOpen(false); onOpenDrawer(); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setProjectOpen(false); onOpenDrawer(); } }}
              >
                <span>Open overview drawer</span>
                <span class="project-menu__footer-hint">for pin &amp; manage</span>
              </div>
            </div>
          ` : null}
        </div>

        <div class="top-bar__spacer"></div>

        <div class="top-bar__cluster">
          <span class="top-bar__cluster-label">agent</span>
          <${Bracket}
            label="NEXT"
            active=${true}
            onClick=${() => onOpenIntel("next")}
            disabled=${!hasProject}
            title="Deterministic next-task shortlist"
          />
          <${Bracket}
            label="BLOCKERS"
            onClick=${() => onOpenIntel("blockers")}
            disabled=${!hasProject}
            title="Blocked tasks and blockers"
          />
          <${Bracket}
            label="CHANGED"
            onClick=${() => onOpenIntel("changed")}
            disabled=${!hasProject}
            title="Recent changed tasks"
          />
          <${Bracket}
            label="DECISIONS"
            onClick=${() => onOpenIntel("decisions")}
            disabled=${!hasProject}
            title="Recent decision notes"
          />
        </div>

        <div class="top-bar__divider"></div>

        <div class="top-bar__cluster">
          <span class="top-bar__cluster-label">history</span>
          <${Bracket}
            label="UNDO"
            onClick=${onUndo}
            disabled=${!rev || rev < 2}
            title=${rev >= 2 ? "Undo the most recent effective change" : "Nothing to undo"}
          />
          <${Bracket}
            label="REDO"
            onClick=${onRedo}
            disabled=${!hasProject}
            title="Redo the latest undo if available"
          />
        </div>

        <div class="top-bar__divider"></div>

        <button
          class="top-bar__palette"
          onClick=${() => onOpenPalette && onOpenPalette()}
          title="Search and run commands (⌘K)"
          aria-label="Open command palette"
        >
          <span class="top-bar__palette-hint">⌘K</span>
          <span class="top-bar__palette-text">filter · search · run command</span>
        </button>

        <div ref=${overflowRef} style="position:relative;flex-shrink:0;">
          <${Bracket}
            label="⋯"
            onClick=${() => setOverflowOpen((v) => !v)}
            title="More actions"
            ariaExpanded=${overflowOpen}
            ariaHaspopup="menu"
          />
          ${overflowOpen ? html`
            <ul class="overflow-menu" role="menu">

              <li class="overflow-menu__item" role="menuitem" tabIndex="0"
                onClick=${() => { onCollapseAll && onCollapseAll(); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCollapseAll && onCollapseAll(); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">⊟</span>
                <span class="overflow-menu__label">Collapse all lanes</span>
              </li>
              <li class="overflow-menu__item" role="menuitem" tabIndex="0"
                onClick=${() => { onExpandAll && onExpandAll(); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onExpandAll && onExpandAll(); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">⊠</span>
                <span class="overflow-menu__label">Expand all lanes</span>
              </li>

              <li class="overflow-menu__divider" role="separator"></li>

              <li class="overflow-menu__item" role="menuitem" tabIndex="0"
                onClick=${() => { onOpenHistory(); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenHistory(); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">⎌</span>
                <span class="overflow-menu__label">Open history</span>
              </li>
              <li class="overflow-menu__item" role="menuitem" tabIndex="0"
                onClick=${() => { onOpenDrawer(); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenDrawer(); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">◧</span>
                <span class="overflow-menu__label">Overview</span>
              </li>

              <li class="overflow-menu__divider" role="separator"></li>

              <li class="overflow-menu__item" role="menuitem" tabIndex="0"
                onClick=${() => { onToggleTheme(); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleTheme(); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">☼</span>
                <span class="overflow-menu__label">Toggle theme</span>
                <span class="overflow-menu__hint">${theme}</span>
              </li>

              <li class="overflow-menu__divider" role="separator"></li>

              <li class="overflow-menu__item" role="menuitem" tabIndex="0"
                onClick=${() => { onOpenSettings(); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenSettings(); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">⚙</span>
                <span class="overflow-menu__label">Settings</span>
              </li>
              <li class="overflow-menu__item" role="menuitem" tabIndex="0"
                onClick=${() => { onOpenHelp(); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenHelp(); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">?</span>
                <span class="overflow-menu__label">Help</span>
              </li>
              <li class="overflow-menu__item overflow-menu__item--destructive" role="menuitem" tabIndex="0"
                onClick=${() => { onDeleteProject(project?.slug); setOverflowOpen(false); }}
                onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDeleteProject(project?.slug); setOverflowOpen(false); } }}
              >
                <span class="overflow-menu__icon">⌫</span>
                <span class="overflow-menu__label">Delete project</span>
              </li>

            </ul>
          ` : null}
        </div>

        <${Bracket}
          label="▴"
          soft=${true}
          onClick=${onToggleHeaderCollapse}
          title="Collapse header"
          ariaLabel="Collapse header"
        />

      </div>
    </div>
  `;
}
