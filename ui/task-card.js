import { html } from "htm/preact";
import { buildCardMetaFacts } from "./lib/intelligence.js";
import { Bracket, CommentBadge, CopyInlineBtn, copyText } from "./primitives.js";
import { humanizeTaskOutcome } from "./task-outcomes.js";
import { STATUS_PILL_LABEL } from "./board-models.js";

export function eventComesFromNestedControl(event) {
  const currentTarget = event?.currentTarget;
  const target = event?.target;
  if (!currentTarget || !target || target === currentTarget) return false;
  if (typeof target.closest !== "function") return false;
  const control = target.closest(
    "button,a,input,select,textarea,summary,[role='button'],[role='link'],[contenteditable='true']"
  );
  if (!control || control === currentTarget) return false;
  return typeof currentTarget.contains === "function" ? currentTarget.contains(control) : true;
}

export function Card({
  task,
  blockedBy,
  dragging,
  searchMatch,
  fuzzyActive,
  activeMode,
  expanded,
  onDragStart,
  onDragEnd,
  onDelete,
  onSaveComment,
  onToggleExpand,
  onOpenTaskModal,
}) {
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
  const canDrag = typeof onDragStart === "function";
  const classes = [
    "card",
    `status-${task.status}`,
    activeMode ? `card--mode-${activeMode}` : "",
    expanded ? "card--expanded" : "",
    dragging ? "dragging" : "",
    searchMatch ? "fuzzy-hit" : "",
    fuzzyActive && !searchMatch ? "fuzzy-dim" : "",
  ].join(" ");

  return html`
    <div
      class=${classes}
      draggable=${canDrag}
      data-task-id=${task.id}
      role="button"
      tabIndex="0"
      aria-label=${`Task ${task.id}: ${task.title}`}
      onDragStart=${(e) => {
        if (!canDrag) {
          e.preventDefault();
          return;
        }
        onDragStart(e, task);
      }}
      onDragEnd=${(e) => onDragEnd && onDragEnd(e)}
      onClick=${() => onToggleExpand && onToggleExpand(task)}
      onKeyDown=${(e) => {
        if (eventComesFromNestedControl(e)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleExpand && onToggleExpand(task);
        }
      }}
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
      >x</button>

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
          * ${STATUS_PILL_LABEL[task.status] || task.status.toUpperCase()}
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
          ? html`<span class="card__meta-chip" title=${`Outcome: ${outcome}`}>outcome:${outcome}</span>`
          : null}
        ${task.effort
          ? html`<span class="card__meta-chip" title=${`Effort: ${task.effort}`}>effort:${task.effort}</span>`
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
          ? html`<span class="card__meta-chip" title=${references.join("\n")}>refs:${references.length}</span>`
          : null}
        ${searchMatch && Number.isFinite(searchMatch.score)
          ? html`<span class="card__meta-chip" title=${`Fuzzy match ${searchMatch.score.toFixed(3)}`}>match:${searchMatch.score.toFixed(2)}</span>`
          : null}
        ${tags.map((tag) => html`<span key=${tag} class="card__tag-chip">#${tag}</span>`)}
      </div>

      <div class="card__action-row" onMouseDown=${(e) => e.stopPropagation()}>
        <${Bracket}
          label="READ"
          title=${`Brief for ${task.id}`}
          onClick=${(e) => {
            e.stopPropagation();
            e.preventDefault();
            onOpenTaskModal && onOpenTaskModal(task, "brief");
          }}
        />
        ${[
          ["why", "WHY"],
          ["execute", "EXEC"],
          ["verify", "VERIFY"],
        ].map(([mode, label]) => html`
          <${Bracket}
            key=${mode}
            label=${label}
            title=${`${label} - ${task.id}`}
            onClick=${(e) => {
              e.stopPropagation();
              e.preventDefault();
              onOpenTaskModal && onOpenTaskModal(task, mode);
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
