import { html } from "htm/preact";
import { CompletionGatesPanel } from "./CompletionGatesPanel.js";
import { StdioBadge } from "./StdioBadge.js";

export const SESSION_CARD_SIZES = Object.freeze(["compact", "normal", "large"]);
export const JOB_ACTION_UNBOUND_REASON = "session has no active job; bind a task first";
export const UNBIND_ACTIVE_CONFIRMATION = "Unbind active job and cancel it first?";
const JOB_ACTIONS = Object.freeze(["VERIFY", "COMPLETE", "SKILLS"]);

export function normalizeSessionCardSize(size) {
  return SESSION_CARD_SIZES.includes(size) ? size : "normal";
}

function sessionTitle(session) {
  if (typeof session?.name === "string" && session.name.length > 0) return session.name;
  if (typeof session?.id === "string" && session.id.length > 0) return session.id;
  return "Untitled session";
}

function warningSourceLabel(warning) {
  if (!warning || typeof warning !== "object") return null;
  if (typeof warning.source === "string" && warning.source.length > 0) return warning.source;
  if (typeof warning.kind === "string" && warning.kind.length > 0) return warning.kind;
  return null;
}

function warningEvidenceLabel(warning) {
  if (!warning || typeof warning !== "object") return null;
  if (typeof warning.evidenceRef === "string" && warning.evidenceRef.length > 0) return warning.evidenceRef;
  if (typeof warning.evidence === "string" && warning.evidence.length > 0) return warning.evidence;
  return null;
}

function repoLabel(session) {
  if (typeof session?.repoRoot === "string" && session.repoRoot.length > 0) return session.repoRoot;
  return "repo unknown";
}

function normalizeTaskLedger(session) {
  const ledger = session?.taskLedger || session?.taskLedgerItems || session?.ledger;
  if (!Array.isArray(ledger)) return [];
  return ledger.filter((item) => item && typeof item.taskId === "string" && item.taskId.length > 0);
}

function defaultConfirmUnbind(message) {
  if (typeof globalThis.confirm !== "function") return true;
  return globalThis.confirm(message);
}

function taskLedgerLabel(item) {
  return item.title || item.taskTitle || item.taskId;
}

export function SessionCard({
  session,
  size = "normal",
  onUnbindTask,
  confirmUnbind = defaultConfirmUnbind,
  completionPanel = null,
  onCompleteJob,
  onCloseCompletionGates,
  onRunMissingGates,
  onResolveHumanApproval,
  onSpawnReviewer,
  onOverrideComplete,
  onCompletionPanelValidationError,
} = {}) {
  if (!session || typeof session !== "object") return null;
  const warnings = Array.isArray(session.warnings) ? session.warnings : [];
  const asks = Array.isArray(session.asks) ? session.asks : [];
  const taskLedger = normalizeTaskLedger(session);
  const cardSize = normalizeSessionCardSize(size);
  const activeJobId = typeof session.activeJobId === "string" && session.activeJobId.length > 0
    ? session.activeJobId
    : null;
  const jobActionDisabledReason = activeJobId ? null : JOB_ACTION_UNBOUND_REASON;
  const handleUnbind = (item) => {
    if (typeof onUnbindTask !== "function") return;
    const requiresConfirmation = item.relation === "active_job" || (item.jobId && item.jobId === activeJobId);
    if (requiresConfirmation && typeof confirmUnbind === "function") {
      const accepted = confirmUnbind(UNBIND_ACTIVE_CONFIRMATION, { session, item });
      if (!accepted) return;
    }
    onUnbindTask({
      sessionId: session.id,
      taskId: item.taskId,
      jobId: item.jobId,
      relation: item.relation,
      force: requiresConfirmation,
    });
  };
  const handleJobAction = (label) => {
    if (!activeJobId) return;
    if (label === "COMPLETE" && typeof onCompleteJob === "function") {
      onCompleteJob({ sessionId: session.id, jobId: activeJobId, session });
    }
  };

  return html`
    <article
      class=${`session-card session-card--${cardSize}`}
      data-session-id=${session.id || ""}
      data-card-size=${cardSize}
    >
      <header class="session-card__header">
        <div class="session-card__identity">
          <span class="session-card__id">${session.id || "session"}</span>
          <strong class="session-card__title">${sessionTitle(session)}</strong>
        </div>
        <${StdioBadge} session=${session} />
      </header>

      <div class="session-card__meta">
        <span class=${`session-card__status session-card__status--${session.status || "unknown"}`}>
          ${session.status || "unknown"}
        </span>
        ${session.tier ? html`<span class="session-card__tier">${session.tier}</span>` : null}
        <span class=${`session-card__repo ${session.repoRoot ? "session-card__repo--known" : "session-card__repo--unknown"}`}>
          ${repoLabel(session)}
        </span>
      </div>

      <div class="session-card__job-actions" data-active-job-id=${activeJobId || ""}>
        ${JOB_ACTIONS.map((label) => html`
          <button
            key=${label}
            class="session-card__job-action"
            type="button"
            disabled=${!activeJobId}
            title=${jobActionDisabledReason || activeJobId}
            aria-label=${jobActionDisabledReason ? `${label}: ${jobActionDisabledReason}` : `${label}: ${activeJobId}`}
            onClick=${() => handleJobAction(label)}
          >
            ${label}
          </button>
        `)}
        ${jobActionDisabledReason
          ? html`<span class="session-card__job-action-reason">${jobActionDisabledReason}</span>`
          : null}
      </div>

      ${taskLedger.length
        ? html`
            <ul class="session-card__task-ledger" aria-label="Session task ledger">
              ${taskLedger.map((item) => {
                const relation = item.relation || "mentioned";
                const requiresConfirmation = relation === "active_job" || (item.jobId && item.jobId === activeJobId);
                return html`
                  <li key=${`${item.taskId}:${relation}`} class="session-card__task-ledger-row" data-relation=${relation}>
                    <span class="session-card__task-ledger-task">${taskLedgerLabel(item)}</span>
                    <span class="session-card__task-ledger-relation">${relation}</span>
                    <button
                      class="session-card__unbind-chip"
                      type="button"
                      disabled=${typeof onUnbindTask !== "function"}
                      title=${requiresConfirmation ? UNBIND_ACTIVE_CONFIRMATION : "Unbind task from session"}
                      onClick=${() => handleUnbind(item)}
                    >
                      [Unbind]
                    </button>
                  </li>
                `;
              })}
            </ul>
          `
        : null}

      ${completionPanel
        ? html`
            <${CompletionGatesPanel}
              result=${completionPanel.result}
              session=${session}
              jobId=${activeJobId}
              busyAction=${completionPanel.busyAction}
              message=${completionPanel.message}
              error=${completionPanel.error}
              onClose=${onCloseCompletionGates}
              onRunMissing=${onRunMissingGates}
              onResolveHumanApproval=${onResolveHumanApproval}
              onSpawnReviewer=${onSpawnReviewer}
              onOverrideComplete=${onOverrideComplete}
              onValidationError=${onCompletionPanelValidationError}
            />
          `
        : null}

      ${warnings.length
        ? html`
            <ul class="session-card__warnings">
              ${warnings.map((warning, index) => {
                const source = warningSourceLabel(warning) || "unknown";
                const evidence = warningEvidenceLabel(warning) || "none";
                return html`
                  <li key=${`${warning?.kind || "warning"}:${index}`} class="session-card__warning">
                    <span class="session-card__warning-source">
                      <span class="session-card__warning-label">source</span>
                      <span>${source}</span>
                    </span>
                    <span class="session-card__warning-evidence">
                      <span class="session-card__warning-label">evidence</span>
                      <span>${evidence}</span>
                    </span>
                    <span class="session-card__warning-message">${warning?.message || warning?.kind || "Session warning"}</span>
                  </li>
                `;
              })}
            </ul>
          `
        : null}

      ${asks.length
        ? html`
            <ul class="session-card__asks">
              ${asks.map((ask, index) => html`
                <li key=${`${ask?.eventId || "ask"}:${index}`} class="session-card__ask">
                  <span class="session-card__ask-label">ask</span>
                  <span class="session-card__ask-from">${ask?.from || "session"}</span>
                  <span class="session-card__ask-prompt">${ask?.prompt || "Question requested"}</span>
                </li>
              `)}
            </ul>
          `
        : null}
    </article>
  `;
}
