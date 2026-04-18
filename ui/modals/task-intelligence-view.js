import { html } from "htm/preact";
import { TASK_INTEL_TABS, buildTaskFactList, humanizeValue } from "../lib/intelligence.js";
import {
  BulletList,
  CodeList,
  ContractSections,
  HistoryList,
  IntelligenceFacts,
  IntelligenceTabs,
  ReferenceList,
  Section,
  SnippetList,
  TaskSummaryList
} from "./intelligence-shared.js";

export function renderTaskMode(mode, payload, onOpenTask) {
  const task = payload?.task || {};
  const goal = task.goal || null;
  const comment = task.comment || null;
  const blockerReason = task.blocker_reason || null;

  return html`
    ${mode === "brief"
      ? html`
          ${goal ? html`<${Section} title="Goal"><p>${goal}</p></${Section}>` : null}
          ${comment ? html`<${Section} title="Decision Note"><p>${comment}</p></${Section}>` : null}
          ${blockerReason ? html`<${Section} title="Blocker Reason"><p>${blockerReason}</p></${Section}>` : null}
          <div class="intel-grid">
            <${Section} title="Dependencies">
              <${TaskSummaryList} items=${payload.dependencies || []} empty="none" onOpenTask=${onOpenTask} />
            </${Section}>
            <${Section} title="Related Tasks">
              <${TaskSummaryList} items=${payload.relatedTasks || []} empty="none" onOpenTask=${onOpenTask} />
            </${Section}>
          </div>
          <${Section} title="References">
            <${ReferenceList} items=${payload.references || []} />
          </${Section}>
          <${Section} title="Snippets" subtitle=${payload.truncation?.snippets ? `${payload.truncation.snippets.returned} shown` : null}>
            <${SnippetList} items=${payload.snippets || []} />
          </${Section}>
          <${Section} title="Recent History">
            <${HistoryList} items=${payload.recentHistory || []} />
          </${Section}>
        `
      : null}
    ${mode === "why"
      ? html`
          ${goal ? html`<${Section} title="Goal"><p>${goal}</p></${Section}>` : null}
          ${comment ? html`<${Section} title="Decision Note"><p>${comment}</p></${Section}>` : null}
          ${blockerReason ? html`<${Section} title="Blocker Reason"><p>${blockerReason}</p></${Section}>` : null}
          <${Section} title="Why Now">
            <${BulletList}
              items=${payload.why || []}
              empty="no reasons"
              renderItem=${(item) => html`<span><b>${humanizeValue(item.kind)}</b> — ${item.text}</span>`}
            />
          </${Section}>
          <div class="intel-grid">
            <${Section} title="Blocked By">
              <${TaskSummaryList} items=${payload.blockedBy || []} empty="none" onOpenTask=${onOpenTask} />
            </${Section}>
            <${Section} title="Unblocks">
              <${TaskSummaryList} items=${payload.unblocks || []} empty="none" onOpenTask=${onOpenTask} />
            </${Section}>
          </div>
          <${Section} title="References">
            <${ReferenceList} items=${payload.references || []} />
          </${Section}>
          <${Section}
            title="Recent History"
            subtitle=${payload.truncation?.history ? `${payload.truncation.history.returned} shown` : null}
          >
            <${HistoryList} items=${payload.recentHistory || []} />
          </${Section}>
        `
      : null}
    ${mode === "execute"
      ? html`
          <${ContractSections} task=${task} />
          <${Section} title="Readiness">
            <${IntelligenceFacts} facts=${buildTaskFactList({ ...task, ...payload.readiness })} />
          </${Section}>
          <${Section} title="Execution Plan">
            <${BulletList}
              items=${payload.executionPlan || []}
              empty="no explicit plan"
              renderItem=${(item) => html`<span><b>${humanizeValue(item.kind)}</b> — ${item.text}</span>`}
            />
          </${Section}>
          <${Section} title="References">
            <${ReferenceList} items=${payload.references || []} />
          </${Section}>
          <${Section} title="Snippets">
            <${SnippetList} items=${payload.snippets || []} />
          </${Section}>
        `
      : null}
    ${mode === "verify"
      ? html`
          <${Section} title="Current Task State">
            <${IntelligenceFacts} facts=${buildTaskFactList(task)} />
          </${Section}>
          <${Section} title="Checks">
            <${BulletList}
              items=${payload.checks || []}
              empty="no checks"
              renderItem=${(item) => html`
                <span>
                  <b>${humanizeValue(item.kind)}</b>
                  <span class="muted"> [${humanizeValue(item.status)}]</span>
                  <span> — ${item.text}</span>
                </span>
              `}
            />
          </${Section}>
          <div class="intel-grid">
            <${Section} title="Dependency Evidence">
              <${TaskSummaryList} items=${payload.evidenceSources?.dependencyState || []} empty="none" onOpenTask=${onOpenTask} />
            </${Section}>
            <${Section} title="Recent History">
              <${HistoryList} items=${payload.evidenceSources?.recentHistory || []} />
            </${Section}>
          </div>
          <${Section} title="References">
            <${ReferenceList} items=${payload.evidenceSources?.references || []} />
          </${Section}>
          <${Section} title="Snippets">
            <${SnippetList} items=${payload.evidenceSources?.snippets || []} />
          </${Section}>
        `
      : null}
  `;
}

export function TaskIntelligenceView({
  slug,
  task,
  mode,
  contentMode = mode,
  payload,
  error,
  loading,
  notice = null,
  onRetry,
  onSelectMode,
  onOpenTask
}) {
  const summaryTask = payload?.task || task || {};

  return html`
    <div class="intel-title-block">
      <div class="intel-title-meta">${summaryTask.id || task?.id}</div>
      <h2>${summaryTask.title || task?.title || "Task intelligence"}</h2>
      <${IntelligenceFacts} facts=${buildTaskFactList(summaryTask)} />
    </div>
    <${IntelligenceTabs} tabs=${TASK_INTEL_TABS} active=${mode} onSelect=${onSelectMode} />
    ${notice ? html`<div class="intel-notice">${notice}</div>` : null}
    ${error
      ? html`
          <div class="settings-msg error">
            <span>${error}</span>
            <button class="intel-inline-retry" onClick=${onRetry}>[RETRY]</button>
          </div>
        `
      : null}
    ${loading && !payload ? html`<p class="muted">loading…</p>` : null}
    ${payload ? renderTaskMode(contentMode, payload, onOpenTask) : null}
  `;
}
