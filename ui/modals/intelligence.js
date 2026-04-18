import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { TASK_INTEL_TABS, defaultChangedFromRev, isIntelModeLoading } from "../lib/intelligence.js";
import { ProjectIntelligenceView } from "./project-intelligence-view.js";
import { TaskIntelligenceView } from "./task-intelligence-view.js";

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchJson(path, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, { signal: controller.signal });
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

function useEscClose(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

async function loadTaskPayload(slug, taskId, mode) {
  return fetchJson(`/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/${mode}`);
}

async function loadProjectPayload(slug, mode, currentRev) {
  switch (mode) {
    case "next":
      return fetchJson(`/api/projects/${encodeURIComponent(slug)}/next?limit=5`);
    case "blockers":
      return fetchJson(`/api/projects/${encodeURIComponent(slug)}/blockers`);
    case "changed":
      return fetchJson(`/api/projects/${encodeURIComponent(slug)}/changed?fromRev=${defaultChangedFromRev(currentRev)}&limit=20`);
    case "decisions":
      return fetchJson(`/api/projects/${encodeURIComponent(slug)}/decisions?limit=20`);
    default:
      throw new Error(`Unknown project intelligence mode: ${mode}`);
  }
}

export function TaskIntelligenceModal({ slug, task, initialMode = "brief", onOpenTask, onClose }) {
  const [mode, setMode] = useState(initialMode);
  const [cache, setCache] = useState({});
  const [errors, setErrors] = useState({});

  useEscClose(onClose);

  useEffect(() => {
    setMode(initialMode);
    setCache({});
    setErrors({});
  }, [slug, task?.id, initialMode]);

  useEffect(() => {
    let cancelled = false;
    if (!task?.id || cache[mode] || errors[mode]) return undefined;

    loadTaskPayload(slug, task.id, mode)
      .then((payload) => {
        if (!cancelled) {
          setCache((prev) => ({ ...prev, [mode]: payload }));
          setErrors((prev) => {
            const next = { ...prev };
            delete next[mode];
            return next;
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrors((prev) => ({ ...prev, [mode]: err.message }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [slug, task?.id, mode, cache, errors]);

  const payload = cache[mode];
  const error = errors[mode] || null;
  const loading = isIntelModeLoading(cache, errors, mode);
  const retry = () => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[mode];
      return next;
    });
    setCache((prev) => {
      const next = { ...prev };
      delete next[mode];
      return next;
    });
  };

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal intel-modal" role="dialog" aria-modal="true" aria-label="Task intelligence" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">${TASK_INTEL_TABS.find((tab) => tab.id === mode)?.label || "[TASK]"} · ${slug}</span>
          <button class="icon-btn" aria-label="Close dialog" onClick=${onClose} title="Close (Esc)">×</button>
        </div>
        <div class="modal-body">
          <${TaskIntelligenceView}
            slug=${slug}
            task=${task}
            mode=${mode}
            payload=${payload}
            error=${error}
            loading=${loading}
            onRetry=${retry}
            onSelectMode=${setMode}
            onOpenTask=${onOpenTask}
          />
        </div>
      </div>
    </div>
  `;
}

export function ProjectIntelligenceModal({ slug, project, initialMode = "next", onOpenTask, onPickTask, onClose }) {
  const [mode, setMode] = useState(initialMode);
  const [cache, setCache] = useState({});
  const [errors, setErrors] = useState({});

  useEscClose(onClose);

  useEffect(() => {
    setMode(initialMode);
    setCache({});
    setErrors({});
  }, [slug, initialMode]);

  useEffect(() => {
    let cancelled = false;
    if (!slug || cache[mode] || errors[mode]) return undefined;

    loadProjectPayload(slug, mode, project?.data?.meta?.rev ?? null)
      .then((payload) => {
        if (!cancelled) {
          setCache((prev) => ({ ...prev, [mode]: payload }));
          setErrors((prev) => {
            const next = { ...prev };
            delete next[mode];
            return next;
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrors((prev) => ({ ...prev, [mode]: err.message }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [slug, mode, cache, errors, project?.data?.meta?.rev]);

  const payload = cache[mode];
  const error = errors[mode] || null;
  const loading = isIntelModeLoading(cache, errors, mode);
  const retry = () => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[mode];
      return next;
    });
    setCache((prev) => {
      const next = { ...prev };
      delete next[mode];
      return next;
    });
  };

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal intel-modal project-intel-modal" role="dialog" aria-modal="true" aria-label="Project intelligence" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[PROJECT INTEL] · ${slug}</span>
          <button class="icon-btn" aria-label="Close dialog" onClick=${onClose} title="Close (Esc)">×</button>
        </div>
        <div class="modal-body">
          <${ProjectIntelligenceView}
            slug=${slug}
            project=${project}
            mode=${mode}
            payload=${payload}
            error=${error}
            loading=${loading}
            onRetry=${retry}
            onSelectMode=${setMode}
            onOpenTask=${onOpenTask}
            onPickTask=${onPickTask}
          />
        </div>
      </div>
    </div>
  `;
}
