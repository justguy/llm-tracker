import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import {
  PROJECT_INTEL_TABS,
  TASK_INTEL_TABS,
  buildTaskFactList,
  defaultChangedFromRev,
  humanizeValue,
  toStringList
} from "../lib/intelligence.js";

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(body.error || response.statusText || "request failed");
  }
  return body;
}

function useEscClose(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

function IntelligenceTabs({ tabs, active, onSelect }) {
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

function IntelligenceFacts({ facts = [] }) {
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

function Section({ title, subtitle, children }) {
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

function BulletList({ items = [], empty = "none", renderItem = null }) {
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

function CodeList({ items = [], empty = "none" }) {
  const clean = items.filter(Boolean);
  if (!clean.length) return html`<p class="muted">${empty}</p>`;
  return html`
    <div class="intel-code-list">
      ${clean.map((item, index) => html`<code key=${`${item}:${index}`}>${item}</code>`)}
    </div>
  `;
}

function ReferenceList({ items = [], empty = "no references" }) {
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

function TaskSummaryList({ items = [], empty = "none", onOpenTask = null }) {
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

function SnippetList({ items = [], empty = "no snippets" }) {
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

function HistoryList({ items = [], empty = "no recent history" }) {
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

function ContractSections({ task = {} }) {
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

function renderTaskMode(mode, payload, onOpenTask) {
  const task = payload?.task || {};
  const goal = task.goal || null;
  const comment = task.comment || null;
  const blockerReason = task.blocker_reason || null;

  return html`
    ${goal ? html`<${Section} title="Goal"><p>${goal}</p></${Section}>` : null}
    ${comment ? html`<${Section} title="Decision Note"><p>${comment}</p></${Section}>` : null}
    ${blockerReason ? html`<${Section} title="Blocker Reason"><p>${blockerReason}</p></${Section}>` : null}
    <${ContractSections} task=${task} />
    ${mode === "brief"
      ? html`
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
          <${Section} title="Readiness">
            <${IntelligenceFacts} facts=${buildTaskFactList({
              ...task,
              ...payload.readiness
            })} />
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

async function loadTaskPayload(slug, taskId, mode) {
  return fetchJson(`/api/projects/${slug}/tasks/${taskId}/${mode}`);
}

async function loadProjectPayload(slug, mode, currentRev) {
  switch (mode) {
    case "next":
      return fetchJson(`/api/projects/${slug}/next?limit=5`);
    case "blockers":
      return fetchJson(`/api/projects/${slug}/blockers`);
    case "changed":
      return fetchJson(`/api/projects/${slug}/changed?fromRev=${defaultChangedFromRev(currentRev)}&limit=20`);
    case "decisions":
      return fetchJson(`/api/projects/${slug}/decisions?limit=20`);
    default:
      throw new Error(`Unknown project intelligence mode: ${mode}`);
  }
}

export function TaskIntelligenceModal({ slug, task, initialMode = "brief", onOpenTask, onClose }) {
  const [mode, setMode] = useState(initialMode);
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEscClose(onClose);

  useEffect(() => {
    setMode(initialMode);
    setCache({});
    setError(null);
  }, [slug, task?.id, initialMode]);

  useEffect(() => {
    let cancelled = false;
    if (!task?.id || cache[mode] || loading) return undefined;

    setLoading(true);
    loadTaskPayload(slug, task.id, mode)
      .then((payload) => {
        if (!cancelled) {
          setCache((prev) => ({ ...prev, [mode]: payload }));
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, task?.id, mode, cache, loading]);

  const payload = cache[mode];
  const summaryTask = payload?.task || task || {};

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal intel-modal" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">${TASK_INTEL_TABS.find((tab) => tab.id === mode)?.label || "[TASK]"} · ${slug}</span>
          <button class="icon-btn" onClick=${onClose} title="Close (Esc)">×</button>
        </div>
        <div class="modal-body">
          <div class="intel-title-block">
            <div class="intel-title-meta">${summaryTask.id || task?.id}</div>
            <h2>${summaryTask.title || task?.title || "Task intelligence"}</h2>
            <${IntelligenceFacts} facts=${buildTaskFactList(summaryTask)} />
          </div>
          <${IntelligenceTabs} tabs=${TASK_INTEL_TABS} active=${mode} onSelect=${setMode} />
          ${error ? html`<div class="settings-msg error">${error}</div>` : null}
          ${loading && !payload ? html`<p class="muted">loading…</p>` : null}
          ${payload ? renderTaskMode(mode, payload, onOpenTask) : null}
        </div>
      </div>
    </div>
  `;
}

function renderProjectMode(mode, payload, onOpenTask, onPickTask) {
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

export function ProjectIntelligenceModal({ slug, project, initialMode = "next", onOpenTask, onPickTask, onClose }) {
  const [mode, setMode] = useState(initialMode);
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEscClose(onClose);

  useEffect(() => {
    setMode(initialMode);
    setCache({});
    setError(null);
  }, [slug, initialMode]);

  useEffect(() => {
    let cancelled = false;
    if (!slug || cache[mode] || loading) return undefined;

    setLoading(true);
    loadProjectPayload(slug, mode, project?.data?.meta?.rev ?? null)
      .then((payload) => {
        if (!cancelled) {
          setCache((prev) => ({ ...prev, [mode]: payload }));
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, mode, cache, loading, project?.data?.meta?.rev]);

  const payload = cache[mode];
  const derived = project?.derived || {};
  const summaryFacts = [
    { label: "rev", value: project?.data?.meta?.rev ?? "-" },
    { label: "pct", value: `${derived.pct ?? 0}%` },
    { label: "tasks", value: derived.total ?? 0 },
    { label: "blocked", value: Object.keys(derived.blocked || {}).length, tone: "warn" }
  ];

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal intel-modal project-intel-modal" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[PROJECT INTEL] · ${slug}</span>
          <button class="icon-btn" onClick=${onClose} title="Close (Esc)">×</button>
        </div>
        <div class="modal-body">
          <div class="intel-title-block">
            <div class="intel-title-meta">${project?.data?.meta?.name || slug}</div>
            <h2>${slug}</h2>
            <${IntelligenceFacts} facts=${summaryFacts} />
          </div>
          <${IntelligenceTabs} tabs=${PROJECT_INTEL_TABS} active=${mode} onSelect=${setMode} />
          ${error ? html`<div class="settings-msg error">${error}</div>` : null}
          ${loading && !payload ? html`<p class="muted">loading…</p>` : null}
          ${renderProjectMode(mode, payload, onOpenTask, onPickTask)}
        </div>
      </div>
    </div>
  `;
}
