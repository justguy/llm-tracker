import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  HistoryList,
  ReferenceList,
  SnippetList,
  TaskSummaryList,
} from "./modals/intelligence-shared.js";

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchBrief(slug, taskId, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(
      `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/brief`,
      { signal: controller.signal }
    );
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }
  clearTimeout(timer);
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(body.error || response.statusText || "request failed");
  }
  return body;
}

const STATUS_PILL_LABEL = {
  complete: "COMPLETE",
  in_progress: "IN PROGRESS",
  not_started: "NOT STARTED",
  deferred: "DEFERRED",
  blocked: "BLOCKED",
};

const PRIORITY_LABEL = {
  p0: "P0",
  p1: "P1",
  p2: "P2",
  p3: "P3",
};

const NONE = html`<span class="card__drawer-placeholder">— none —</span>`;

function BriefContent({ payload, onOpenTask }) {
  if (!payload) return null;
  const task = payload.task || {};
  const goal = task.goal || null;
  const deps = payload.dependencies || [];
  const refs = payload.references || [];
  const snippets = payload.snippets || [];
  const history = payload.recentHistory || [];

  return html`
    <div class="card__drawer-section">
      <div class="card__drawer-label">GOAL</div>
      <div class="card__drawer-body">
        ${goal ? html`<p style="margin:0">${goal}</p>` : NONE}
      </div>
    </div>

    <div class="card__drawer-section">
      <div class="card__drawer-label">DEPENDENCIES</div>
      <div class="card__drawer-body">
        ${deps.length > 0
          ? html`<${TaskSummaryList} items=${deps} empty="none" onOpenTask=${onOpenTask} />`
          : NONE}
      </div>
    </div>

    <div class="card__drawer-section">
      <div class="card__drawer-label">REFERENCES</div>
      <div class="card__drawer-body">
        ${refs.length > 0
          ? html`<${ReferenceList} items=${refs} />`
          : NONE}
      </div>
    </div>

    <div class="card__drawer-section">
      <div class="card__drawer-label">SNIPPETS</div>
      <div class="card__drawer-body">
        ${snippets.length > 0
          ? html`<${SnippetList} items=${snippets} />`
          : NONE}
      </div>
    </div>

    <div class="card__drawer-section">
      <div class="card__drawer-label">RECENT HISTORY</div>
      <div class="card__drawer-body">
        ${history.length > 0
          ? html`<${HistoryList} items=${history} />`
          : NONE}
      </div>
    </div>
  `;
}

export function TaskInlineDrawer({ slug, task, onOpenTask, onOpenTaskModal, onClose }) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const drawerRef = useRef(null);

  useEffect(() => {
    setPayload(null);
    setError(null);
  }, [slug, task?.id]);

  useEffect(() => {
    if (!slug || !task?.id) return undefined;
    let cancelled = false;
    fetchBrief(slug, task.id)
      .then((body) => {
        if (!cancelled) {
          setPayload(body);
          setError(null);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setPayload(null);
          setError(loadError.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, task?.id, refreshKey]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    drawerRef.current?.focus();
  }, [task?.id]);

  const status = task?.status || "not_started";
  const priority = task?.placement?.priorityId || null;

  return html`
    <div
      ref=${drawerRef}
      class="card__drawer"
      role="region"
      tabIndex="-1"
      aria-label=${`Brief for ${task?.id || "task"}`}
      onClick=${(e) => e.stopPropagation()}
      onMouseDown=${(e) => e.stopPropagation()}
      onWheel=${(e) => e.stopPropagation()}
      onKeyDown=${(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") e.stopPropagation();
      }}
    >
      <div class="card__drawer-header">
        <div class="card__drawer-id">
          <span class="card__drawer-task-id">${task?.id}</span>
          <span class=${`card__drawer-status status-${status}`}>
            ${STATUS_PILL_LABEL[status] || status.toUpperCase()}
          </span>
          ${priority
            ? html`<span class="card__drawer-priority">${PRIORITY_LABEL[priority] || priority.toUpperCase()}</span>`
            : null}
        </div>
        <button
          class="card__drawer-close bracket"
          onClick=${onClose}
          title="Close drawer (Esc)"
          aria-label="Close task drawer"
        >[CLOSE]</button>
      </div>

      ${error
        ? html`
            <div class="card__drawer-section">
              <div class="card__drawer-body" style="color:var(--block)">
                ${error}
                <button
                  class="bracket"
                  style="margin-left:8px"
                  onClick=${() => {
                    setPayload(null);
                    setError(null);
                    setRefreshKey((v) => v + 1);
                  }}
                >[RETRY]</button>
              </div>
            </div>
          `
        : !payload
          ? html`<div class="card__drawer-section"><div class="card__drawer-body" style="color:var(--ink-3)">loading…</div></div>`
          : html`<${BriefContent} payload=${payload} onOpenTask=${onOpenTask} />`}

      <div class="card__drawer-tabs">
        <button
          class="bracket bracket--active"
          title="Brief pack (current view)"
          aria-label="Brief — currently shown"
          onClick=${onClose}
        >[READ]</button>
        <button
          class="bracket"
          title="Why this task? Context and rationale"
          onClick=${() => {
            // TODO(t35): inline WHY/EXEC/VERIFY content
            onOpenTaskModal && onOpenTaskModal(task, "why");
          }}
        >[WHY]</button>
        <button
          class="bracket"
          title="Execution plan and readiness"
          onClick=${() => {
            // TODO(t35): inline WHY/EXEC/VERIFY content
            onOpenTaskModal && onOpenTaskModal(task, "execute");
          }}
        >[EXEC]</button>
        <button
          class="bracket"
          title="Verification checks"
          onClick=${() => {
            // TODO(t35): inline WHY/EXEC/VERIFY content
            onOpenTaskModal && onOpenTaskModal(task, "verify");
          }}
        >[VERIFY]</button>
      </div>
    </div>
  `;
}
