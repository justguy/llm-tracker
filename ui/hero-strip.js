import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { buildHeroReason, buildHeroSummary } from "./lib/hero-strip.js";
import { Bracket } from "./primitives.js";

export async function loadNextRecommendation(slug, fetchImpl = fetch) {
  const res = await fetchImpl(`/api/projects/${slug}/next?limit=1`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || res.statusText || "request failed");
  }
  return body;
}

export function HeroStripView({
  summary,
  slug,
  nextTask,
  nextLoading = false,
  nextError = "",
  onPickTask,
  onOpenTaskModal
}) {
  const reasonStr = Array.isArray(nextTask?.reason) && nextTask.reason.length > 0
    ? nextTask.reason.join(" · ")
    : buildHeroReason(nextTask);
  const nextTitle = nextLoading
    ? "Loading ranked shortlist"
    : nextError
      ? "Recommendation unavailable"
      : nextTask?.title || "No ready task";
  const nextReason = nextLoading
    ? "Fetching the current top-ranked task from /next."
    : nextError
      ? nextError
      : nextTask
        ? reasonStr
        : "No ready task is available from the current ranking.";
  const nextTaskId = nextLoading ? "—" : nextTask?.id || "—";
  const actionsDisabled = nextLoading || !nextTask;

  return html`
    <div class="hero-strip">
      <div class="hero-col hero-col--left">
        <div class="hero-meta">${summary.swimlaneCount} swimlane${summary.swimlaneCount !== 1 ? "s" : ""} · ${summary.total} tasks · updated ${summary.updatedAt}${summary.trackerPath ? ` · ${summary.trackerPath}` : ""}</div>
        <div class="hero-display">
          <span class="hero-display__pct">${summary.pct}<span class="hero-display__unit">%</span></span>
          <span class="hero-display__text">${summary.complete} of ${summary.total} tasks complete</span>
        </div>
        <div class="hero-progress">
          ${summary.completeW > 0 ? html`<span class="hero-progress__segment--complete" style=${`width:${summary.completeW}%`}></span>` : null}
          ${summary.warnW > 0 ? html`<span class="hero-progress__segment--warn" style=${`left:${summary.completeW}%;width:${summary.warnW}%`}></span>` : null}
        </div>
      </div>
      <div class="hero-col hero-col--status">
        <div class="hero-eyebrow">STATUS</div>
        <div class="hero-status__grid">
          ${summary.statusTiles.map((tile) => html`
            <div key=${tile.key} class=${`hero-tile ${tile.strong ? "hero-tile--strong" : ""}`}>
              <span class="hero-tile__dot" style=${`background:${tile.color}`}></span>
              <span class="hero-tile__label">${tile.label}</span>
              <span class="hero-tile__count" style=${tile.count === 0 ? "color:var(--ink-3)" : ""}>${tile.count}</span>
            </div>
          `)}
        </div>
      </div>
      <div class="hero-col hero-col--next">
        <div class="hero-next">
          <div class="hero-next__head">
            <span>★ RECOMMENDED NEXT</span>
            <span>${nextTaskId}</span>
          </div>
          <div class="hero-next__title">${nextTitle}</div>
          <div class="hero-next__reason">${nextReason}</div>
          <div class="hero-next__actions">
            <${Bracket}
              label="PICK"
              active
              tone="ok"
              disabled=${actionsDisabled}
              title=${actionsDisabled ? "Recommendation is not ready to pick" : "Claim the recommended task"}
              onClick=${() => !actionsDisabled && onPickTask && onPickTask(slug, nextTask.id)}
            />
            <${Bracket}
              label="READ"
              tone="ok"
              disabled=${actionsDisabled}
              title=${actionsDisabled ? "Recommendation is not ready to read" : "Open the task brief"}
              onClick=${() => !actionsDisabled && onOpenTaskModal && onOpenTaskModal(slug, nextTask.id, "brief")}
            />
          </div>
        </div>
      </div>
    </div>
  `;
}

export function HeroStrip({ project, slug, onPickTask, onOpenTaskModal }) {
  const [nextData, setNextData] = useState(null);
  const [nextLoading, setNextLoading] = useState(false);
  const [nextError, setNextError] = useState("");

  useEffect(() => {
    if (!slug) {
      setNextData(null);
      setNextLoading(false);
      setNextError("");
      return;
    }

    let cancelled = false;
    setNextData(null);
    setNextLoading(true);
    setNextError("");
    loadNextRecommendation(slug)
      .then((body) => {
        if (cancelled) return;
        setNextData(body);
        setNextLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setNextData(null);
        setNextError(error?.message || "request failed");
        setNextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, project?.rev]);

  if (!project?.data) return null;

  const summary = buildHeroSummary(project, slug);
  const nextTask = nextData?.next?.[0] ?? null;
  return html`
    <${HeroStripView}
      summary=${summary}
      slug=${slug}
      nextTask=${nextTask}
      nextLoading=${nextLoading}
      nextError=${nextError}
      onPickTask=${onPickTask}
      onOpenTaskModal=${onOpenTaskModal}
    />
  `;
}
