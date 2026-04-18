import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";
import { buildHeroReason, buildHeroSummary } from "./lib/hero-strip.js";
import { buildCardMetaFacts } from "./lib/intelligence.js";
import { HistoryModal } from "./modals/history.js";
import { ProjectIntelligenceModal, TaskIntelligenceModal } from "./modals/intelligence.js";
import { humanizeTaskOutcome } from "./task-outcomes.js";

const STATUS_ORDER = ["complete", "in_progress", "not_started", "deferred"];

// ─────── Settings (localStorage) ───────
const SETTINGS_KEY = "llmtracker.settings";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

// ─────── Small components ───────

function SegBar({ counts, total, thin }) {
  const pct = (k) => (total === 0 ? 0 : (counts[k] || 0) / total * 100);
  return html`
    <div class=${`seg-bar ${thin ? "thin" : ""}`}>
      ${STATUS_ORDER.map(
        (k) =>
          html`<span class=${`seg-${k}`} style=${`width: ${pct(k)}%`} title=${`${k}: ${counts[k] || 0}`}></span>`
      )}
    </div>
  `;
}

function Badge({ kind, children, title }) {
  return html`<span class=${`badge ${kind || ""}`} title=${title || ""}>${children}</span>`;
}

function CommentBadge({ comment, onSave }) {
  const badgeRef = useRef(null);
  const popRef = useRef(null);
  const textareaRef = useRef(null);
  const [mode, setMode] = useState(null); // null | "read" | "edit"
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

function IconBtn({ label, onClick, active, title }) {
  return html`
    <button class=${`icon-btn ${active ? "active" : ""}`} onClick=${onClick} title=${title || ""}>
      ${label}
    </button>
  `;
}

function Bracket({ label, active, soft, tone, onClick, title, ariaLabel, disabled }) {
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
      disabled=${disabled || false}
    >[${label}]</button>
  `;
}

async function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
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

function CopyInlineBtn({ value, label, title }) {
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

// ─────── Custom dropdown ───────
function Dropdown({ value, options, onChange, renderLabel, className }) {
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

// ─────── Filter toggles (status + block) ───────
function FilterToggles({ counts, statusFilters, toggleStatus, blockedCount, openCount, blockFilters, toggleBlock }) {
  return html`
    <div class="filter-toggles">
      <div class="filter-group">
        <span class="filter-label">STATUS</span>
        ${STATUS_ORDER.map(
          (s) => html`
            <button
              key=${s}
              class=${`status-toggle status-${s} ${statusFilters.has(s) ? "active" : ""}`}
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
          onClick=${() => toggleBlock("blocked")}
          title=${`blocked · ${blockedCount}`}
        >
          blocked
          <span class="count">${blockedCount}</span>
        </button>
        <button
          class=${`block-toggle open ${blockFilters.has("open") ? "active" : ""}`}
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

// ─────── Card / Cell / Matrix ───────

const STATUS_PILL_LABEL = {
  complete: "COMPLETE",
  in_progress: "IN PROGRESS",
  not_started: "NOT STARTED",
  deferred: "DEFERRED",
  blocked: "BLOCKED",
};

function Card({ task, blockedBy, dragging, searchMatch, fuzzyActive, onDragStart, onDragEnd, onDelete, onSaveComment, onOpenTask }) {
  const ctx = task.context || {};
  const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
  const cardFacts = buildCardMetaFacts(task, blockedBy || []);
  const outcome = humanizeTaskOutcome(task.outcome);
  const references = Array.isArray(task.references) && task.references.length
    ? task.references
    : task.reference
      ? [task.reference]
      : [];
  const summary = task.goal || ctx.notes || "";
  const classes = [
    "card",
    `status-${task.status}`,
    dragging ? "dragging" : "",
    searchMatch ? "fuzzy-hit" : "",
    fuzzyActive && !searchMatch ? "fuzzy-dim" : ""
  ].join(" ");

  return html`
    <div
      class=${classes}
      draggable="true"
      data-task-id=${task.id}
      onDragStart=${(e) => onDragStart(e, task)}
      onDragEnd=${onDragEnd}
      onClick=${() => onOpenTask && onOpenTask(task, "brief")}
    >
      <button
        class="card-delete"
        aria-label=${`Delete task ${task.id}`}
        title=${`Delete task ${task.id}`}
        onMouseDown=${(e) => e.stopPropagation()}
        onClick=${(e) => {
          e.stopPropagation();
          e.preventDefault();
          onDelete && onDelete(task);
        }}
      >×</button>

      <div class="card__tier-1">
        <div class="card-id-row">
          <div class="card-id">${task.id}</div>
          <${CopyInlineBtn}
            value=${task.id}
            label="Task id"
            title=${`Copy task id ${task.id}`}
          />
        </div>
        <div class="card-title">
          <span class="card-title-text">${task.title}</span>
          <${CopyInlineBtn}
            value=${task.title}
            label="Task title"
            title=${`Copy task title: ${task.title}`}
          />
        </div>
      </div>

      ${summary ? html`<div class="card__tier-2">${summary}</div>` : null}

      <div class="card__tier-3">
        <span class=${`card__status-pill status-${task.status}`}>
          ● ${STATUS_PILL_LABEL[task.status] || task.status.toUpperCase()}
        </span>
        ${task.assignee
          ? html`<span class="card__assignee-chip">${task.assignee}</span>`
          : null}
        ${cardFacts.map((fact) => html`
          <span key=${`${fact.label}:${fact.value}`} class=${`card__meta-chip ${fact.tone || ""}`}>
            ${fact.label}:${fact.value}
          </span>
        `)}
        ${outcome
          ? html`<span class="card__meta-chip" title=${`Outcome: ${outcome}`}>outcome·${outcome}</span>`
          : null}
        ${task.effort
          ? html`<span class="card__meta-chip" title=${`Effort: ${task.effort}`}>effort·${task.effort}</span>`
          : null}
        ${references[0]
          ? html`<button
              class="card-reference"
              title=${`Copy reference: ${references[0]}`}
              onMouseDown=${(e) => e.stopPropagation()}
              onClick=${(e) => {
                e.stopPropagation();
                e.preventDefault();
                copyText(references[0]).catch(() => {});
              }}
            >${references[0]}</button>`
          : null}
        ${references.length > 1
          ? html`<span class="card__meta-chip" title=${references.join("\n")}>refs·${references.length}</span>`
          : null}
        ${searchMatch && Number.isFinite(searchMatch.score)
          ? html`<span class="card__meta-chip" title=${`Fuzzy match ${searchMatch.score.toFixed(3)}`}>match·${searchMatch.score.toFixed(2)}</span>`
          : null}
        ${tags.map((t) => html`<span key=${t} class="card__tag-chip">#${t}</span>`)}
      </div>

      <div class="card__action-row" onMouseDown=${(e) => e.stopPropagation()}>
        ${[
          ["brief", "READ", true],
          ["why", "WHY", false],
          ["execute", "EXEC", false],
          ["verify", "VERIFY", false]
        ].map(([mode, label, active]) => html`
          <${Bracket}
            key=${mode}
            label=${label}
            active=${active}
            title=${`${label} ${task.id}`}
            onClick=${(e) => {
              e.stopPropagation();
              e.preventDefault();
              onOpenTask && onOpenTask(task, mode);
            }}
          />
        `)}
      </div>

      <${CommentBadge}
        comment=${task.comment}
        onSave=${(value) => onSaveComment && onSaveComment(task.id, value)}
      />
    </div>
  `;
}

function Cell({ laneId, priorityId, tasks, blocked, filterQuery, statusFilters, blockFilters, fuzzyQuery, fuzzyMatchMap, dragState, setDragState, onDrop, onDeleteTask, onSaveComment, onOpenTask }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);

  const matchesText = (t) => {
    if (!filterQuery) return true;
    const q = filterQuery.toLowerCase();
    if (t.title.toLowerCase().includes(q)) return true;
    if (t.id.toLowerCase().includes(q)) return true;
    if ((t.goal || "").toLowerCase().includes(q)) return true;
    const tags = (t.context && t.context.tags) || [];
    if (tags.some((tag) => String(tag).toLowerCase().includes(q))) return true;
    return false;
  };

  const matchesStatus = (t) => {
    if (!statusFilters || statusFilters.size === 0) return true;
    return statusFilters.has(t.status);
  };

  const isBlocked = (t) => blocked[t.id] && blocked[t.id].length > 0;

  const matchesBlock = (t) => {
    if (!blockFilters || blockFilters.size === 0) return true;
    return blockFilters.has(isBlocked(t) ? "blocked" : "open");
  };

  const filtered = tasks.filter((t) => matchesStatus(t) && matchesBlock(t) && matchesText(t));

  const handleDragOver = (e) => {
    if (!dragState.taskId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  const handleDragLeave = (e) => {
    if (ref.current && !ref.current.contains(e.relatedTarget)) setOver(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setOver(false);
    if (!dragState.taskId) return;
    const y = e.clientY;
    let idx = 0;
    for (const child of ref.current.children) {
      if (!child.classList || !child.classList.contains("card")) continue;
      if (child.dataset.taskId === dragState.taskId) continue;
      const cr = child.getBoundingClientRect();
      if (y > cr.top + cr.height / 2) idx++;
    }
    onDrop({ taskId: dragState.taskId, swimlaneId: laneId, priorityId, targetIndex: idx });
  };

  return html`
    <div
      class=${`cell ${over ? "drop-target" : ""}`}
      ref=${ref}
      onDragOver=${handleDragOver}
      onDragLeave=${handleDragLeave}
      onDrop=${handleDrop}
    >
      ${filtered.length === 0 && tasks.length === 0
        ? html`<div class="cell-empty">no tasks</div>`
        : null}
      ${filtered.map(
        (t) => html`
          <${Card}
            key=${t.id}
            task=${t}
            blockedBy=${blocked[t.id]}
            searchMatch=${fuzzyMatchMap?.get(t.id) || null}
            fuzzyActive=${!!(fuzzyQuery && fuzzyQuery.trim())}
            dragging=${dragState.taskId === t.id}
            onDragStart=${(e, task) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", task.id);
              setDragState({ taskId: task.id });
            }}
            onDragEnd=${() => setDragState({ taskId: null })}
            onDelete=${onDeleteTask}
            onSaveComment=${onSaveComment}
            onOpenTask=${onOpenTask}
          />
        `
      )}
    </div>
  `;
}

function Matrix({ project, filterQuery, statusFilters, blockFilters, fuzzyQuery, fuzzyMatchMap, onMove, onToggleCollapse, onMoveLane, onDeleteTask, onSaveComment, onOpenTask }) {
  const [dragState, setDragState] = useState({ taskId: null });
  const swimlanes = project.data.meta.swimlanes;
  const priorities = project.data.meta.priorities;
  const blocked = project.derived?.blocked || {};

  const byCell = useMemo(() => {
    const map = {};
    for (const t of project.data.tasks) {
      const key = `${t.placement.swimlaneId}::${t.placement.priorityId}`;
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    return map;
  }, [project]);

  const headerRow = html`
    <div class="hdr">
      <span class="brand">swimlane</span>
    </div>
    ${priorities.map(
      (p) => html`
        <div class=${`hdr hdr-priority ${p.id}`}>
          <span class="label">${p.label}</span>
          <span class="brand">${p.id}</span>
        </div>
      `
    )}
  `;

  const rows = swimlanes.map((lane) => {
    const laneIndex = swimlanes.findIndex((item) => item.id === lane.id);
    const canMoveUp = laneIndex > 0;
    const canMoveDown = laneIndex >= 0 && laneIndex < swimlanes.length - 1;
    const per = project.derived?.perSwimlane?.[lane.id] || { counts: {}, pct: 0, total: 0 };
    const active = per.counts.in_progress || 0;
    const allComplete = per.total > 0 && per.counts.complete === per.total;
    const effectiveCollapsed =
      lane.collapsed !== undefined ? lane.collapsed : allComplete;

    if (effectiveCollapsed) {
      const done = per.counts.complete || 0;
      const inProg = per.counts.in_progress || 0;
      const donePct = per.total === 0 ? 0 : (done / per.total) * 100;
      const inProgPct = per.total === 0 ? 0 : (inProg / per.total) * 100;
      return html`
        <div
          class="lane-row--collapsed"
          key=${`lane-${lane.id}`}
          onClick=${() => onToggleCollapse(lane.id, false)}
          role="button"
          tabIndex="0"
          onKeyDown=${(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleCollapse(lane.id, false);
            }
          }}
          title="Click to expand swimlane"
        >
          <div class="lane-row__label">
            <span class="lane-row__chevron">▸</span>
            <span class="lane-row__title" title=${lane.label}>${lane.label}</span>
          </div>
          <div class="lane-row__stats">
            <span>${per.total} tasks</span>
            <span>· ${active} active</span>
            <span>· ${done} done</span>
            <div class="lane-row__progress">
              <div class="lane-row__progress-fill" style=${`width: ${donePct}%`}></div>
              ${inProg > 0 ? html`<div class="lane-row__progress-warn" style=${`left: ${donePct}%; width: ${inProgPct}%`}></div>` : null}
            </div>
            <span class="lane-row__pct">${per.pct}%</span>
            <div class="lane-row__actions" onClick=${(e) => e.stopPropagation()}>
              <${Bracket}
                label="↑"
                soft
                disabled=${!canMoveUp}
                title=${canMoveUp ? `Move ${lane.label} up` : `${lane.label} is already the top lane`}
                ariaLabel=${`Move lane ${lane.label} up`}
                onClick=${() => onMoveLane && onMoveLane(lane.id, "up")}
              />
              <${Bracket}
                label="↓"
                soft
                disabled=${!canMoveDown}
                title=${canMoveDown ? `Move ${lane.label} down` : `${lane.label} is already the bottom lane`}
                ariaLabel=${`Move lane ${lane.label} down`}
                onClick=${() => onMoveLane && onMoveLane(lane.id, "down")}
              />
            </div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="lane-cell" key=${`lane-${lane.id}`}>
        <div class="lane-cell-head">
          <button
            class="lane-chevron"
            aria-label="Collapse swimlane"
            onClick=${() => onToggleCollapse(lane.id, true)}
            title="Collapse swimlane"
          >${"\u25BC"}</button>
          <div class="lane-label">
            <span class="lane-label-text" title=${lane.label}>${lane.label}</span>
            <${CopyInlineBtn}
              value=${lane.label}
              label="Lane name"
              title=${`Copy lane name: ${lane.label}`}
            />
          </div>
        </div>
        <div class="lane-order-actions">
          <button
            class="icon-btn small"
            disabled=${!canMoveUp}
            aria-label=${`Increase priority of lane ${lane.label}`}
            title=${canMoveUp ? `Move ${lane.label} up` : `${lane.label} is already the top lane`}
            onClick=${() => onMoveLane && onMoveLane(lane.id, "up")}
          >[UP]</button>
          <button
            class="icon-btn small"
            disabled=${!canMoveDown}
            aria-label=${`Decrease priority of lane ${lane.label}`}
            title=${canMoveDown ? `Move ${lane.label} down` : `${lane.label} is already the bottom lane`}
            onClick=${() => onMoveLane && onMoveLane(lane.id, "down")}
          >[DOWN]</button>
        </div>
        ${lane.description ? html`<div class="lane-desc">${lane.description}</div>` : null}
        <div class="lane-stats">
          <span>${per.total} tasks</span>
          <span class="active">· ${active} active</span>
        </div>
        <${SegBar} counts=${per.counts} total=${per.total} thin />
      </div>
      ${priorities.map(
        (p) => html`
          <${Cell}
            key=${`${lane.id}::${p.id}`}
            laneId=${lane.id}
            priorityId=${p.id}
            tasks=${byCell[`${lane.id}::${p.id}`] || []}
            blocked=${blocked}
            filterQuery=${filterQuery}
            statusFilters=${statusFilters}
            blockFilters=${blockFilters}
            fuzzyQuery=${fuzzyQuery}
            fuzzyMatchMap=${fuzzyMatchMap}
            dragState=${dragState}
            setDragState=${setDragState}
            onDrop=${onMove}
            onDeleteTask=${onDeleteTask}
            onSaveComment=${onSaveComment}
            onOpenTask=${onOpenTask}
          />
        `
      )}
    `;
  });

  return html`
    <div class="matrix-wrap">
      <div class="matrix" style=${`--col-count: ${priorities.length}`}>
        ${headerRow}
        ${rows}
      </div>
    </div>
  `;
}

// ─────── Scratchpad row (t26 — collapsed one-liner with expand/edit) ───────
function relativeTime(iso) {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ScratchpadRow({ slug, text, updatedAt, expanded, onToggleExpand, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  const startEdit = (e) => {
    e?.stopPropagation();
    setDraft(text || "");
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
  };
  const commit = async () => {
    if (saving || draft.length > 5000) return;
    setSaving(true);
    const ok = await onSave(slug, draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const stamp = relativeTime(updatedAt);
  const rowClass = [
    "scratchpad-row",
    expanded ? "scratchpad-row--expanded" : "",
    editing ? "scratchpad-row--editing" : "",
  ].filter(Boolean).join(" ");

  return html`
    <div class=${rowClass} onClick=${(e) => e.stopPropagation()} onMouseDown=${(e) => e.stopPropagation()}>
      <span class="scratchpad-row__label">NOTE</span>
      ${editing
        ? html`<textarea
            ref=${textareaRef}
            class="scratchpad-row__textarea"
            maxlength="5000"
            placeholder="plain text — ≤ 5000 chars"
            value=${draft}
            onInput=${(e) => setDraft(e.currentTarget.value)}
            onKeyDown=${(e) => {
              if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
            }}
          />`
        : html`<span class="scratchpad-row__text">${text || html`<em style="color:var(--ink-3);font-style:normal">(empty)</em>`}</span>`
      }
      ${stamp && !editing ? html`<span class="scratchpad-row__stamp">${stamp}</span>` : null}
      <${Bracket}
        label=${editing ? "CANCEL" : expanded ? "COLLAPSE" : "EXPAND"}
        soft
        onClick=${editing ? cancelEdit : () => onToggleExpand(slug)}
        disabled=${saving}
      />
      <${Bracket}
        label=${saving ? "SAVING…" : editing ? "SAVE" : "EDIT"}
        soft
        onClick=${editing ? commit : startEdit}
        disabled=${saving || (editing && draft.length > 5000)}
      />
    </div>
  `;
}

// ─────── Project pane (one per workspace slot) ───────
function ProjectPane({
  project,
  slug,
  isActive,
  solo,
  pinned,
  onFocus,
  onTogglePin,
  filter,
  searchMode,
  fuzzyMatchMap,
  statusFilters,
  blockFilters,
  onMove,
  onToggleCollapse,
  onMoveLane,
  onDeleteTask,
  onSaveComment,
  onOpenTask,
  scratchpadExpanded,
  onToggleScratchpad,
  onSaveScratchpad
}) {
  const data = project?.data;
  const derived = project?.derived;
  const meta = data?.meta;

  return html`
    <section
      class=${`project-pane ${isActive ? "active" : ""} ${solo ? "solo" : ""}`}
      onMouseDown=${() => onFocus && onFocus(slug)}
    >
      <div class="project-pane-header">
        <span class="project-pane-name">${meta?.name || slug}</span>
        <span class="project-pane-slug">${slug}</span>
        ${onTogglePin
          ? html`<button
              class=${`icon-btn small ${pinned ? "active" : ""}`}
              onClick=${(e) => { e.stopPropagation(); onTogglePin(slug); }}
              title=${pinned ? "Unpin this project" : "Pin this project"}
            >${pinned ? "[UNPIN]" : "[PIN]"}</button>`
          : null}
      </div>
      ${data
        ? html`<${ScratchpadRow}
            slug=${slug}
            text=${meta?.scratchpad || ""}
            updatedAt=${meta?.updatedAt || null}
            expanded=${!!scratchpadExpanded}
            onToggleExpand=${onToggleScratchpad}
            onSave=${onSaveScratchpad}
          />`
        : null}
      ${project?.error
        ? html`<div class="error-banner"><b>${project.error.kind} error</b> — last valid state shown; ${project.error.message}</div>`
        : null}
      ${derived
        ? html`<div class="progress-strip">
            <span class="progress-label">project</span>
            <${SegBar} counts=${derived.counts} total=${derived.total} />
            <span class="progress-count">
              ${derived.counts.complete || 0} / ${derived.total}
              <span class="pct">${derived.pct}%</span>
            </span>
          </div>`
        : null}
      ${data
        ? html`<${Matrix}
            project=${project}
            filterQuery=${searchMode === "filter" ? filter : ""}
            statusFilters=${statusFilters}
            blockFilters=${blockFilters}
            fuzzyQuery=${searchMode === "fuzzy" ? filter : ""}
            fuzzyMatchMap=${fuzzyMatchMap}
            onMove=${(args) => onMove(slug, args)}
            onToggleCollapse=${(laneId, collapsed) => onToggleCollapse(slug, laneId, collapsed)}
            onMoveLane=${(laneId, direction) => onMoveLane(slug, laneId, direction)}
            onDeleteTask=${(task) => onDeleteTask(slug, task)}
            onSaveComment=${(taskId, value) => onSaveComment(slug, taskId, value)}
            onOpenTask=${(task, mode) => onOpenTask && onOpenTask(slug, task, mode)}
          />`
        : html`<div class="empty-state"><p>Project file is not yet valid. Fix it and save.</p></div>`}
    </section>
  `;
}

// ─────── Help modal ───────
function HelpModal({ workspace, onClose }) {
  const port = typeof location !== "undefined" ? location.port || "4400" : "4400";
  const readme = workspace?.readme || "~/.llm-tracker/README.md";
  const wsPath = workspace?.workspace || "~/.llm-tracker";

  const promptFile =
    "Read http://localhost:" + port + "/help (or " + readme + " on disk) and register this project as <slug>.\n\n" +
    "WORKSPACE IS AT: " + wsPath + "\n" +
    "Every path you read or write MUST begin with that absolute path. " +
    "Do NOT create a new .llm-tracker/ folder anywhere else. " +
    "Do NOT write README.md, templates/, or settings.json — they already exist at the workspace. " +
    "If you're about to create any of those, STOP: you're in the wrong directory.\n\n" +
    "Registration (ONE time): write the full project to " + wsPath + "/trackers/<slug>.json\n\n" +
    "Updates (constant): use FILE PATCH mode — write each change as a small JSON patch to\n" +
    "  " + wsPath + "/patches/<slug>.<timestamp>.json\n" +
    "containing only the fields you're changing. The hub merges and deletes the patch file.\n\n" +
    "Patch body:\n" +
    '  {"tasks":{"t-001":{"status":"complete","context":{"notes":"..."}}},"meta":{"scratchpad":"..."}}\n\n' +
    "Read the tracker only at decision points (claiming next task, resolving a blocker). Writes are fire-and-forget.";

  const promptHttp =
    "Read http://localhost:" + port + "/help for the live contract, then use HTTP-only (no file paths, no fs writes).\n\n" +
    "IMPORTANT — ALWAYS use --data-binary @file.json, never inline -d '...'.\n" +
    "Inline curl -d strips newlines and corrupts JSON bodies that contain quotes, " +
    "newlines, or special characters. Write the body to a file first, then send it with " +
    "--data-binary. Use --data-raw only for tiny payloads you are certain have no shell-special chars.\n\n" +
    "Register this project as <slug> by PUTting the full tracker JSON:\n" +
    "  1. Write the full project to /tmp/<slug>-init.json\n" +
    "  2. curl -X PUT http://localhost:" + port + "/api/projects/<slug> \\\n" +
    "       -H 'Content-Type: application/json' \\\n" +
    "       --data-binary @/tmp/<slug>-init.json\n\n" +
    "Update with small patches — only include fields you're changing:\n" +
    "  1. Write the patch to /tmp/<slug>-patch.json\n" +
    "  2. curl -X POST http://localhost:" + port + "/api/projects/<slug>/patch \\\n" +
    "       -H 'Content-Type: application/json' \\\n" +
    "       --data-binary @/tmp/<slug>-patch.json\n\n" +
    "Patch body shape: {\"tasks\":{\"<id>\":{\"status\":\"complete\"}},\"meta\":{\"scratchpad\":\"...\"}}\n\n" +
    "Pull changes since a rev (avoid re-reading the whole tracker):\n" +
    "  curl http://localhost:" + port + "/api/projects/<slug>/since/<your-last-rev>\n\n" +
    "If any call fails: rerun with -i to capture headers, and parse the JSON response body " +
    "(the hub always returns JSON errors with {error, type, hint}).\n\n" +
    "One-time: the user may need to pre-approve curl to localhost:" + port + ". After that, HTTP mode " +
    "requires no filesystem access to the tracker workspace.";

  const [mode, setMode] = useState("file");
  const [copied, setCopied] = useState(false);
  const [liveHelp, setLiveHelp] = useState("");
  const [helpError, setHelpError] = useState(null);
  const [helpCopied, setHelpCopied] = useState(false);
  const activePrompt = mode === "file" ? promptFile : promptHttp;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(activePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const copyHelp = async () => {
    if (!liveHelp) return;
    try {
      await navigator.clipboard.writeText(liveHelp);
      setHelpCopied(true);
      setTimeout(() => setHelpCopied(false), 1800);
    } catch {}
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    fetch("/help")
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        return response.text();
      })
      .then((text) => {
        setLiveHelp(text);
        setHelpError(null);
      })
      .catch((error) => setHelpError(error.message));
  }, []);

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal help-modal" role="dialog" aria-modal="true" aria-label="Help" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[HELP] · LLM PROJECT TRACKER</span>
          <button class="icon-btn" aria-label="Close dialog" onClick=${onClose} title="Close (Esc)">×</button>
        </div>

        <div class="modal-body">
          <section>
            <h3>How it works</h3>
            <p>
              Every project is one JSON file in <code>trackers/</code>. The hub is authoritative for structure (task order, which tasks exist, swimlane collapse). The LLM is authoritative for content (status, assignee, context, priorities). The LLM sends tiny patches; the hub merges them under a per-project lock; the UI renders live over WebSocket.
            </p>
          </section>

          <section>
            <h3>Register a project — pick a write mode</h3>
            <div class="mode-tabs">
              <button
                class=${`mode-tab ${mode === "file" ? "active" : ""}`}
                onClick=${() => setMode("file")}
              >[MODE A · FILE PATCHES]</button>
              <button
                class=${`mode-tab ${mode === "http" ? "active" : ""}`}
                onClick=${() => setMode("http")}
              >[MODE B · HTTP PATCHES]</button>
            </div>
            <p class="muted">
              ${mode === "file"
                ? "Bash-less. Works in any CLI with filesystem Write access (Claude Code, Cursor, Aider, …) without approval. The LLM writes small patch files; the hub picks them up and deletes them."
                : "Fastest. Requires a one-time pre-approval of curl-to-localhost in your CLI. After that, every update is a single HTTP POST."}
            </p>
            <div class="copy-block" onClick=${copy}>
              <code class="copy-block-text">${activePrompt}</code>
              <button class="copy-btn">${copied ? "[COPIED]" : "[COPY]"}</button>
            </div>
            <p class="muted">Replace <code>${"<slug>"}</code> with the project ID you want (lowercase, dash-separated).</p>
          </section>

          <section>
            <h3>Live Contract (/help)</h3>
            ${helpError
              ? html`<p class="muted">failed to load /help: ${helpError}</p>`
              : liveHelp
                ? html`
                    <div class="copy-block contract-block" onClick=${copyHelp}>
                      <code class="copy-block-text">${liveHelp}</code>
                      <button class="copy-btn">${helpCopied ? "[COPIED]" : "[COPY]"}</button>
                    </div>
                  `
                : html`<p class="muted">loading /help…</p>`}
          </section>

          <section>
            <h3>What the LLM writes</h3>
            <ul class="rules">
              <li><b>status</b> not_started → in_progress → complete (or deferred when parked)</li>
              <li><b>assignee</b> its model ID when it claims a task</li>
              <li><b>dependencies</b> task IDs this one blocks on</li>
              <li><b>blocker_reason</b> one sentence when stuck</li>
              <li><b>context.*</b> tags, files_touched, notes — free-form diagnostics</li>
              <li><b>placement.priorityId / swimlaneId</b> — yes, it can re-prioritize or re-home tasks</li>
              <li><b>meta.scratchpad</b> a status banner to you (pin, test count, next milestone)</li>
              <li><b>New tasks</b> appended to the end of tasks[] automatically</li>
            </ul>
          </section>

          <section>
            <h3>What the hub enforces (LLM can't break)</h3>
            <ul class="rules">
              <li><b>Task array order</b> — hub preserves it; reorder happens only via your UI drag.</li>
              <li><b>Deletion</b> — LLMs can't remove tasks. They deprecate with status: "deferred". Humans delete via the UI.</li>
              <li><b>meta.swimlanes[i].collapsed</b> — hub always keeps the current value; LLM submissions for this field are dropped.</li>
              <li><b>updatedAt, rev</b> — hub-owned; LLM submissions are ignored.</li>
            </ul>
          </section>

          <section>
            <h3>Status from any shell</h3>
            <p>
              <code>npx llm-tracker status</code> — dashboard of all projects<br/>
              <code>npx llm-tracker status ${"<slug>"}</code> — one project in detail<br/>
              <code>npx llm-tracker status --json</code> — machine-readable for tool chains
            </p>
          </section>

          <section>
            <h3>Workspace</h3>
            <ul class="rules">
              <li><b>README:</b> <code>${readme}</code></li>
              <li><b>Workspace:</b> <code>${wsPath}</code></li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  `;
}

// ─────── Settings modal ───────
function SettingsModal({ onClose, theme, onToggleTheme, drawerPinned, onToggleDrawerPin }) {
  const [hubSettings, setHubSettings] = useState(null);
  const [portDraft, setPortDraft] = useState("");
  const [saveMsg, setSaveMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setHubSettings(data);
        setPortDraft(String(data.saved?.port ?? data.running?.port ?? ""));
      })
      .catch(() => setSaveMsg({ kind: "error", text: "failed to load hub settings" }));
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savePort = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const p = parseInt(portDraft, 10);
      if (isNaN(p) || p < 1 || p > 65535) {
        setSaveMsg({ kind: "error", text: "port must be 1–65535" });
        setSaving(false);
        return;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: p })
      });
      const body = await res.json();
      if (!res.ok) {
        setSaveMsg({ kind: "error", text: body.error || "save failed" });
      } else {
        setHubSettings(body);
        setSaveMsg({
          kind: "ok",
          text: body.restartRequired
            ? `saved — restart hub to run on :${p}`
            : "saved"
        });
      }
    } catch (e) {
      setSaveMsg({ kind: "error", text: String(e) });
    }
    setSaving(false);
  };

  const running = hubSettings?.running?.port;
  const saved = hubSettings?.saved?.port;

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[SETTINGS]</span>
          <button class="icon-btn" aria-label="Close dialog" onClick=${onClose} title="Close (Esc)">×</button>
        </div>

        <div class="modal-body">
          <section>
            <h3>Hub (server-side)</h3>
            <div class="settings-row">
              <label>Port</label>
              <div class="settings-field">
                <input
                  type="number"
                  min="1"
                  max="65535"
                  class="text-input"
                  value=${portDraft}
                  onInput=${(e) => setPortDraft(e.currentTarget.value)}
                  placeholder="4400"
                />
                <button class="icon-btn" disabled=${saving} onClick=${savePort}>
                  ${saving ? "[SAVING…]" : "[SAVE]"}
                </button>
              </div>
              <div class="settings-hint">
                ${running ? `Running: :${running}` : ""}
                ${saved !== undefined && saved !== running ? ` · Saved: :${saved} (restart to apply)` : ""}
              </div>
              ${saveMsg
                ? html`<div class=${`settings-msg ${saveMsg.kind}`}>${saveMsg.text}</div>`
                : null}
            </div>
            <p class="muted">
              Env / flag overrides still win: <code>LLM_TRACKER_PORT=N</code> or <code>--port N</code>.
            </p>
          </section>

          <section>
            <h3>Board (client-side, this browser)</h3>
            <div class="settings-row">
              <label>Theme</label>
              <div class="settings-field">
                <button
                  class=${`icon-btn ${theme === "dark" ? "active" : ""}`}
                  onClick=${() => theme !== "dark" && onToggleTheme()}
                >[DARK]</button>
                <button
                  class=${`icon-btn ${theme === "light" ? "active" : ""}`}
                  onClick=${() => theme !== "light" && onToggleTheme()}
                >[LIGHT]</button>
              </div>
            </div>
            <div class="settings-row">
              <label>Overview drawer</label>
              <div class="settings-field">
                <button
                  class=${`icon-btn ${drawerPinned ? "active" : ""}`}
                  onClick=${onToggleDrawerPin}
                >${drawerPinned ? "[PINNED]" : "[UNPINNED]"}</button>
              </div>
              <div class="settings-hint">When pinned, the drawer persists open across sessions.</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
}

// ─────── Overview drawer ───────
function Drawer({ open, pinned, onTogglePin, onClose, projects, activeSlug, onSelect, onDelete, pinnedSlugs, onTogglePinProject }) {
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
    <aside class=${`drawer ${pinned ? "pinned" : ""}`} onClick=${(e) => e.stopPropagation()}>
        <div class="drawer-header">
          <span class="brand">[OVERVIEW] · ALL PROJECTS</span>
          <div class="drawer-header-actions">
            <button
              class=${`icon-btn ${pinned ? "active" : ""}`}
              onClick=${onTogglePin}
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
function EmptyState({ workspace, onOpenHelp }) {
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

function ConnectionPip({ up }) {
  return html`
    <div class=${`connection-pip ${up ? "" : "down"}`}>
      <span class="dot"></span>
      <span>${up ? "live" : "reconnecting"}</span>
    </div>
  `;
}

// ─────── Top bar (t22) ───────
function useOutsideClose(ref, onClose, enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [enabled]);
}

function Header({
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
  onExpandAll
}) {
  const meta = project?.data?.meta;
  const projectName = meta?.name || activeSlug || "AWAITING PROJECT";
  const rev = project?.rev ?? null;

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

  const hasProject = !!project?.slug;

  return html`
    <div class="app-header">
      <div class="top-bar">

        <div class="top-bar__identity" ref=${projectRef}>
          <div class="top-bar__eyebrow">LLM·TRACKER</div>
          <div class="top-bar__project-row">
            <button
              class="top-bar__project-btn"
              onClick=${() => setProjectOpen((v) => !v)}
              aria-label="Switch project"
              title="Switch project"
            >
              <span class="top-bar__project-name">${projectName}</span>
              <span class="top-bar__caret">▾</span>
            </button>
            ${rev != null ? html`<span class="top-bar__rev">REV ${rev}</span>` : null}
          </div>
          ${projectOpen ? html`
            <div class="top-bar__project-dropdown">
              <ul class="top-bar__dropdown-list" role="listbox"></ul>
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

        <div
          class="top-bar__palette"
          onClick=${() => console.info("⌘K: palette stub — t24 wires the real command palette")}
          title="Search and run commands (coming soon)"
        >
          <span class="top-bar__palette-hint">⌘K</span>
          <span class="top-bar__palette-text">filter · search · run command</span>
        </div>

        <div ref=${overflowRef} style="position:relative;flex-shrink:0;">
          <${Bracket}
            label="⋯"
            onClick=${() => setOverflowOpen((v) => !v)}
            title="More actions"
          />
          ${overflowOpen ? html`
            <ul class="overflow-menu" role="menu">

              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => { onCollapseAll && onCollapseAll(); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">⊟</span>
                <span class="overflow-menu__label">Collapse all lanes</span>
              </li>
              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => { onExpandAll && onExpandAll(); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">⊠</span>
                <span class="overflow-menu__label">Expand all lanes</span>
              </li>

              <li class="overflow-menu__divider" role="separator"></li>

              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => { onOpenHistory(); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">⎌</span>
                <span class="overflow-menu__label">Open history</span>
              </li>
              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => { onOpenDrawer(); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">◧</span>
                <span class="overflow-menu__label">Overview</span>
              </li>

              <li class="overflow-menu__divider" role="separator"></li>

              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => setOverflowOpen(false)}
                title="No pin-overview handler found (t33 stub)"
              >
                <span class="overflow-menu__icon">⚲</span>
                <span class="overflow-menu__label">Pin overview</span>
              </li>
              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => setOverflowOpen(false)}
                title="No comments toggle found (t33 stub)"
              >
                <span class="overflow-menu__icon">✎</span>
                <span class="overflow-menu__label">Toggle comments on cards</span>
              </li>
              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => { onToggleTheme(); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">☼</span>
                <span class="overflow-menu__label">Toggle theme</span>
                <span class="overflow-menu__hint">${theme}</span>
              </li>

              <li class="overflow-menu__divider" role="separator"></li>

              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => { onOpenSettings(); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">⚙</span>
                <span class="overflow-menu__label">Settings</span>
              </li>
              <li class="overflow-menu__item" role="menuitem"
                onClick=${() => { onOpenHelp(); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">?</span>
                <span class="overflow-menu__label">Help</span>
              </li>
              <li class="overflow-menu__item overflow-menu__item--destructive" role="menuitem"
                onClick=${() => { onDeleteProject(project?.slug); setOverflowOpen(false); }}
              >
                <span class="overflow-menu__icon">⌫</span>
                <span class="overflow-menu__label">Delete project</span>
              </li>

            </ul>
          ` : null}
        </div>

      </div>
    </div>
  `;
}

// ─────── Hero strip (t23) ───────
function HeroStrip({ project, slug, onPickTask, onOpenTask }) {
  const [nextData, setNextData] = useState(null);
  const [nextLoading, setNextLoading] = useState(false);
  const [nextError, setNextError] = useState("");

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setNextLoading(true);
    setNextError("");
    fetch(`/api/projects/${slug}/next?limit=1`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(body.error || r.statusText || "request failed");
        }
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setNextData(body);
        setNextLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setNextData(null);
        setNextError(error?.message || "request failed");
        setNextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, project?.rev]);

  if (!project?.data) return null;

  const summary = buildHeroSummary(project, slug);
  const nextTask = nextData?.next?.[0] ?? null;
  const reasonStr = Array.isArray(nextTask?.reason) && nextTask.reason.length > 0
    ? nextTask.reason.join(" · ")
    : buildHeroReason(nextTask);
  const nextTitle = nextLoading
    ? "Loading ranked shortlist"
    : nextError
      ? "Recommendation unavailable"
      : nextTask?.title || "No ready task";
  const nextReason = nextLoading
    ? "Fetching the current top-ranked task from /next."
    : nextError
      ? nextError
      : nextTask
        ? reasonStr
        : "No ready task is available from the current ranking.";
  const nextTaskId = nextTask?.id || "—";

  return html`
    <div class="hero-strip">
      <div class="hero-col hero-col--left">
        <div class="hero-eyebrow">PROJECT</div>
        <div class="hero-title-row">
          <div class="hero-title">${summary.projectName}</div>
          ${summary.trackerPath ? html`<div class="hero-path">${summary.trackerPath}</div>` : null}
        </div>
        <div class="hero-meta">${summary.swimlaneCount} swimlane${summary.swimlaneCount !== 1 ? "s" : ""} · ${summary.total} tasks · updated ${summary.updatedAt}</div>
        <div class="hero-display">
          <span class="hero-display__pct">${summary.pct}<span class="hero-display__unit">%</span></span>
          <span class="hero-display__text">${summary.complete} of ${summary.total} tasks complete</span>
        </div>
        <div class="hero-progress">
          ${summary.completeW > 0 ? html`<span class="hero-progress__segment--complete" style=${`width:${summary.completeW}%`}></span>` : null}
          ${summary.warnW > 0 ? html`<span class="hero-progress__segment--warn" style=${`left:${summary.completeW}%;width:${summary.warnW}%`}></span>` : null}
        </div>
      </div>
      <div class="hero-col hero-col--status">
        <div class="hero-eyebrow">STATUS</div>
        <div class="hero-status__grid">
          ${summary.statusTiles.map((tile) => html`
            <div key=${tile.key} class=${`hero-tile ${tile.strong ? "hero-tile--strong" : ""}`}>
              <span class="hero-tile__dot" style=${`background:${tile.color}`}></span>
              <span class="hero-tile__label">${tile.label}</span>
              <span class="hero-tile__count" style=${tile.count === 0 ? "color:var(--ink-3)" : ""}>${tile.count}</span>
            </div>
          `)}
        </div>
      </div>
      <div class="hero-col hero-col--next">
        <div class="hero-next">
          <div class="hero-next__head">
            <span>★ RECOMMENDED NEXT</span>
            <span>${nextTaskId}</span>
          </div>
          <div class="hero-next__title">${nextTitle}</div>
          <div class="hero-next__reason">${nextReason}</div>
          <div class="hero-next__actions">
            <${Bracket}
              label="PICK"
              active
              tone="ok"
              disabled=${!nextTask}
              title=${nextTask ? "Claim the recommended task" : "No ready task to pick"}
              onClick=${() => nextTask && onPickTask && onPickTask(slug, nextTask.id)}
            />
            <${Bracket}
              label="READ"
              tone="ok"
              disabled=${!nextTask}
              title=${nextTask ? "Open the task brief" : "No ready task to read"}
              onClick=${() => nextTask && onOpenTask && onOpenTask(slug, nextTask.id, "brief")}
            />
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─────── App ───────
function App() {
  const initialSettings = useMemo(() => loadSettings(), []);
  const [workspace, setWorkspace] = useState(null);
  const [projects, setProjects] = useState({});
  const [activeSlug, setActiveSlug] = useState(initialSettings.activeSlug || null);
  const [filter, setFilter] = useState("");
  const [searchMode, setSearchMode] = useState("filter");
  const [fuzzyState, setFuzzyState] = useState({
    slug: null,
    query: "",
    matches: [],
    loading: false,
    error: null
  });
  const [wsUp, setWsUp] = useState(false);
  const [theme, setTheme] = useState(initialSettings.theme || "dark");
  const [headerCollapsed, setHeaderCollapsed] = useState(!!initialSettings.headerCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(!!initialSettings.drawerPinned);
  const [drawerPinned, setDrawerPinned] = useState(!!initialSettings.drawerPinned);
  const [pinnedSlugs, setPinnedSlugs] = useState(() =>
    Array.isArray(initialSettings.pinnedSlugs) ? initialSettings.pinnedSlugs : []
  );
  const [scratchpadExpanded, setScratchpadExpanded] = useState(() =>
    initialSettings.scratchpadExpanded && typeof initialSettings.scratchpadExpanded === "object"
      ? initialSettings.scratchpadExpanded
      : {}
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [projectIntel, setProjectIntel] = useState(null);
  const [taskIntel, setTaskIntel] = useState(null);
  const [statusFilters, setStatusFilters] = useState(() => new Set());
  const [blockFilters, setBlockFilters] = useState(() => new Set());

  const toggleStatus = (s) =>
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const toggleBlock = (b) =>
    setBlockFilters((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });

  // Persist settings
  useEffect(() => {
    saveSettings({ theme, headerCollapsed, drawerPinned, pinnedSlugs, scratchpadExpanded, activeSlug });
  }, [theme, headerCollapsed, drawerPinned, pinnedSlugs, scratchpadExpanded, activeSlug]);

  // Apply theme class on root
  useEffect(() => {
    document.documentElement.classList.toggle("theme-light", theme === "light");
  }, [theme]);

  useEffect(() => {
    fetch("/api/workspace").then((r) => r.json()).then(setWorkspace).catch(() => {});
  }, []);

  useEffect(() => {
    if (searchMode !== "fuzzy" || !activeSlug || !filter.trim()) {
      setFuzzyState((prev) => ({
        ...prev,
        slug: activeSlug,
        query: filter,
        matches: [],
        loading: false,
        error: null
      }));
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setFuzzyState((prev) => ({
        ...prev,
        slug: activeSlug,
        query: filter,
        loading: true,
        error: null
      }));

      fetch(`/api/projects/${activeSlug}/fuzzy-search?q=${encodeURIComponent(filter)}&limit=12`, {
        signal: controller.signal
      })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || response.statusText || "request failed");
          return body;
        })
        .then((payload) => {
          setFuzzyState({
            slug: activeSlug,
            query: filter,
            matches: payload.matches || [],
            model: payload.model || null,
            loading: false,
            error: null
          });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setFuzzyState({
            slug: activeSlug,
            query: filter,
            matches: [],
            model: null,
            loading: false,
            error: error.message
          });
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchMode, activeSlug, filter]);

  useEffect(() => {
    let ws;
    let retryTimer;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setWsUp(true);
      ws.onclose = () => {
        setWsUp(false);
        retryTimer = setTimeout(connect, 1000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "SNAPSHOT") {
          setProjects(msg.projects || {});
          setActiveSlug((prev) => {
            if (prev && msg.projects[prev]) return prev;
            const slugs = Object.keys(msg.projects || {});
            return slugs.length > 0 ? slugs[0] : null;
          });
        } else if (msg.type === "UPDATE" || msg.type === "ERROR") {
          setProjects((prev) => ({ ...prev, [msg.slug]: msg.project }));
          setActiveSlug((prev) => prev || msg.slug);
        } else if (msg.type === "REMOVE") {
          setProjects((prev) => {
            const next = { ...prev };
            delete next[msg.slug];
            return next;
          });
        }
      };
    };
    connect();
    return () => {
      clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
    };
  }, []);

  const onMove = async (slug, { taskId, swimlaneId, priorityId, targetIndex }) => {
    if (!slug) return;
    try {
      await fetch(`/api/projects/${slug}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, swimlaneId, priorityId, targetIndex })
      });
    } catch (e) {
      console.error("move failed", e);
    }
  };

  const onSaveComment = async (slug, taskId, value) => {
    if (!slug || !taskId) return false;
    try {
      const res = await fetch(`/api/projects/${slug}/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: { [taskId]: { comment: value } } })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Save comment failed: ${body.error || res.statusText}`);
        return false;
      }
      return true;
    } catch (e) {
      alert(`Save comment failed: ${e.message}`);
      return false;
    }
  };

  const onToggleCollapse = async (slug, swimlaneId, collapsed) => {
    if (!slug) return;
    try {
      const res = await fetch(`/api/projects/${slug}/swimlane-collapse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swimlaneId, collapsed })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Swimlane update failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Swimlane update failed: ${e.message}`);
    }
  };

  const onMoveLane = async (slug, swimlaneId, direction) => {
    if (!slug || !swimlaneId) return;
    try {
      const res = await fetch(`/api/projects/${slug}/swimlane-move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swimlaneId, direction })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Swimlane move failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Swimlane move failed: ${e.message}`);
    }
  };

  const onCollapseAll = () => {
    const slug = activeSlug;
    const lanes = projects[slug]?.data?.meta?.swimlanes;
    if (!slug || !lanes) return;
    for (const lane of lanes) onToggleCollapse(slug, lane.id, true);
  };

  const onExpandAll = () => {
    const slug = activeSlug;
    const lanes = projects[slug]?.data?.meta?.swimlanes;
    if (!slug || !lanes) return;
    for (const lane of lanes) onToggleCollapse(slug, lane.id, false);
  };

  const onSelectProject = (slug) => {
    setActiveSlug(slug);
    if (!drawerPinned) setDrawerOpen(false);
  };

  const onOpenTaskIntel = (slug, taskOrId, initialMode = "brief") => {
    if (!slug || !taskOrId) return;
    const projectTasks = projects[slug]?.data?.tasks || [];
    const task = typeof taskOrId === "string"
      ? projectTasks.find((item) => item.id === taskOrId) || { id: taskOrId, title: taskOrId }
      : taskOrId;
    if (!task?.id) return;
    setActiveSlug(slug);
    setTaskIntel({ slug, task, initialMode });
  };

  const onOpenProjectIntel = (initialMode = "next") => {
    if (!activeSlug) return;
    setProjectIntel({ slug: activeSlug, initialMode });
  };

  const onPickTask = async (slug, taskId = null) => {
    if (!slug) return;
    try {
      const res = await fetch(`/api/projects/${slug}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskId ? { taskId } : {})
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Pick failed: ${body.error || res.statusText}`);
        return;
      }
      const pickedId = body.task?.id || body.pickedTaskId || taskId;
      if (pickedId) {
        setProjectIntel(null);
        onOpenTaskIntel(slug, pickedId, "execute");
      }
    } catch (e) {
      alert(`Pick failed: ${e.message}`);
    }
  };

  const onToggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const onTogglePin = () => setDrawerPinned((p) => !p);

  const onTogglePinProject = (slug) => {
    setPinnedSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const onToggleScratchpad = (slug) => {
    setScratchpadExpanded((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  const onSaveScratchpad = async (slug, text) => {
    if (!slug) return false;
    try {
      const res = await fetch(`/api/projects/${slug}/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta: { scratchpad: text } })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Save scratchpad failed: ${body.error || res.statusText}`);
        return false;
      }
      return true;
    } catch (e) {
      alert(`Save scratchpad failed: ${e.message}`);
      return false;
    }
  };

  const slugs = Object.keys(projects).sort();
  const active = activeSlug ? projects[activeSlug] : null;
  const fuzzyMatchMap = useMemo(
    () => new Map((fuzzyState.matches || []).map((match) => [match.id, match])),
    [fuzzyState.matches]
  );
  const searchMeta = useMemo(() => {
    if (searchMode !== "fuzzy") return null;
    if (!filter.trim()) {
      return { kind: "muted", text: "FUZZY · deterministic lexical highlight mode keeps the board intact and marks near matches in context." };
    }
    if (fuzzyState.loading) return { kind: "muted", text: `FUZZY · searching "${filter}"…` };
    if (fuzzyState.error) return { kind: "error", text: `FUZZY · ${fuzzyState.error}` };
    return {
      kind: fuzzyState.matches.length > 0 ? "ok" : "muted",
      text: `FUZZY · ${fuzzyState.matches.length} hit${fuzzyState.matches.length === 1 ? "" : "s"} for "${filter}"`
    };
  }, [searchMode, filter, fuzzyState]);

  useEffect(() => {
    if (projectIntel && !projects[projectIntel.slug]) {
      setProjectIntel(null);
    }
  }, [projectIntel, projects]);

  useEffect(() => {
    if (taskIntel && !projects[taskIntel.slug]) {
      setTaskIntel(null);
    }
  }, [taskIntel, projects]);

  const onDeleteTask = async (slug, task) => {
    if (!slug) return;
    const ok = window.confirm(
      `Delete task "${task.title}" (${task.id})?\n\nThis bumps the project rev. Use [UNDO] to revert.`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/projects/${slug}/tasks/${task.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Delete failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const onDeleteProject = async (slug) => {
    if (!slug) return;
    const entry = projects[slug];
    const name = entry?.data?.meta?.name || slug;
    const ok = window.confirm(
      `Delete project "${name}" (${slug})?\n\nThe tracker file will be removed. Snapshots and history are preserved in .snapshots/ and .history/.`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/projects/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Delete failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const onUndo = async () => {
    if (!activeSlug || !active || !active.rev || active.rev < 2) return;
    const ok = window.confirm(
      `Undo the most recent effective change for ${activeSlug}?`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/projects/${activeSlug}/undo`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Undo failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Undo failed: ${e.message}`);
    }
  };

  const onRedo = async () => {
    if (!activeSlug) return;
    try {
      const res = await fetch(`/api/projects/${activeSlug}/redo`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Redo failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Redo failed: ${e.message}`);
    }
  };

  const drawerEl = html`
    <${Drawer}
      open=${drawerOpen}
      pinned=${drawerPinned}
      onTogglePin=${onTogglePin}
      onClose=${() => setDrawerOpen(false)}
      projects=${projects}
      activeSlug=${activeSlug}
      onSelect=${onSelectProject}
      onDelete=${onDeleteProject}
      pinnedSlugs=${pinnedSlugs}
      onTogglePinProject=${onTogglePinProject}
    />
  `;
  const helpEl = helpOpen ? html`<${HelpModal} workspace=${workspace} onClose=${() => setHelpOpen(false)} />` : null;
  const historyEl = historyOpen && activeSlug
    ? html`<${HistoryModal} slug=${activeSlug} onClose=${() => setHistoryOpen(false)} />`
    : null;
  const projectIntelEl = projectIntel
    ? html`<${ProjectIntelligenceModal}
        slug=${projectIntel.slug}
        project=${projects[projectIntel.slug]}
        initialMode=${projectIntel.initialMode}
        onOpenTask=${(taskId, mode) => onOpenTaskIntel(projectIntel.slug, taskId, mode)}
        onPickTask=${(taskId) => onPickTask(projectIntel.slug, taskId)}
        onClose=${() => setProjectIntel(null)}
      />`
    : null;
  const taskIntelEl = taskIntel
    ? html`<${TaskIntelligenceModal}
        slug=${taskIntel.slug}
        task=${taskIntel.task}
        initialMode=${taskIntel.initialMode}
        onOpenTask=${(taskId, mode) => onOpenTaskIntel(taskIntel.slug, taskId, mode)}
        onClose=${() => setTaskIntel(null)}
      />`
    : null;

  const shellPinned = drawerOpen && drawerPinned;
  const shellClass = `app-shell ${shellPinned ? "drawer-pinned" : ""}`;
  const settingsEl = settingsOpen
    ? html`<${SettingsModal}
        onClose=${() => setSettingsOpen(false)}
        theme=${theme}
        onToggleTheme=${onToggleTheme}
        drawerPinned=${drawerPinned}
        onToggleDrawerPin=${onTogglePin}
      />`
    : null;
  const validPinned = pinnedSlugs.filter((s) => projects[s]);
  const paneSlugs = validPinned.length > 0 ? validPinned : [activeSlug];
  const pinnedProjectNames = paneSlugs
    .map((slug) => projects[slug]?.data?.meta?.name || slug)
    .filter(Boolean);

  if (slugs.length === 0) {
    return html`
      <div class=${shellClass}>
        <${Header}
          slugs=${slugs}
          projects=${projects}
          activeSlug=${activeSlug}
          setActive=${setActiveSlug}
          project=${null}
          pinnedProjectNames=${[]}
          workspace=${workspace}
          filter=${filter}
          setFilter=${setFilter}
          searchMode=${searchMode}
          onSearchModeChange=${setSearchMode}
          searchMeta=${null}
          headerCollapsed=${headerCollapsed}
          onToggleHeaderCollapse=${() => setHeaderCollapsed((v) => !v)}
          theme=${theme}
          onToggleTheme=${onToggleTheme}
          onOpenHelp=${() => setHelpOpen(true)}
          onOpenDrawer=${() => setDrawerOpen(true)}
          onOpenSettings=${() => setSettingsOpen(true)}
          onOpenHistory=${() => setHistoryOpen(true)}
          onOpenIntel=${onOpenProjectIntel}
          onUndo=${onUndo}
          onRedo=${onRedo}
          onDeleteProject=${onDeleteProject}
          onCollapseAll=${onCollapseAll}
          onExpandAll=${onExpandAll}
        />
        <${EmptyState} workspace=${workspace} onOpenHelp=${() => setHelpOpen(true)} />
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
      </div>
    `;
  }

  if (!active || !active.data) {
    const err = active?.error;
    return html`
      <div class=${shellClass}>
        <${Header}
          slugs=${slugs}
          projects=${projects}
          activeSlug=${activeSlug}
          setActive=${setActiveSlug}
          project=${active}
          pinnedProjectNames=${pinnedProjectNames}
          workspace=${workspace}
          filter=${filter}
          setFilter=${setFilter}
          searchMode=${searchMode}
          onSearchModeChange=${setSearchMode}
          searchMeta=${searchMeta}
          headerCollapsed=${headerCollapsed}
          onToggleHeaderCollapse=${() => setHeaderCollapsed((v) => !v)}
          theme=${theme}
          onToggleTheme=${onToggleTheme}
          onOpenHelp=${() => setHelpOpen(true)}
          onOpenDrawer=${() => setDrawerOpen(true)}
          onOpenSettings=${() => setSettingsOpen(true)}
          onOpenHistory=${() => setHistoryOpen(true)}
          onOpenIntel=${onOpenProjectIntel}
          onUndo=${onUndo}
          onRedo=${onRedo}
          onDeleteProject=${onDeleteProject}
          onCollapseAll=${onCollapseAll}
          onExpandAll=${onExpandAll}
        />
        ${err ? html`<div class="error-banner"><b>${err.kind} error</b> — ${err.message}</div>` : null}
        <div class="empty-state"><p>Project file is not yet valid. Fix it and save.</p></div>
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
        ${projectIntelEl}
        ${taskIntelEl}
      </div>
    `;
  }

  const derived = active.derived;
  const solo = paneSlugs.length === 1 && validPinned.length === 1;

  return html`
    <div class=${shellClass}>
      <${Header}
        slugs=${slugs}
        projects=${projects}
        activeSlug=${activeSlug}
        setActive=${setActiveSlug}
        project=${active}
        pinnedProjectNames=${pinnedProjectNames}
        workspace=${workspace}
        filter=${filter}
        setFilter=${setFilter}
        searchMode=${searchMode}
        onSearchModeChange=${setSearchMode}
        searchMeta=${searchMeta}
        headerCollapsed=${headerCollapsed}
        onToggleHeaderCollapse=${() => setHeaderCollapsed((v) => !v)}
        theme=${theme}
        onToggleTheme=${onToggleTheme}
        onOpenHelp=${() => setHelpOpen(true)}
        onOpenDrawer=${() => setDrawerOpen(true)}
        onOpenSettings=${() => setSettingsOpen(true)}
        onOpenHistory=${() => setHistoryOpen(true)}
        onOpenIntel=${onOpenProjectIntel}
        onUndo=${onUndo}
        onRedo=${onRedo}
        onDeleteProject=${onDeleteProject}
        onCollapseAll=${onCollapseAll}
        onExpandAll=${onExpandAll}
      />
      <${HeroStrip}
        project=${active}
        slug=${activeSlug}
        onPickTask=${onPickTask}
        onOpenTask=${onOpenTaskIntel}
      />
      <div class="banner-row">
        <div class="banner-spacer"></div>
        <${FilterToggles}
          counts=${derived.counts}
          statusFilters=${statusFilters}
          toggleStatus=${toggleStatus}
          blockedCount=${Object.keys(derived.blocked || {}).length}
          openCount=${derived.total - Object.keys(derived.blocked || {}).length}
          blockFilters=${blockFilters}
          toggleBlock=${toggleBlock}
        />
      </div>
      <div class=${`workspace-split ${solo ? "has-solo" : ""}`}>
        ${paneSlugs.map((s) => html`
          <${ProjectPane}
            key=${s}
            slug=${s}
            project=${projects[s]}
            isActive=${s === activeSlug}
            solo=${solo}
            pinned=${pinnedSlugs.includes(s)}
            onFocus=${setActiveSlug}
            onTogglePin=${onTogglePinProject}
            filter=${filter}
            searchMode=${searchMode}
            fuzzyMatchMap=${fuzzyMatchMap}
            statusFilters=${statusFilters}
            blockFilters=${blockFilters}
            onMove=${onMove}
            onToggleCollapse=${onToggleCollapse}
            onMoveLane=${onMoveLane}
            onDeleteTask=${onDeleteTask}
            onSaveComment=${onSaveComment}
            onOpenTask=${onOpenTaskIntel}
            scratchpadExpanded=${!!scratchpadExpanded[s]}
            onToggleScratchpad=${onToggleScratchpad}
            onSaveScratchpad=${onSaveScratchpad}
          />
        `)}
      </div>
      <${ConnectionPip} up=${wsUp} />
      ${drawerEl}
      ${helpEl}
      ${settingsEl}
      ${historyEl}
      ${projectIntelEl}
      ${taskIntelEl}
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
