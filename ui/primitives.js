import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";

export const STATUS_ORDER = ["complete", "in_progress", "not_started", "deferred"];

export function SegBar({ counts, total, thin }) {
  const pct = (k) => (total === 0 ? 0 : ((counts[k] || 0) / total) * 100);
  return html`
    <div class=${`seg-bar ${thin ? "thin" : ""}`}>
      ${STATUS_ORDER.map(
        (k) =>
          html`<span class=${`seg-${k}`} style=${`width: ${pct(k)}%`} title=${`${k}: ${counts[k] || 0}`}></span>`
      )}
    </div>
  `;
}

export function Badge({ kind, children, title }) {
  return html`<span class=${`badge ${kind || ""}`} title=${title || ""}>${children}</span>`;
}

export function CommentBadge({ comment, onSave }) {
  const badgeRef = useRef(null);
  const popRef = useRef(null);
  const textareaRef = useRef(null);
  const [mode, setMode] = useState(null);
  const [pos, setPos] = useState(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const hasComment = !!comment;

  const openRead = () => {
    if (!hasComment || mode === "edit") return;
    setMode("read");
    setPos({ placeholder: true });
  };
  const closeRead = () => {
    if (mode === "read") {
      setMode(null);
      setPos(null);
    }
  };
  const openEdit = (e) => {
    e?.stopPropagation();
    e?.preventDefault();
    setDraft(comment || "");
    setMode("edit");
    setPos({ placeholder: true });
  };
  const cancelEdit = () => {
    setMode(null);
    setPos(null);
    setDraft("");
  };
  const commit = async () => {
    if (!onSave || saving) return;
    const trimmed = draft.trim();
    const value = trimmed === "" ? null : draft;
    if (value && value.length > 500) return;
    setSaving(true);
    const ok = await onSave(value);
    setSaving(false);
    if (ok) cancelEdit();
  };
  const activateFromKeyboard = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    openEdit(e);
  };

  useEffect(() => {
    if (!pos || !pos.placeholder || !popRef.current) return;
    const b = badgeRef.current?.getBoundingClientRect();
    const p = popRef.current.getBoundingClientRect();
    if (!b) return;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = b.top - p.height - 6;
    if (top < margin) top = b.bottom + 6;
    if (top + p.height > vh - margin) top = Math.max(margin, vh - margin - p.height);
    let left = b.left + b.width / 2 - p.width / 2;
    if (left < margin) left = margin;
    if (left + p.width > vw - margin) left = vw - margin - p.width;
    setPos({ placeholder: false, top, left });
  }, [pos?.placeholder, mode]);

  useEffect(() => {
    if (mode === "edit") textareaRef.current?.focus();
  }, [mode]);

  const badgeClass = `badge comment-badge ${hasComment ? "" : "empty"}`;
  const badgeLabel = hasComment ? "[C]" : "[+C]";
  const badgeTitle = hasComment
    ? "Comment — hover to read, click to edit"
    : "Add a comment";

  return html`
    <span
      ref=${badgeRef}
      class=${badgeClass}
      onMouseEnter=${openRead}
      onMouseLeave=${closeRead}
      onFocus=${openRead}
      onBlur=${closeRead}
      onClick=${openEdit}
      onKeyDown=${activateFromKeyboard}
      onMouseDown=${(e) => e.stopPropagation()}
      tabIndex="0"
      role="button"
      title=${badgeTitle}
    >${badgeLabel}</span>
    ${mode === "read" && pos
      ? html`<div
          ref=${popRef}
          class="comment-popover"
          style=${`top: ${pos.top}px; left: ${pos.left}px; visibility: ${pos.placeholder ? "hidden" : "visible"};`}
          role="tooltip"
        >${comment}</div>`
      : null}
    ${mode === "edit" && pos
      ? html`<div
          ref=${popRef}
          class="comment-editor"
          style=${`top: ${pos.top}px; left: ${pos.left}px; visibility: ${pos.placeholder ? "hidden" : "visible"};`}
          onClick=${(e) => e.stopPropagation()}
          onMouseDown=${(e) => e.stopPropagation()}
        >
          <textarea
            ref=${textareaRef}
            class="comment-textarea"
            maxlength="500"
            placeholder="plain text — ≤ 500 chars"
            value=${draft}
            onInput=${(e) => setDraft(e.currentTarget.value)}
            onKeyDown=${(e) => {
              if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
            }}
          />
          <div class="comment-editor-row">
            <span class="comment-counter">${draft.length} / 500</span>
            <span class="comment-editor-actions">
              <button class="icon-btn" onClick=${cancelEdit} disabled=${saving}>[CANCEL]</button>
              <button class="icon-btn" onClick=${commit} disabled=${saving || draft.length > 500}>
                ${saving ? "[SAVING…]" : "[SAVE]"}
              </button>
            </span>
          </div>
        </div>`
      : null}
  `;
}

export function IconBtn({ label, onClick, active, title }) {
  return html`
    <button class=${`icon-btn ${active ? "active" : ""}`} onClick=${onClick} title=${title || ""}>
      ${label}
    </button>
  `;
}

export function Bracket({ label, active, soft, tone, onClick, title, ariaLabel, ariaExpanded, ariaHaspopup, disabled }) {
  const classes = [
    "bracket",
    active ? "bracket--active" : "",
    soft ? "bracket--soft" : "",
    tone ? `bracket--tone-${tone}` : "",
  ].filter(Boolean).join(" ");
  return html`
    <button
      class=${classes}
      onClick=${onClick}
      title=${title || ""}
      aria-label=${ariaLabel || title || ""}
      aria-expanded=${ariaExpanded != null ? String(ariaExpanded) : undefined}
      aria-haspopup=${ariaHaspopup || undefined}
      disabled=${disabled || false}
    >[${label}]</button>
  `;
}

export async function copyText(text) {
  if (!text) return false;
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }

  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "absolute";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(input);
    return !!ok;
  } catch {
    return false;
  }
}

export function CopyInlineBtn({ value, label, title }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return html`
    <button
      class=${`card-copy-btn ${copied ? "copied" : ""}`}
      title=${copied ? `${label} copied` : title}
      aria-label=${copied ? `${label} copied` : title}
      onMouseDown=${(e) => e.stopPropagation()}
      onClick=${async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const ok = await copyText(value);
        if (ok) setCopied(true);
      }}
    >${copied ? "✓" : "⧉"}</button>
  `;
}

export function Dropdown({ value, options, onChange, renderLabel, className }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return html`
    <div class=${`dropdown ${open ? "open" : ""} ${className || ""}`} ref=${ref}>
      <button class="dropdown-trigger" onClick=${() => setOpen(!open)}>
        <span class="dropdown-prompt">${">"}</span>
        <span class="dropdown-value">${renderLabel(value)}</span>
        <span class="dropdown-caret">${open ? "▲" : "▼"}</span>
      </button>
      ${open
        ? html`
          <div class="dropdown-menu">
            ${options.map(
              (o) => html`
                <button
                  key=${o}
                  class=${`dropdown-item ${o === value ? "active" : ""}`}
                  onClick=${() => {
                    onChange(o);
                    setOpen(false);
                  }}
                >
                  <span class="dot">${o === value ? "●" : " "}</span>
                  ${renderLabel(o)}
                </button>
              `
            )}
          </div>
        `
        : null}
    </div>
  `;
}

export function FilterToggles({
  counts,
  statusFilters,
  toggleStatus,
  blockedCount,
  openCount,
  blockFilters,
  toggleBlock,
  boardView,
  setBoardView
}) {
  return html`
    <div class="filter-toggles">
      <div class="filter-group view-filter-group" role="group" aria-label="Board view">
        <span class="filter-label">VIEW</span>
        <button
          class=${`view-toggle ${boardView === "swimlane" ? "active" : ""}`}
          aria-pressed=${boardView === "swimlane"}
          onClick=${() => setBoardView("swimlane")}
          title="Show swimlane board"
        >
          swimlane
        </button>
        <button
          class=${`view-toggle ${boardView === "tree" ? "active" : ""}`}
          aria-pressed=${boardView === "tree"}
          onClick=${() => setBoardView("tree")}
          title="Show task tree"
        >
          tree
        </button>
        <button
          class=${`view-toggle ${boardView === "graph" ? "active" : ""}`}
          aria-pressed=${boardView === "graph"}
          onClick=${() => setBoardView("graph")}
          title="Show dependency graph"
        >
          graph
        </button>
      </div>
      <div class="filter-group">
        <span class="filter-label">STATUS</span>
        ${STATUS_ORDER.map(
          (s) => html`
            <button
              key=${s}
              class=${`status-toggle status-${s} ${statusFilters.has(s) ? "active" : ""}`}
              aria-pressed=${statusFilters.has(s)}
              onClick=${() => toggleStatus(s)}
              title=${`${s.replace("_", " ")} · ${counts[s] || 0}`}
            >
              ${s.replace("_", " ")}
              <span class="count">${counts[s] || 0}</span>
            </button>
          `
        )}
      </div>
      <div class="filter-group">
        <span class="filter-label">BLOCK</span>
        <button
          class=${`block-toggle blocked ${blockFilters.has("blocked") ? "active" : ""}`}
          aria-pressed=${blockFilters.has("blocked")}
          onClick=${() => toggleBlock("blocked")}
          title=${`blocked · ${blockedCount}`}
        >
          blocked
          <span class="count">${blockedCount}</span>
        </button>
        <button
          class=${`block-toggle open ${blockFilters.has("open") ? "active" : ""}`}
          aria-pressed=${blockFilters.has("open")}
          onClick=${() => toggleBlock("open")}
          title=${`open · ${openCount}`}
        >
          open
          <span class="count">${openCount}</span>
        </button>
      </div>
    </div>
  `;
}
