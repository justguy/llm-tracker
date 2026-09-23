import { html } from "htm/preact";
import { ChatComposer } from "./ChatComposer.js";
import { DiffPanel } from "./DiffPanel.js";
import { SessionContextTab } from "./SessionContextTab.js";
import { SessionSkillsTab } from "./SessionSkillsTab.js";
import { StdioPanelView } from "./StdioPanel.js";
import { TimelinePanelView } from "./TimelinePanel.js";

export const SESSION_DETAIL_TABS = Object.freeze([
  "summary",
  "timeline",
  "stdio",
  "chat",
  "diff",
  "context",
  "skills",
  "events",
]);

const TAB_LABELS = Object.freeze({
  summary: "Summary",
  timeline: "Timeline",
  stdio: "Stdio raw",
  chat: "Chat",
  diff: "Diff/Evidence",
  context: "Context",
  skills: "Skills",
  events: "Events",
});

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sessionTitle(session) {
  return nonEmptyString(session?.name) || nonEmptyString(session?.id) || "Untitled session";
}

function repoLabel(session) {
  return nonEmptyString(session?.repoRoot) || "repo unknown";
}

function repoUnknown(session) {
  return !nonEmptyString(session?.repoRoot);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeActiveTab(tab) {
  return SESSION_DETAIL_TABS.includes(tab) ? tab : "timeline";
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function chatTurnsForSession(session) {
  const turns = [
    ...arrayFrom(session?.asks).map((ask) => ({ ...ask, role: "operator", text: ask.prompt })),
    ...arrayFrom(session?.chatTurns),
    ...arrayFrom(session?.messages),
    ...arrayFrom(session?.threadMessages),
    ...arrayFrom(session?.structuredEvents)
      .filter((event) => event?.type === "session.output" && event?.kind === "message")
      .map((event) => ({ ...event, role: event.role || "message", text: event.text || event.message || event.preview })),
  ].filter(isRecord);
  const seen = new Set();
  return turns.filter((turn, index) => {
    const key = nonEmptyString(turn.id) || nonEmptyString(turn.eventId) || `${turn.role || ""}:${turn.text || turn.prompt || ""}:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function structuredEventsForSession(session) {
  return [
    ...arrayFrom(session?.structuredEvents),
    ...arrayFrom(session?.events),
    ...arrayFrom(session?.runtimeEvents),
  ].filter((event) => isRecord(event) && event.type !== "session.output");
}

function SummaryPanel({ session, task, job }) {
  return html`
    <dl class="session-detail-dock__summary">
      <div>
        <dt>Status</dt>
        <dd>${session.status || "unknown"}</dd>
      </div>
      <div>
        <dt>Tier</dt>
        <dd>${session.tier || "unknown"}</dd>
      </div>
      <div>
        <dt>Repo</dt>
        <dd>${repoLabel(session)}</dd>
      </div>
      <div>
        <dt>Worktree</dt>
        <dd>${nonEmptyString(session.worktreePath) || "worktree unknown"}</dd>
      </div>
      ${session.activeJobId
        ? html`
            <div>
              <dt>Job</dt>
              <dd>${session.activeJobId}</dd>
            </div>
          `
        : null}
      ${task?.id
        ? html`
            <div>
              <dt>Task</dt>
              <dd>${task.title || task.id}</dd>
            </div>
          `
        : null}
      ${job?.status
        ? html`
            <div>
              <dt>Job status</dt>
              <dd>${job.status}</dd>
            </div>
          `
        : null}
    </dl>
  `;
}

function ChatPanel({
  session,
  draft = "",
  queuedDrafts = [],
  capabilities = {},
  sendError = "",
  onDraftChange,
  onQueuedDraftsChange,
  onInterrupt,
  onSend,
} = {}) {
  const turns = chatTurnsForSession(session);
  return html`
    <section class="session-detail-dock__chat" role="region" aria-label="Session chat">
      ${turns.length
        ? html`
            <ol class="session-detail-dock__chat-turns">
              ${turns.map((turn, index) => html`
                <li key=${turn.id || turn.eventId || index} class="session-detail-dock__chat-turn" data-kind=${turn.kind || turn.role || "message"}>
                  <span class="session-detail-dock__chat-role">${turn.role || turn.kind || "message"}</span>
                  <p>${turn.body || turn.text || turn.content || ""}</p>
                </li>
              `)}
            </ol>
          `
        : html`
            <div class="session-detail-dock__empty-panel">
              No messages yet. Send a message to start interacting with this session.
            </div>
          `}
      <${ChatComposer}
        session=${session}
        draft=${draft}
        queuedDrafts=${queuedDrafts}
        capabilities=${capabilities}
        sendError=${sendError}
        onDraftChange=${onDraftChange}
        onQueuedDraftsChange=${onQueuedDraftsChange}
        onInterrupt=${onInterrupt}
        onSend=${onSend}
      />
    </section>
  `;
}

function EventsPanel({ session }) {
  const events = structuredEventsForSession(session);
  return html`
    <section class="session-detail-dock__events" role="region" aria-label="Session events">
      ${events.length
        ? html`
            <ol class="session-detail-dock__event-list">
              ${events.map((event, index) => html`
                <li
                  id=${event.id ? `runtime-event-${event.id}` : undefined}
                  key=${event.id || event.eventId || index}
                  class="session-detail-dock__event"
                  data-event-type=${event.type || event.kind || "event"}
                >
                  <div class="session-detail-dock__event-main">
                    <strong>${event.type || event.kind || "event"}</strong>
                    ${event.ts ? html`<time datetime=${event.ts}>${event.ts}</time>` : null}
                  </div>
                  <div class="session-detail-dock__event-meta">
                    ${event.source ? html`<span>${event.source}</span>` : null}
                    ${event.id ? html`<span>${event.id}</span>` : null}
                    ${event.evidenceRef ? html`<span>${event.evidenceRef}</span>` : null}
                  </div>
                  ${event.summary || event.message || event.reason
                    ? html`<p>${event.summary || event.message || event.reason}</p>`
                    : null}
                </li>
              `)}
            </ol>
          `
        : html`<div class="session-detail-dock__empty-panel">No structured events</div>`}
    </section>
  `;
}

export function SessionDetailDockView({
  session = null,
  task = null,
  job = null,
  stdioEntries = [],
  timelineItems = [],
  activeTab = "timeline",
  visible = true,
  paused = false,
  follow = true,
  query = "",
  copied = false,
  chatDraft = "",
  queuedChatDrafts = [],
  chatError = "",
  capabilities = {},
  onSelectTab,
  onTogglePause,
  onToggleFollow,
  onSearch,
  onCopy,
  onDraftChange,
  onQueuedDraftsChange,
  onInterrupt,
  onSend,
  onForceKill,
  onSetRepoWorktree,
} = {}) {
  if (!session || typeof session !== "object") return null;
  const sessionId = nonEmptyString(session.id) || "session";
  const canForceKill = typeof onForceKill === "function";
  const showSetRepoWorktree = repoUnknown(session);
  const canSetRepoWorktree = typeof onSetRepoWorktree === "function";
  const selectedTab = normalizeActiveTab(activeTab);

  return html`
    <aside class="session-detail-dock" aria-label="Session detail" data-session-id=${sessionId}>
      <header class="session-detail-dock__header">
        <div class="session-detail-dock__identity">
          <span class="session-detail-dock__id">${sessionId}</span>
          <strong class="session-detail-dock__title">${sessionTitle(session)}</strong>
        </div>
        <div class="session-detail-dock__actions">
          ${showSetRepoWorktree
            ? html`
                <button
                  class="session-detail-dock__set-repo-worktree"
                  type="button"
                  disabled=${!canSetRepoWorktree}
                  onClick=${() => {
                    if (canSetRepoWorktree) {
                      onSetRepoWorktree({
                        sessionId,
                        session,
                        repoRoot: nonEmptyString(session.repoRoot),
                        worktreePath: nonEmptyString(session.worktreePath),
                      });
                    }
                  }}
                >
                  [SET REPO/WORKTREE]
                </button>
              `
            : null}
          <button
            class="session-detail-dock__force-kill"
            type="button"
            disabled=${!canForceKill}
            onClick=${() => {
              if (canForceKill) onForceKill({ sessionId, session, force: true });
            }}
          >
            [FORCE KILL]
          </button>
        </div>
      </header>

      <div class="session-detail-dock__meta">
        <span>${session.status || "unknown"}</span>
        ${session.tier ? html`<span>${session.tier}</span>` : null}
        <span>${repoLabel(session)}</span>
        ${session.activeJobId ? html`<span>${session.activeJobId}</span>` : null}
      </div>

      <nav class="session-detail-dock__tabs" aria-label="Session detail tabs">
        ${SESSION_DETAIL_TABS.map((tab) => html`
          <button
            key=${tab}
            class=${`session-detail-dock__tab ${tab === selectedTab ? "session-detail-dock__tab--active" : ""}`}
            type="button"
            aria-selected=${tab === selectedTab ? "true" : "false"}
            onClick=${() => {
              if (typeof onSelectTab === "function") onSelectTab(tab);
            }}
          >
            ${TAB_LABELS[tab]}
          </button>
        `)}
      </nav>

      <div class="session-detail-dock__panel" data-active-tab=${selectedTab}>
        ${selectedTab === "summary" ? html`<${SummaryPanel} session=${session} task=${task} job=${job} />` : null}
        ${selectedTab === "timeline" ? html`<${TimelinePanelView} items=${timelineItems} />` : null}
        ${selectedTab === "stdio"
          ? html`
              <${StdioPanelView}
                entries=${stdioEntries}
                visible=${visible}
                paused=${paused}
                follow=${follow}
                query=${query}
                copied=${copied}
                onTogglePause=${onTogglePause}
                onToggleFollow=${onToggleFollow}
                onSearch=${onSearch}
                onCopy=${onCopy}
              />
            `
          : null}
        ${selectedTab === "chat"
          ? html`
              <${ChatPanel}
                session=${session}
                draft=${chatDraft}
                queuedDrafts=${queuedChatDrafts}
                sendError=${chatError}
                capabilities=${capabilities}
                onDraftChange=${onDraftChange}
                onQueuedDraftsChange=${onQueuedDraftsChange}
                onInterrupt=${onInterrupt}
                onSend=${onSend}
              />
            `
          : null}
        ${selectedTab === "diff"
          ? html`
              <${DiffPanel}
                sessionId=${sessionId}
                baseRev=${job?.baseRev || session.baseRev}
                initialDiffReview=${session.diffReview || job?.diffReview || null}
              />
            `
          : null}
        ${selectedTab === "context"
          ? html`
              <${SessionContextTab}
                job=${job}
                verifyPack=${session.verifyPack || job?.verifyPack || null}
                completionGates=${session.completionGates || job?.completionGates || null}
              />
            `
          : null}
        ${selectedTab === "skills"
          ? html`
              <${SessionSkillsTab}
                job=${job}
                session=${session}
                skillPlan=${session.skillPlan || job?.skillPlan || null}
              />
            `
          : null}
        ${selectedTab === "events" ? html`<${EventsPanel} session=${session} capabilities=${capabilities} />` : null}
      </div>
    </aside>
  `;
}
