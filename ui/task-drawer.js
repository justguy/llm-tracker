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

async function fetchPack(slug, taskId, mode, signal) {
  const endpoint = mode === "brief" ? "brief"
    : mode === "why" ? "why"
    : mode === "execute" ? "execute"
    : "verify";
  const response = await fetch(
    `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/${endpoint}`,
    { signal }
  );
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

function DrawerSection({ label, children }) {
  return html`
    <div class="card__drawer-section">
      <div class="card__drawer-label">${label}</div>
      <div class="card__drawer-body">${children}</div>
    </div>
  `;
}

function BriefContent({ payload, onOpenTask }) {
  if (!payload) return null;
  const task = payload.task || {};
  const goal = task.goal || null;
  const deps = payload.dependencies || [];
  const refs = payload.references || [];
  const snippets = payload.snippets || [];
  const history = payload.recentHistory || [];

  return html`
    <${DrawerSection} label="GOAL">
      ${goal ? html`<p style="margin:0">${goal}</p>` : NONE}
    </${DrawerSection}>

    <${DrawerSection} label="DEPENDENCIES">
      ${deps.length > 0
        ? html`<${TaskSummaryList} items=${deps} empty="none" onOpenTask=${onOpenTask} />`
        : NONE}
    </${DrawerSection}>

    <${DrawerSection} label="REFERENCES">
      ${refs.length > 0
        ? html`<${ReferenceList} items=${refs} />`
        : NONE}
    </${DrawerSection}>

    <${DrawerSection} label="SNIPPETS">
      ${snippets.length > 0
        ? html`<${SnippetList} items=${snippets} />`
        : NONE}
    </${DrawerSection}>

    <${DrawerSection} label="RECENT HISTORY">
      ${history.length > 0
        ? html`<${HistoryList} items=${history} />`
        : NONE}
    </${DrawerSection}>
  `;
}

function WhyContent({ payload, onOpenTask }) {
  if (!payload) return null;
  const task = payload.task || {};
  const why = payload.why || [];
  const blockedBy = payload.blockedBy || [];
  const unblocks = payload.unblocks || [];
  const refs = payload.references || [];
  const history = payload.recentHistory || [];

  return html`
    ${task.goal
      ? html`<${DrawerSection} label="INTENT">
          <p style="margin:0">${task.goal}</p>
        </${DrawerSection}>`
      : null}

    <${DrawerSection} label="WHY">
      ${why.length > 0
        ? html`<ul class="drawer-why-list">
            ${why.map((r, i) => html`
              <li key=${i} class="drawer-why-item">
                <span class="drawer-why-kind">${r.kind}</span>
                <span>${r.text}</span>
              </li>
            `)}
          </ul>`
        : NONE}
    </${DrawerSection}>

    ${blockedBy.length > 0
      ? html`<${DrawerSection} label="BLOCKED BY">
          <${TaskSummaryList} items=${blockedBy} empty="none" onOpenTask=${onOpenTask} />
        </${DrawerSection}>`
      : null}

    ${unblocks.length > 0
      ? html`<${DrawerSection} label="UNBLOCKS">
          <${TaskSummaryList} items=${unblocks} empty="none" onOpenTask=${onOpenTask} />
        </${DrawerSection}>`
      : null}

    ${refs.length > 0
      ? html`<${DrawerSection} label="REFERENCES">
          <${ReferenceList} items=${refs} />
        </${DrawerSection}>`
      : null}

    ${history.length > 0
      ? html`<${DrawerSection} label="RECENT HISTORY">
          <${HistoryList} items=${history} />
        </${DrawerSection}>`
      : null}
  `;
}

function ExecContent({ payload }) {
  if (!payload) return null;
  const plan = payload.executionPlan || [];
  const contract = payload.executionContract || {};
  const readiness = payload.readiness || {};
  const dod = contract.definition_of_done || [];
  const constraints = contract.constraints || [];
  const refs = payload.references || [];
  const snippets = payload.snippets || [];

  return html`
    <${DrawerSection} label="EXEC PLAN">
      ${plan.length > 0
        ? html`<ol class="drawer-plan-list">
            ${plan.map((step, i) => html`
              <li key=${i} class="drawer-plan-step">
                <span class="drawer-plan-kind">${step.kind}</span>
                <span>${step.text}</span>
              </li>
            `)}
          </ol>`
        : NONE}
    </${DrawerSection}>

    ${dod.length > 0
      ? html`<${DrawerSection} label="ACCEPTANCE">
          <ul class="drawer-acceptance-list">
            ${dod.map((item, i) => html`
              <li key=${i} class="drawer-acceptance-row">
                <span class="drawer-check-glyph">☐</span>
                <span>${item}</span>
              </li>
            `)}
          </ul>
        </${DrawerSection}>`
      : null}

    ${constraints.length > 0
      ? html`<${DrawerSection} label="CONSTRAINTS">
          <ul class="drawer-acceptance-list">
            ${constraints.map((c, i) => html`
              <li key=${i} class="drawer-acceptance-row">
                <span class="drawer-check-glyph">·</span>
                <span>${c}</span>
              </li>
            `)}
          </ul>
        </${DrawerSection}>`
      : null}

    ${refs.length > 0
      ? html`<${DrawerSection} label="REFERENCES">
          <${ReferenceList} items=${refs} />
        </${DrawerSection}>`
      : null}

    ${snippets.length > 0
      ? html`<${DrawerSection} label="SNIPPETS">
          <${SnippetList} items=${snippets} />
        </${DrawerSection}>`
      : null}
  `;
}

function VerifyContent({ payload }) {
  if (!payload) return null;
  const checks = payload.checks || [];
  const contract = payload.verificationContract || {};
  const dod = contract.definition_of_done || [];
  const evidence = payload.evidenceSources || {};
  const taskState = evidence.taskState || null;
  const refs = payload.references || [];

  const acceptance = checks.filter((c) =>
    c.kind === "definition_of_done" || c.kind === "task_status"
  );
  const constraints = checks.filter((c) =>
    c.kind === "expected_change" || c.kind === "allowed_path"
  );
  const depChecks = checks.filter((c) => c.kind === "dependency_state");

  return html`
    <${DrawerSection} label="ACCEPTANCE">
      ${acceptance.length > 0
        ? html`<ul class="drawer-acceptance-list">
            ${acceptance.map((c, i) => html`
              <li key=${i} class="drawer-acceptance-row">
                <span class=${`drawer-check-glyph drawer-check--${c.status || "pending"}`}>
                  ${c.status === "satisfied" || c.status === "ready_to_review" ? "☑" : "☐"}
                </span>
                <span>${c.text}</span>
              </li>
            `)}
          </ul>`
        : NONE}
    </${DrawerSection}>

    ${constraints.length > 0
      ? html`<${DrawerSection} label="CONSTRAINTS">
          <ul class="drawer-acceptance-list">
            ${constraints.map((c, i) => html`
              <li key=${i} class="drawer-acceptance-row">
                <span class="drawer-check-glyph">·</span>
                <span>${c.text}</span>
              </li>
            `)}
          </ul>
        </${DrawerSection}>`
      : null}

    ${depChecks.length > 0
      ? html`<${DrawerSection} label="DEPENDENCIES">
          <ul class="drawer-acceptance-list">
            ${depChecks.map((c, i) => html`
              <li key=${i} class="drawer-acceptance-row">
                <span class=${`drawer-check-glyph drawer-check--${c.status}`}>
                  ${c.status === "satisfied" ? "☑" : "☐"}
                </span>
                <span>${c.text}</span>
              </li>
            `)}
          </ul>
        </${DrawerSection}>`
      : null}

    ${taskState
      ? html`<${DrawerSection} label="VERDICT">
          <div class="drawer-verdict">
            <span class="drawer-verdict-status">${taskState.status || "—"}</span>
            ${taskState.lastTouchedRev != null
              ? html`<span class="drawer-verdict-rev">rev ${taskState.lastTouchedRev}</span>`
              : null}
            ${taskState.assignee
              ? html`<span class="drawer-verdict-assignee">${taskState.assignee}</span>`
              : null}
          </div>
        </${DrawerSection}>`
      : null}

    ${refs.length > 0
      ? html`<${DrawerSection} label="REFERENCES">
          <${ReferenceList} items=${refs} />
        </${DrawerSection}>`
      : null}
  `;
}

function PackLoading({ mode }) {
  return html`
    <div class="card__drawer-section">
      <div class="card__drawer-body drawer-pack-loading">
        <span class="drawer-dot-spin">·</span> Loading ${mode} pack…
      </div>
    </div>
  `;
}

function PackError({ mode, onRetry }) {
  return html`
    <div class="card__drawer-section">
      <div class="card__drawer-body" style="color:var(--block)">
        Couldn't load ${mode} pack
        <button class="bracket drawer-retry" style="margin-left:8px" onClick=${onRetry}>
          [RETRY]
        </button>
      </div>
    </div>
  `;
}

function PackEmpty({ mode }) {
  return html`
    <div class="card__drawer-section">
      <div class="card__drawer-placeholder">— no ${mode} content —</div>
    </div>
  `;
}

export function TaskInlineDrawer({ slug, task, onOpenTask, onClose }) {
  const [mode, setMode] = useState("brief");
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const drawerRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    setMode("brief");
    setCache({});
    setError(null);
    setLoading(false);
  }, [slug, task?.id]);

  useEffect(() => {
    if (!slug || !task?.id) return undefined;
    const cacheKey = `${task.id}:${mode}`;
    if (cache[cacheKey] !== undefined) return undefined;

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    fetchPack(slug, task.id, mode, controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return;
        setCache((prev) => ({ ...prev, [cacheKey]: body }));
        setLoading(false);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === "AbortError") return;
        setLoading(false);
        setError(err.message || "request failed");
      });

    return () => {
      controller.abort();
    };
  }, [slug, task?.id, mode]);

  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (retryKey === 0) return undefined;
    if (!slug || !task?.id) return undefined;
    const cacheKey = `${task.id}:${mode}`;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setCache((prev) => {
      const next = { ...prev };
      delete next[cacheKey];
      return next;
    });

    fetchPack(slug, task.id, mode, controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return;
        setCache((prev) => ({ ...prev, [cacheKey]: body }));
        setLoading(false);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === "AbortError") return;
        setLoading(false);
        setError(err.message || "request failed");
      });

    return () => controller.abort();
  }, [retryKey]);

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
  const cacheKey = `${task?.id}:${mode}`;
  const payload = cache[cacheKey];

  const tabs = [
    { id: "brief", label: "READ" },
    { id: "why", label: "WHY" },
    { id: "execute", label: "EXEC" },
    { id: "verify", label: "VERIFY" },
  ];

  function renderContent() {
    if (loading) return html`<${PackLoading} mode=${mode} />`;
    if (error) return html`<${PackError} mode=${mode} onRetry=${() => setRetryKey((v) => v + 1)} />`;
    if (!payload) return html`<${PackEmpty} mode=${mode} />`;
    if (mode === "brief") return html`<${BriefContent} payload=${payload} onOpenTask=${onOpenTask} />`;
    if (mode === "why") return html`<${WhyContent} payload=${payload} onOpenTask=${onOpenTask} />`;
    if (mode === "execute") return html`<${ExecContent} payload=${payload} />`;
    if (mode === "verify") return html`<${VerifyContent} payload=${payload} />`;
    return null;
  }

  return html`
    <div
      ref=${drawerRef}
      class="card__drawer"
      role="region"
      tabIndex="-1"
      aria-label=${`${mode} for ${task?.id || "task"}`}
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

      ${renderContent()}

      <div class="card__drawer-tabs">
        ${tabs.map(({ id, label }) => html`
          <button
            key=${id}
            class=${`bracket ${mode === id ? "bracket--active" : ""}`}
            title=${`${label} — ${task?.id}`}
            aria-label=${`${label} — ${mode === id ? "currently shown" : ""}`}
            onClick=${() => setMode(id)}
          >[${label}]</button>
        `)}
      </div>
    </div>
  `;
}
