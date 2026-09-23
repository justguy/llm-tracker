import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";

export const WORKSPACE_LANE_CHIPS = Object.freeze([
  { id: "runnable_now", label: "Runnable now" },
  { id: "blocked", label: "Blocked" },
  { id: "needs_review", label: "Needs review" },
  { id: "needs_closeout", label: "Needs closeout" },
  { id: "quiet", label: "Quiet" },
]);

const DEFAULT_TOP_N = 5;
const ABSOLUTE_MULTI_LAUNCH_CAP = 3;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function uniqueTextList(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const next = text(value);
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

function projectSlugFrom(project, fallback = "") {
  return text(project?.slug) || text(project?.projectSlug) || text(project?.id) || text(fallback);
}

export function normalizeWorkspaceProjects(projects) {
  if (Array.isArray(projects)) {
    return projects
      .filter(isRecord)
      .map((project) => ({ ...project, slug: projectSlugFrom(project) }))
      .filter((project) => project.slug);
  }
  if (isRecord(projects)) {
    return Object.entries(projects)
      .filter(([, project]) => isRecord(project))
      .map(([slug, project]) => ({ ...project, slug: projectSlugFrom(project, slug) }))
      .filter((project) => project.slug);
  }
  return [];
}

export function runCandidateKey(candidate) {
  const slug = text(candidate?.projectSlug);
  const taskId = text(candidate?.taskId);
  return slug && taskId ? `${slug}:${taskId}` : "";
}

export function normalizeWorkspaceCandidate(candidate, project = {}) {
  if (!isRecord(candidate)) return null;
  const projectSlug = text(candidate.projectSlug) || projectSlugFrom(project);
  const taskId = text(candidate.taskId) || text(candidate.id);
  if (!projectSlug || !taskId) return null;
  return {
    ...candidate,
    projectSlug,
    taskId,
    key: `${projectSlug}:${taskId}`,
    score: numberOrZero(candidate.score),
    reasons: uniqueTextList(candidate.reasons),
    penalties: uniqueTextList(candidate.penalties),
  };
}

export function candidateReasonText(candidate) {
  if (!isRecord(candidate)) return "";
  const parts = uniqueTextList(candidate.reasons).concat(uniqueTextList(candidate.penalties));
  if (parts.length > 0) return parts.join("; ");
  return `score ${numberOrZero(candidate.score)}`;
}

function resultProject(result) {
  return {
    slug: text(result?.projectSlug),
    label: text(result?.projectLabel) || text(result?.name),
  };
}

export function topWorkspaceRunCandidates(projectResults, { limit = DEFAULT_TOP_N } = {}) {
  const max = Math.max(0, Number.isInteger(limit) ? limit : DEFAULT_TOP_N);
  const rows = [];
  for (const result of Array.isArray(projectResults) ? projectResults : []) {
    if (!isRecord(result)) continue;
    const project = resultProject(result);
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    for (const candidate of candidates) {
      const row = normalizeWorkspaceCandidate(candidate, project);
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    const projectDelta = a.projectSlug.localeCompare(b.projectSlug);
    if (projectDelta !== 0) return projectDelta;
    return a.taskId.localeCompare(b.taskId);
  });
  return rows.slice(0, max);
}

export function multiLaunchLimit(crossProjectQueue = {}) {
  const configured = Number(crossProjectQueue?.maxInitialLaunches);
  if (!Number.isInteger(configured) || configured < 1) return ABSOLUTE_MULTI_LAUNCH_CAP;
  return Math.min(configured, ABSOLUTE_MULTI_LAUNCH_CAP);
}

export function requiresMultiLaunchConfirmation({ selectedCount = 0, crossProjectQueue = {} } = {}) {
  return selectedCount > 1 && crossProjectQueue?.requireHumanConfirmForMultiLaunch === true;
}

export function buildCrossProjectRunSelection({
  candidates = [],
  selectedKeys = [],
  crossProjectQueue = {},
} = {}) {
  const allowedKeys = new Set(Array.isArray(selectedKeys) ? selectedKeys.filter((key) => text(key)) : []);
  const limit = multiLaunchLimit(crossProjectQueue);
  const pool = Array.isArray(candidates) ? candidates : [];
  const selected = pool
    .filter((candidate) => allowedKeys.has(runCandidateKey(candidate) || candidate.key))
    .slice(0, limit);
  const requiresConfirmation = requiresMultiLaunchConfirmation({
    selectedCount: selected.length,
    crossProjectQueue,
  });
  return {
    source: "hub_run_cross_project",
    scope: "workspace-local",
    candidates: selected,
    taskIds: selected.map((candidate) => candidate.taskId),
    projectSlugs: Array.from(new Set(selected.map((candidate) => candidate.projectSlug))),
    maxInitialLaunches: limit,
    requiresConfirmation,
    confirmationReason: requiresConfirmation
      ? `Confirm launch of ${selected.length} workspace-local sessions`
      : "",
  };
}

async function parseJsonBody(response) {
  return response.json().catch(() => ({}));
}

function parseApiError(body, response) {
  return body?.error?.message || body?.error || response?.statusText || "candidate request failed";
}

export async function fetchWorkspaceRunCandidates({
  projects,
  limit = DEFAULT_TOP_N,
  fetcher = globalThis.fetch,
} = {}) {
  const workspaceProjects = normalizeWorkspaceProjects(projects);
  const results = [];
  for (const project of workspaceProjects) {
    const response = await fetcher(`/api/run-candidates?${new URLSearchParams({ projectSlug: project.slug }).toString()}`);
    const body = await parseJsonBody(response);
    if (!response.ok) throw new Error(parseApiError(body, response));
    results.push({
      projectSlug: text(body.projectSlug) || project.slug,
      projectLabel: text(project.label) || text(project.name) || project.slug,
      candidates: Array.isArray(body.candidates) ? body.candidates : [],
      rev: Number.isInteger(body.rev) ? body.rev : null,
    });
  }
  return {
    scope: "workspace-local",
    projectResults: results,
    candidates: topWorkspaceRunCandidates(results, { limit }),
  };
}

export function RunCandidatePickerView({
  candidates = [],
  selectedKeys = [],
  crossProjectQueue = {},
  loading = false,
  error = "",
  onToggleCandidate,
  onLaunch,
  onClose,
} = {}) {
  const keys = new Set(Array.isArray(selectedKeys) ? selectedKeys : []);
  const selection = buildCrossProjectRunSelection({ candidates, selectedKeys, crossProjectQueue });
  const launchDisabled = loading || selection.candidates.length === 0;
  return html`
    <section class="run-candidate-picker" data-scope="workspace-local">
      <header class="run-candidate-picker__header">
        <div>
          <span class="run-candidate-picker__eyebrow">Workspace-local</span>
          <h2 class="run-candidate-picker__title">Run candidates</h2>
        </div>
        ${typeof onClose === "function"
          ? html`<button class="run-candidate-picker__close" type="button" onClick=${onClose}>Close</button>`
          : null}
      </header>

      <div class="run-candidate-picker__chips" aria-label="Workspace triage lanes">
        ${WORKSPACE_LANE_CHIPS.map((chip) => html`
          <span key=${chip.id} class="run-candidate-picker__chip" data-lane-chip=${chip.id}>${chip.label}</span>
        `)}
      </div>

      ${error ? html`<p class="run-candidate-picker__error">${error}</p>` : null}
      ${loading ? html`<p class="run-candidate-picker__loading">Loading candidates</p>` : null}

      <ol class="run-candidate-picker__list">
        ${candidates.map((candidate) => {
          const key = runCandidateKey(candidate) || candidate.key;
          const selected = keys.has(key);
          return html`
            <li key=${key} class="run-candidate-picker__row" data-candidate-key=${key}>
              <label class="run-candidate-picker__candidate">
                <input
                  type="checkbox"
                  checked=${selected}
                  onChange=${() => {
                    if (typeof onToggleCandidate === "function") onToggleCandidate(key);
                  }}
                />
                <span class="run-candidate-picker__main">
                  <span class="run-candidate-picker__task">${candidate.projectSlug}:${candidate.taskId}</span>
                  <span class="run-candidate-picker__reason">${candidateReasonText(candidate)}</span>
                </span>
                <span class="run-candidate-picker__score">${candidate.score}</span>
              </label>
            </li>
          `;
        })}
      </ol>

      <footer class="run-candidate-picker__footer">
        <span class="run-candidate-picker__summary">
          ${selection.candidates.length} selected / ${selection.maxInitialLaunches} max
          ${selection.requiresConfirmation ? " - confirmation required" : ""}
        </span>
        <button
          class="run-candidate-picker__launch"
          type="button"
          disabled=${launchDisabled}
          data-requires-confirmation=${selection.requiresConfirmation ? "true" : "false"}
          onClick=${() => {
            if (!launchDisabled && typeof onLaunch === "function") onLaunch(selection);
          }}
        >
          [+ RUN]
        </button>
      </footer>
    </section>
  `;
}

export function RunCandidatePicker({
  projects = [],
  initialCandidates = [],
  topN = DEFAULT_TOP_N,
  crossProjectQueue = {},
  fetcher = globalThis.fetch,
  onLaunch,
  onClose,
} = {}) {
  const initial = useMemo(() => topWorkspaceRunCandidates([{ projectSlug: "workspace", candidates: initialCandidates }], { limit: topN }), [initialCandidates, topN]);
  const [candidates, setCandidates] = useState(initial);
  const [selectedKeys, setSelectedKeys] = useState(() => initial.slice(0, 1).map((candidate) => candidate.key));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const workspaceProjects = normalizeWorkspaceProjects(projects);
    if (workspaceProjects.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchWorkspaceRunCandidates({ projects: workspaceProjects, limit: topN, fetcher })
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        setSelectedKeys(result.candidates.slice(0, 1).map((candidate) => candidate.key));
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Failed to load run candidates");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projects, topN, fetcher]);

  const toggleCandidate = (key) => {
    setSelectedKeys((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key);
      const limit = multiLaunchLimit(crossProjectQueue);
      return current.concat(key).slice(0, limit);
    });
  };

  return html`
    <${RunCandidatePickerView}
      candidates=${candidates}
      selectedKeys=${selectedKeys}
      crossProjectQueue=${crossProjectQueue}
      loading=${loading}
      error=${error}
      onToggleCandidate=${toggleCandidate}
      onLaunch=${onLaunch}
      onClose=${onClose}
    />
  `;
}
