import { html } from "htm/preact";
import { CompletionGatesPanel } from "./CompletionGatesPanel.js";
import { StdioBadge } from "./StdioBadge.js";
import { normalizeTimelineItems, timelineEvidenceHref } from "./TimelinePanel.js";

export const SESSION_CARD_SIZES = Object.freeze(["compact", "normal", "large"]);
export const JOB_ACTION_UNBOUND_REASON = "session has no active job; bind a task first";
export const UNBIND_ACTIVE_CONFIRMATION = "Unbind active job and cancel it first?";
export const WORKTREE_DEFAULT_NAMING_PATTERN = "{projectSlug}/{taskId}-{shortTitle}";
export const WORKTREE_CREATE_DISABLED_REASON =
  "Worktree creation requires trustedLocalMode.allowWorktreeCreationFromUI";
export const WORKTREE_BIND_DISABLED_REASON = "Bind worktree handler unavailable";
export const REPO_WORKTREE_SET_DISABLED_REASON = "Set repo/worktree handler unavailable";
export const WORKTREE_ACK_DISABLED_REASON = "Acknowledge shared worktree handler unavailable";
export const WORKTREE_ARCHIVE_DISABLED_REASON = "Archive worktree handler unavailable";
export const WORKTREE_DELETE_DISABLED_REASON = "Delete worktree handler unavailable";
export const WORKTREE_ARCHIVE_CONFIRMATION = "archive_worktree";
export const WORKTREE_DELETE_CONFIRMATION = "delete_worktree";
export const WORKTREE_ARCHIVE_MESSAGE = "Archive this worktree after closeout?";
export const WORKTREE_DELETE_MESSAGE =
  "Delete this worktree from disk after closeout? Dirty or in-flight worktrees must be refused.";
const JOB_ACTIONS = Object.freeze(["VERIFY", "COMPLETE", "SKILLS"]);
const CLOSEOUT_READY_STATUSES = new Set(["done", "complete", "completed", "stopped", "archived"]);

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

function normalizeTimelinePreview(session) {
  const items = session?.timelineItems || session?.timelinePreview || session?.timeline;
  return normalizeTimelineItems(items).slice(-3);
}

function defaultConfirmUnbind(message) {
  if (typeof globalThis.confirm !== "function") return true;
  return globalThis.confirm(message);
}

function defaultConfirmWorktreeAction(message) {
  if (typeof globalThis.confirm !== "function") return false;
  return globalThis.confirm(message);
}

function taskLedgerLabel(item) {
  return item.title || item.taskTitle || item.taskId;
}

function boolWithDefault(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function slugPart(value, fallback = "session") {
  const raw = typeof value === "string" && value.length > 0 ? value : fallback;
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function primaryTaskForWorktree(session, taskLedger) {
  const active = taskLedger.find((item) => item.relation === "active_job" || item.jobId === session.activeJobId);
  if (active) return active;
  if (taskLedger.length > 0) return taskLedger[0];
  if (typeof session.taskId === "string" && session.taskId.length > 0) {
    return { taskId: session.taskId, title: session.taskTitle || session.title };
  }
  return null;
}

function hasSharedWorktreeWarning(warnings) {
  return warnings.some((warning) => {
    const kind = warning?.kind;
    return kind === "multiple_sessions_same_worktree" || kind === "shared_worktree";
  });
}

function existingWorktreeTarget(session) {
  const worktree = session?.worktree && typeof session.worktree === "object" ? session.worktree : null;
  const id = typeof session?.worktreeId === "string" && session.worktreeId.length > 0
    ? session.worktreeId
    : typeof worktree?.id === "string" && worktree.id.length > 0
      ? worktree.id
      : null;
  const path = typeof session?.worktreePath === "string" && session.worktreePath.length > 0
    ? session.worktreePath
    : typeof worktree?.path === "string" && worktree.path.length > 0
      ? worktree.path
      : null;
  return id || path ? { id, path } : null;
}

function closeoutReady(session, completionPanel) {
  if (session?.closeoutReady === true || session?.closeoutComplete === true) return true;
  if (session?.closeout && typeof session.closeout === "object") {
    if (session.closeout.ready === true || session.closeout.complete === true) return true;
  }
  if (typeof session?.status === "string" && CLOSEOUT_READY_STATUSES.has(session.status)) return true;
  const mode = completionPanel?.result?.mode;
  return mode === "complete" || mode === "completed";
}

export function normalizeSessionWorktreeConfig({ trustedLocalMode, worktrees } = {}) {
  const allowCreate = boolWithDefault(trustedLocalMode?.allowWorktreeCreationFromUI, true);
  const allowAutoCreate = allowCreate && boolWithDefault(worktrees?.allowTrustedAutoCreateOnLaunch, true);
  const pattern = typeof worktrees?.defaultNamingPattern === "string" && worktrees.defaultNamingPattern.length > 0
    ? worktrees.defaultNamingPattern
    : WORKTREE_DEFAULT_NAMING_PATTERN;
  return {
    allowCreate,
    allowAutoCreate,
    pattern,
  };
}

export function formatSessionWorktreePath({ session = {}, task = null, pattern = WORKTREE_DEFAULT_NAMING_PATTERN } = {}) {
  const taskId = task?.taskId || session.taskId || "task";
  const projectSlug = session.projectSlug || task?.projectSlug || "project";
  const title = task?.title || task?.taskTitle || session.taskTitle || session.name || taskId;
  const values = {
    projectSlug: slugPart(projectSlug, "project"),
    taskId: slugPart(taskId, "task"),
    shortTitle: slugPart(title, "worktree"),
    sessionId: slugPart(session.id, "session"),
  };
  return pattern.replace(/\{(projectSlug|taskId|shortTitle|sessionId)\}/g, (_match, key) => values[key]);
}

export function SessionCard({
  session,
  size = "normal",
  trustedLocalMode,
  worktrees,
  onUnbindTask,
  onCreateWorktree,
  onBindWorktree,
  onSetRepoWorktree,
  onAcknowledgeSharedWorktree,
  onArchiveWorktree,
  onDeleteWorktree,
  confirmUnbind = defaultConfirmUnbind,
  confirmWorktreeArchive = defaultConfirmWorktreeAction,
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
  const timelinePreview = cardSize === "large" ? normalizeTimelinePreview(session) : [];
  const worktreeConfig = normalizeSessionWorktreeConfig({ trustedLocalMode, worktrees });
  const worktreeTask = primaryTaskForWorktree(session, taskLedger);
  const worktreePath = formatSessionWorktreePath({
    session,
    task: worktreeTask,
    pattern: worktreeConfig.pattern,
  });
  const existingWorktree = existingWorktreeTarget(session);
  const repoUnknown = !(typeof session.repoRoot === "string" && session.repoRoot.length > 0);
  const bindRepoWorktreeHandler = repoUnknown && typeof onSetRepoWorktree === "function"
    ? onSetRepoWorktree
    : onBindWorktree;
  const canOfferArchive = closeoutReady(session, completionPanel) && Boolean(existingWorktree);
  const sharedWorktree = hasSharedWorktreeWarning(warnings);
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
  const handleCreateWorktree = () => {
    if (!worktreeConfig.allowCreate || typeof onCreateWorktree !== "function") return;
    onCreateWorktree({
      sessionId: session.id,
      projectSlug: session.projectSlug || worktreeTask?.projectSlug || null,
      taskId: worktreeTask?.taskId || session.taskId || null,
      worktreePath,
      namingPattern: worktreeConfig.pattern,
      oneClickAutoCreate: worktreeConfig.allowAutoCreate,
    });
  };
  const handleBindWorktree = () => {
    if (typeof bindRepoWorktreeHandler !== "function") return;
    bindRepoWorktreeHandler({
      sessionId: session.id,
      repoRoot: session.repoRoot || null,
      worktreePath: session.worktreePath || null,
    });
  };
  const handleAcknowledgeSharedWorktree = () => {
    if (!sharedWorktree || typeof onAcknowledgeSharedWorktree !== "function") return;
    onAcknowledgeSharedWorktree({
      sessionId: session.id,
      worktreePath: session.worktreePath || session.repoRoot || null,
    });
  };
  const worktreeArchivePayload = (deleteFromDisk = false) => ({
    sessionId: session.id,
    jobId: activeJobId,
    projectSlug: session.projectSlug || worktreeTask?.projectSlug || null,
    taskId: worktreeTask?.taskId || session.taskId || null,
    worktreeId: existingWorktree?.id || null,
    worktreePath: existingWorktree?.path || null,
    reason: worktrees?.archiveReason || "session closeout",
    confirmation: WORKTREE_ARCHIVE_CONFIRMATION,
    deleteFromDisk,
    ...(deleteFromDisk ? { deleteConfirmation: WORKTREE_DELETE_CONFIRMATION } : {}),
  });
  const confirmWorktreeAction = (message, payload) => {
    if (typeof confirmWorktreeArchive !== "function") return false;
    return confirmWorktreeArchive(message, { session, payload }) === true;
  };
  const handleArchiveWorktree = () => {
    if (!canOfferArchive || typeof onArchiveWorktree !== "function") return;
    const payload = worktreeArchivePayload(false);
    if (!confirmWorktreeAction(WORKTREE_ARCHIVE_MESSAGE, payload)) return;
    onArchiveWorktree(payload);
  };
  const handleDeleteWorktree = () => {
    if (!canOfferArchive || typeof onDeleteWorktree !== "function") return;
    const payload = worktreeArchivePayload(true);
    if (!confirmWorktreeAction(WORKTREE_DELETE_MESSAGE, payload)) return;
    onDeleteWorktree(payload);
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
        <span class=${`session-card__repo ${repoUnknown ? "session-card__repo--unknown" : "session-card__repo--known"}`}>
          ${repoLabel(session)}
        </span>
      </div>

      ${timelinePreview.length
        ? html`
            <ol class="session-card__timeline-preview" aria-label="Timeline preview">
              ${timelinePreview.map((item) => html`
                <li key=${item.id} class="session-card__timeline-preview-item" data-kind=${item.kind}>
                  <span class="session-card__timeline-preview-icon" aria-label=${item.kind}>${item.icon}</span>
                  <span class="session-card__timeline-preview-title">${item.title}</span>
                  ${item.ts ? html`<time class="session-card__timeline-preview-time" datetime=${item.ts}>${item.ts}</time>` : null}
                  ${item.evidenceRef
                    ? html`
                        <a
                          class="session-card__timeline-preview-evidence"
                          href=${timelineEvidenceHref(item.evidenceRef)}
                          data-evidence-ref=${item.evidenceRef}
                        >
                          ${item.evidenceRef}
                        </a>
                      `
                    : null}
                </li>
              `)}
            </ol>
          `
        : null}

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

      <div
        class="session-card__worktree-actions"
        data-worktree-path=${worktreePath}
        data-auto-create=${worktreeConfig.allowAutoCreate ? "true" : "false"}
      >
        <button
          class="session-card__worktree-action"
          type="button"
          disabled=${!worktreeConfig.allowCreate || typeof onCreateWorktree !== "function"}
          title=${worktreeConfig.allowCreate ? worktreePath : WORKTREE_CREATE_DISABLED_REASON}
          onClick=${handleCreateWorktree}
        >
          [CREATE WORKTREE]
        </button>
        <button
          class="session-card__worktree-action"
          type="button"
          disabled=${typeof bindRepoWorktreeHandler !== "function"}
          title=${typeof bindRepoWorktreeHandler === "function"
            ? "Bind this session to a repo/worktree"
            : repoUnknown
              ? REPO_WORKTREE_SET_DISABLED_REASON
              : WORKTREE_BIND_DISABLED_REASON}
          onClick=${handleBindWorktree}
        >
          ${repoUnknown ? "[SET REPO/WORKTREE]" : "[BIND WORKTREE]"}
        </button>
        ${sharedWorktree
          ? html`
              <button
                class="session-card__worktree-action"
                type="button"
                disabled=${typeof onAcknowledgeSharedWorktree !== "function"}
                title=${typeof onAcknowledgeSharedWorktree === "function"
                  ? "Acknowledge shared worktree risk"
                  : WORKTREE_ACK_DISABLED_REASON}
                onClick=${handleAcknowledgeSharedWorktree}
              >
                [ACKNOWLEDGE SHARED WORKTREE]
              </button>
            `
          : null}
        ${canOfferArchive
          ? html`
              <button
                class="session-card__worktree-action"
                type="button"
                disabled=${typeof onArchiveWorktree !== "function"}
                title=${typeof onArchiveWorktree === "function"
                  ? "Archive worktree metadata after closeout"
                  : WORKTREE_ARCHIVE_DISABLED_REASON}
                onClick=${handleArchiveWorktree}
              >
                [ARCHIVE WORKTREE]
              </button>
              <button
                class="session-card__worktree-action session-card__worktree-action--danger"
                type="button"
                disabled=${typeof onDeleteWorktree !== "function"}
                title=${typeof onDeleteWorktree === "function"
                  ? "Delete worktree from disk after safety checks"
                  : WORKTREE_DELETE_DISABLED_REASON}
                onClick=${handleDeleteWorktree}
              >
                [DELETE WORKTREE]
              </button>
            `
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
