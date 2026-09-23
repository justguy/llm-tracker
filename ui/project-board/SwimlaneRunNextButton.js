import { html } from "htm/preact";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function candidateLaneId(candidate) {
  return text(candidate?.laneId) || text(candidate?.swimlaneId) || text(candidate?.placement?.swimlaneId);
}

export function runCandidateReason(candidate) {
  if (!isRecord(candidate)) return "";
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons.filter((value) => text(value)) : [];
  const penalties = Array.isArray(candidate.penalties) ? candidate.penalties.filter((value) => text(value)) : [];
  const parts = reasons.concat(penalties);
  if (parts.length > 0) return parts.join("; ");
  if (Number.isFinite(candidate.score)) return `score ${candidate.score}`;
  return "";
}

export function bestRunCandidateForLane(candidates, laneId) {
  const list = Array.isArray(candidates) ? candidates.filter(isRecord) : [];
  if (list.length === 0) return null;
  const targetLaneId = text(laneId);
  const laneCandidates = targetLaneId
    ? list.filter((candidate) => candidateLaneId(candidate) === targetLaneId)
    : list;
  const pool = laneCandidates.length > 0 ? laneCandidates : list;
  return pool.slice().sort((a, b) => {
    const scoreDelta = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return text(a.taskId).localeCompare(text(b.taskId));
  })[0] || null;
}

export function buildRunNextIntent({ projectSlug = "", lane = null, candidates = [] } = {}) {
  const laneId = text(lane?.id) || text(lane?.laneId);
  const candidate = bestRunCandidateForLane(candidates, laneId);
  const taskId = text(candidate?.taskId);
  if (!taskId) return null;
  return {
    source: "swimlane_next",
    projectSlug: text(projectSlug),
    swimlaneId: laneId,
    taskId,
    reason: runCandidateReason(candidate),
    candidate,
  };
}

export async function fetchRunCandidatesForLane({
  projectSlug,
  laneId,
  fetcher = globalThis.fetch,
} = {}) {
  const slug = text(projectSlug);
  if (!slug) throw new Error("projectSlug is required");
  const params = new URLSearchParams({ projectSlug: slug });
  const lane = text(laneId);
  if (lane) params.set("laneId", lane);
  const response = await fetcher(`/api/run-candidates?${params.toString()}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.error || response.statusText || "candidate request failed");
  return {
    candidates: Array.isArray(body.candidates) ? body.candidates : [],
    projectSlug: body.projectSlug || slug,
    laneId: body.laneId || lane || null,
    rev: Number.isInteger(body.rev) ? body.rev : null,
  };
}

export function SwimlaneRunNextButton({
  projectSlug = "",
  lane = null,
  candidates = [],
  disabled = false,
  onRunNext,
} = {}) {
  const intent = buildRunNextIntent({ projectSlug, lane, candidates });
  const reason = intent?.reason || "No run candidate";
  return html`
    <button
      class="swimlane-run-next-button"
      type="button"
      disabled=${disabled || !intent}
      title=${reason}
      aria-label=${intent ? `Run next in lane: ${intent.taskId}` : "No next task in lane"}
      data-task-id=${intent?.taskId || ""}
      data-reason=${reason}
      onClick=${() => {
        if (intent && typeof onRunNext === "function") onRunNext(intent);
      }}
    >
      [+ NEXT IN LANE]
    </button>
  `;
}
