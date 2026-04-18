import { html } from "htm/preact";
import { PROJECT_INTEL_TABS, buildTaskFactList, humanizeValue } from "../lib/intelligence.js";
import {
  BulletList,
  IntelligenceFacts,
  IntelligenceTabs,
  ReferenceList,
  Section,
  TaskSummaryList
} from "./intelligence-shared.js";

export function renderProjectMode(mode, payload, onOpenTask, onPickTask) {
  if (!payload) return null;

  if (mode === "next") {
    return html`
      <${Section} title="Ranked Shortlist" subtitle=${payload.recommendedTaskId ? `recommended ${payload.recommendedTaskId}` : null}>
        <ul class="intel-task-list">
          ${(payload.next || []).map((item) => html`
            <li key=${item.id} class="intel-task-list-item">
              <div class="intel-task-list-head">
                <button class="intel-task-link" onClick=${() => onOpenTask && onOpenTask(item.id, "brief")}>${item.id}</button>
                <span class="intel-task-title">${item.title || item.id}</span>
                <span class=${`badge status-${item.status}`}>${humanizeValue(item.status)}</span>
              </div>
              <${IntelligenceFacts} facts=${buildTaskFactList(item)} />
              <div class="intel-inline-actions">
                <button class="intel-action-btn" onClick=${() => onOpenTask && onOpenTask(item.id, "brief")}>[READ]</button>
                <button
                  class="intel-action-btn warn"
                  onClick=${() => onPickTask && onPickTask(item.id)}
                  disabled=${!onPickTask}
                >[PICK]</button>
              </div>
              <${BulletList} items=${item.reason || []} empty="no ranking notes" />
            </li>
          `)}
        </ul>
      </${Section}>
    `;
  }

  if (mode === "blockers") {
    return html`
      <div class="intel-grid">
        <${Section} title="Blocked Tasks">
          <${TaskSummaryList} items=${payload.blocked || []} empty="no blocked tasks" onOpenTask=${onOpenTask} />
        </${Section}>
        <${Section} title="Tasks Blocking Others">
          <${TaskSummaryList} items=${payload.blocking || []} empty="no active blockers" onOpenTask=${onOpenTask} />
        </${Section}>
      </div>
    `;
  }

  if (mode === "changed") {
    return html`
      <${Section} title="Changed Tasks" subtitle=${`since rev ${payload.fromRev}`}>
        <ul class="intel-task-list">
          ${(payload.changed || []).map((item) => html`
            <li key=${item.id} class="intel-task-list-item">
              <div class="intel-task-list-head">
                ${item.removed
                  ? html`<span class="intel-task-link disabled">${item.id}</span>`
                  : html`<button class="intel-task-link" onClick=${() => onOpenTask && onOpenTask(item.id, "brief")}>${item.id}</button>`}
                <span class="intel-task-title">${item.title || item.id}</span>
                <span class="badge">${item.lastChangedRev ? `rev ${item.lastChangedRev}` : "changed"}</span>
              </div>
              <${IntelligenceFacts} facts=${buildTaskFactList(item)} />
              <div class="intel-code-list">
                ${(item.changeKinds || []).map((kind) => html`<code key=${kind}>${kind}</code>`)}
                ${(item.changedKeys || []).map((key) => html`<code key=${key}>${key}</code>`)}
              </div>
            </li>
          `)}
        </ul>
      </${Section}>
    `;
  }

  return html`
    <${Section}
      title="Decision Memory"
      subtitle=${payload.truncation?.decisions ? `${payload.truncation.decisions.returned} shown` : null}
    >
      <ul class="intel-task-list">
        ${(payload.decisions || []).map((item) => html`
          <li key=${item.id} class="intel-task-list-item">
            <div class="intel-task-list-head">
              <button class="intel-task-link" onClick=${() => onOpenTask && onOpenTask(item.id, "why")}>${item.id}</button>
              <span class="intel-task-title">${item.title || item.id}</span>
              <span class=${`badge status-${item.status}`}>${humanizeValue(item.status)}</span>
            </div>
            <${IntelligenceFacts} facts=${buildTaskFactList(item)} />
            <p>${item.comment}</p>
            <${ReferenceList} items=${item.references || []} empty="no references" />
          </li>
        `)}
      </ul>
    </${Section}>
  `;
}

export function ProjectIntelligenceView({
  slug,
  project,
  mode,
  payload,
  error,
  loading,
  onRetry,
  onSelectMode,
  onOpenTask,
  onPickTask
}) {
  const derived = project?.derived || {};
  const summaryFacts = [
    { label: "rev", value: project?.data?.meta?.rev ?? "-" },
    { label: "pct", value: `${derived.pct ?? 0}%` },
    { label: "tasks", value: derived.total ?? 0 },
    { label: "blocked", value: Object.keys(derived.blocked || {}).length, tone: "warn" }
  ];

  return html`
    <div class="intel-title-block">
      <div class="intel-title-meta">${project?.data?.meta?.name || slug}</div>
      <h2>${slug}</h2>
      <${IntelligenceFacts} facts=${summaryFacts} />
    </div>
    <${IntelligenceTabs} tabs=${PROJECT_INTEL_TABS} active=${mode} onSelect=${onSelectMode} />
    ${error
      ? html`
          <div class="settings-msg error">
            <span>${error}</span>
            <button class="intel-inline-retry" onClick=${onRetry}>[RETRY]</button>
          </div>
        `
      : null}
    ${loading && !payload ? html`<p class="muted">loading…</p>` : null}
    ${renderProjectMode(mode, payload, onOpenTask, onPickTask)}
  `;
}
