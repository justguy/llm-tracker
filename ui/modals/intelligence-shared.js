import { html } from "htm/preact";
import { buildTaskFactList, humanizeValue, toStringList } from "../lib/intelligence.js";

export function IntelligenceTabs({ tabs, active, onSelect }) {
  return html`
    <div class="intel-tabs">
      ${tabs.map((tab) => html`
        <button
          key=${tab.id}
          class=${`intel-tab ${active === tab.id ? "active" : ""}`}
          onClick=${() => onSelect(tab.id)}
        >${tab.label}</button>
      `)}
    </div>
  `;
}

export function IntelligenceFacts({ facts = [] }) {
  if (!facts.length) return null;
  return html`
    <div class="intel-facts">
      ${facts.map((fact) => html`
        <span
          key=${`${fact.label}:${fact.value}`}
          class=${`intel-fact ${fact.tone || ""}`}
          title=${fact.label}
        >
          <b>${fact.label}</b>
          <span>${fact.value}</span>
        </span>
      `)}
    </div>
  `;
}

export function Section({ title, subtitle, children }) {
  return html`
    <section class="intel-section">
      <div class="intel-section-header">
        <h3>${title}</h3>
        ${subtitle ? html`<span class="intel-section-subtitle">${subtitle}</span>` : null}
      </div>
      ${children}
    </section>
  `;
}

export function BulletList({ items = [], empty = "none", renderItem = null }) {
  if (!items.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <ul class="intel-list">
      ${items.map((item, index) => html`
        <li key=${item?.id || item?.value || item?.text || index}>
          ${renderItem ? renderItem(item) : item}
        </li>
      `)}
    </ul>
  `;
}

export function CodeList({ items = [], empty = "none" }) {
  const clean = items.filter(Boolean);
  if (!clean.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <div class="intel-code-list">
      ${clean.map((item, index) => html`<code key=${`${item}:${index}`}>${item}</code>`)}
    </div>
  `;
}

export function ReferenceList({ items = [], empty = "no references" }) {
  if (!items.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <ul class="intel-reference-list">
      ${items.map((item, index) => {
        const value = item?.value || item;
        const because = item?.selectedBecause || null;
        return html`
          <li key=${`${value}:${index}`}>
            <code>${value}</code>
            ${because ? html`<span class="muted"> ${because}</span>` : null}
          </li>
        `;
      })}
    </ul>
  `;
}

export function TaskSummaryList({ items = [], empty = "none", onOpenTask = null }) {
  if (!items.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <ul class="intel-task-list">
      ${items.map((item) => html`
        <li key=${item.id} class="intel-task-list-item">
          <div class="intel-task-list-head">
            <button
              class="intel-task-link"
              onClick=${() => onOpenTask && onOpenTask(item.id, "brief")}
              disabled=${!onOpenTask}
              title=${`Open ${item.id}`}
            >${item.id}</button>
            <span class="intel-task-title">${item.title || item.id}</span>
            ${item.status
              ? html`<span class=${`badge status-${item.status}`}>${humanizeValue(item.status)}</span>`
              : null}
          </div>
          <${IntelligenceFacts} facts=${buildTaskFactList(item)} />
        </li>
      `)}
    </ul>
  `;
}

export function ExternalDependencyList({ items = [], empty = "no external dependencies" }) {
  if (!items.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <ul class="intel-task-list">
      ${items.map((item) => html`
        <li key=${item.raw} class="intel-task-list-item">
          <div class="intel-task-list-head">
            <span class="badge slug-badge" title=${`External project: ${item.slug}`}>${item.slug}</span>
            <span class="intel-task-link" title=${`External task ${item.slug}:${item.taskId}`}>${item.taskId}</span>
            <span class="intel-task-title">${item.title || (item.exists ? "" : "(missing)")}</span>
            ${item.status
              ? html`<span class=${`badge status-${item.status}`}>${humanizeValue(item.status)}</span>`
              : html`<span class="badge status-blocked">EXTERNAL</span>`}
            ${item.blocking
              ? html`<span class="badge status-blocked" title="Blocking this task">BLOCKING</span>`
              : null}
          </div>
        </li>
      `)}
    </ul>
  `;
}

export function SnippetList({ items = [], empty = "no snippets" }) {
  if (!items.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <div class="intel-snippets">
      ${items.map((snippet, index) => html`
        <article key=${`${snippet.reference || index}:${index}`} class="intel-snippet">
          <div class="intel-snippet-meta">
            <code>${snippet.reference}</code>
            ${snippet.selectedBecause ? html`<span class="muted">${snippet.selectedBecause}</span>` : null}
          </div>
          <pre>${snippet.text || ""}</pre>
        </article>
      `)}
    </div>
  `;
}

export function HistoryList({ items = [], empty = "no recent history" }) {
  if (!items.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <ul class="intel-history-list">
      ${items.map((entry) => html`
        <li key=${entry.rev}>
          <div class="intel-history-head">
            <span class="badge">rev ${entry.rev}</span>
            <span class="muted">${new Date(entry.ts).toLocaleString()}</span>
          </div>
          <div class="intel-history-summary">
            ${(entry.summary || []).length
              ? (entry.summary || []).slice(0, 3).map((item, index) => html`<div key=${index}>${JSON.stringify(item)}</div>`)
              : html`<span class="muted">no structured summary</span>`}
          </div>
        </li>
      `)}
    </ul>
  `;
}

export function ContractSections({ task = {} }) {
  const definitionOfDone = toStringList(task.definition_of_done);
  const constraints = toStringList(task.constraints);
  const expectedChanges = toStringList(task.expected_changes);
  const allowedPaths = toStringList(task.allowed_paths);
  const approvals = toStringList(task.approval_required_for || task.requires_approval);

  return html`
    <div class="intel-grid">
      <${Section} title="Definition Of Done">
        <${BulletList} items=${definitionOfDone} empty="none" />
      </${Section}>
      <${Section} title="Constraints">
        <${BulletList} items=${constraints} empty="none" />
      </${Section}>
      <${Section} title="Expected Changes">
        <${CodeList} items=${expectedChanges} empty="none" />
      </${Section}>
      <${Section} title="Allowed Paths">
        <${CodeList} items=${allowedPaths} empty="none" />
      </${Section}>
      <${Section} title="Approvals">
        <${BulletList} items=${approvals} empty="none" />
      </${Section}>
    </div>
  `;
}
