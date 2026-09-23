import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

export const DIFF_PANEL_TABS = Object.freeze([
  { id: "changedSince", label: "Changed since job start" },
  { id: "providerProposals", label: "Provider proposals" },
  { id: "gitDiff", label: "Git diff" },
  { id: "allowedPaths", label: "Allowed paths" },
  { id: "conflicts", label: "Conflicts" },
  { id: "reviewerNotes", label: "Reviewer notes" },
]);

export function buildDiffPanelUrl(sessionId, { baseRev } = {}) {
  const id = text(sessionId);
  if (!id) throw new Error("sessionId required");
  const params = new URLSearchParams();
  if (baseRev !== undefined && baseRev !== null && baseRev !== "") {
    const numericBaseRev = Number(baseRev);
    if (!Number.isInteger(numericBaseRev) || numericBaseRev < 0) {
      throw new Error("baseRev must be a non-negative integer");
    }
    params.set("baseRev", String(numericBaseRev));
  }
  const query = params.toString();
  return `/api/sessions/${encodeURIComponent(id)}/diff${query ? `?${query}` : ""}`;
}

export async function loadSessionDiff({ sessionId, baseRev, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation required");
  const res = await fetchImpl(buildDiffPanelUrl(sessionId, { baseRev }), { method: "GET" });
  const body = typeof res?.json === "function" ? await res.json() : null;
  if (!res?.ok || !body?.ok || !body?.diffReview) {
    const message = body?.error?.message || res?.statusText || "diff request failed";
    throw new Error(message);
  }
  return body.diffReview;
}

export async function createDiffReviewerDraft({
  diffReview,
  fetchImpl = globalThis.fetch,
  trustedLocalMode = {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation required");
  if (nativeProviderReviewAvailable(diffReview, trustedLocalMode)) {
    return createNativeProviderReview({ diffReview, fetchImpl });
  }
  const jobId = nonEmptyText(diffReview?.jobId);
  const projectSlug = nonEmptyText(diffReview?.projectSlug);
  const sessionId = nonEmptyText(diffReview?.sessionId);
  const taskId = nonEmptyText(diffReview?.taskId);
  if (!jobId) throw new Error("jobId is required");
  if (!projectSlug) throw new Error("projectSlug is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!taskId) throw new Error("taskId is required");
  const body = {
    source: "attach",
    mode: "attach_existing",
    projectSlug,
    attachExistingSessionId: sessionId,
    attachTaskId: taskId,
    runtime: "codex_app_server",
    providerId: "codex_app_server",
    profileId: "reviewer",
    sandbox: "workspace-write",
    claimMode: "join",
    refreshContext: true,
    contextPackKind: "changed_since",
    contextFromJobId: jobId,
    baseRev: integerOrNull(diffReview?.baseRev),
    currentRev: integerOrNull(diffReview?.currentRev),
  };
  return postJson("/api/run-session/draft", body, fetchImpl, { expectedOk: 201 });
}

async function createNativeProviderReview({ diffReview, fetchImpl }) {
  const sessionId = nonEmptyText(diffReview?.sessionId);
  const threadId = providerReviewThreadId(diffReview);
  if (!sessionId) throw new Error("sessionId is required");
  if (!threadId) throw new Error("threadId is required");
  const prompt = providerReviewPrompt(diffReview);
  const payload = await postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/provider/review`,
    {
      threadId,
      prompt,
      scope: {
        diffReviewId: nonEmptyText(diffReview?.id),
        projectSlug: nonEmptyText(diffReview?.projectSlug),
        taskId: nonEmptyText(diffReview?.taskId),
        jobId: nonEmptyText(diffReview?.jobId),
        baseRev: integerOrNull(diffReview?.baseRev),
        currentRev: integerOrNull(diffReview?.currentRev),
      },
    },
    fetchImpl,
  );
  return {
    ok: payload?.ok !== false,
    mode: "provider_review",
    sessionId,
    threadId,
    providerReview: payload,
  };
}

export async function runDiffVerify({
  diffReview,
  fetchImpl = globalThis.fetch,
  trustedLocalMode = {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation required");
  const jobId = nonEmptyText(diffReview?.jobId);
  if (!jobId) throw new Error("jobId is required");
  if (!verifyRunAllowedFromUi(trustedLocalMode)) {
    throw new Error("verify command run from UI is disabled");
  }
  const verifyPack = await getJson(`/api/jobs/${encodeURIComponent(jobId)}/verify-pack`, fetchImpl);
  const items = arrayOrEmpty(verifyPack.items)
    .filter((item) => item?.kind === "command" && nonEmptyText(item.id));
  const results = [];
  for (const item of items) {
    const result = await postJson(
      `/api/jobs/${encodeURIComponent(jobId)}/verify-pack/items/${encodeURIComponent(item.id)}/run`,
      { source: "ui" },
      fetchImpl,
    );
    results.push(result);
  }
  return {
    ok: results.every((result) => result?.ok !== false),
    mode: "verify_items_run",
    jobId,
    results,
  };
}

export async function markDiffCloseoutPending({ diffReview, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation required");
  const jobId = nonEmptyText(diffReview?.jobId);
  if (!jobId) throw new Error("jobId is required");
  return postJson(
    `/api/jobs/${encodeURIComponent(jobId)}/skill-runs`,
    {
      skillId: "lt.closeout_sweep",
      source: "ui",
      summary: "Diff review closeout pending",
      evidence: {
        diffReviewId: nonEmptyText(diffReview?.id),
        sessionId: nonEmptyText(diffReview?.sessionId),
        baseRev: integerOrNull(diffReview?.baseRev),
        currentRev: integerOrNull(diffReview?.currentRev),
      },
    },
    fetchImpl,
    { expectedOk: 201 },
  );
}

export function diffPanelTabCounts(diffReview) {
  const tabs = diffReview?.tabs || {};
  const files = arrayOrEmpty(diffReview?.files);
  const provider = tabs.providerProposals || {};
  const allowed = tabs.allowedPaths || {};
  const conflicts = tabs.conflicts || {};
  const reviewer = tabs.reviewerNotes || {};
  return {
    changedSince: countChangedSince(tabs.changedSince),
    providerProposals: arrayOrEmpty(provider.items).length + arrayOrEmpty(provider.unmatchedItems).length,
    gitDiff: files.length || arrayOrEmpty(tabs.gitDiff?.files).length,
    allowedPaths: arrayOrEmpty(allowed.warnings).length + arrayOrEmpty(allowed.details).length,
    conflicts: arrayOrEmpty(conflicts.details).length || arrayOrEmpty(conflicts.conflictIds).length,
    reviewerNotes: arrayOrEmpty(reviewer.notes).length,
  };
}

export function normalizeDiffPanelTab(tabId) {
  const id = text(tabId);
  return DIFF_PANEL_TABS.some((tab) => tab.id === id) ? id : DIFF_PANEL_TABS[0].id;
}

export function DiffPanel({
  sessionId,
  baseRev,
  initialDiffReview = null,
  fetchDiff = loadSessionDiff,
  fetchImpl = globalThis.fetch,
  trustedLocalMode = {},
  spawnReviewer = createDiffReviewerDraft,
  runVerify = runDiffVerify,
  markCloseoutPending = markDiffCloseoutPending,
} = {}) {
  const [activeTab, setActiveTab] = useState(DIFF_PANEL_TABS[0].id);
  const [diffReview, setDiffReview] = useState(initialDiffReview);
  const [loading, setLoading] = useState(!initialDiffReview);
  const [error, setError] = useState("");
  const [actionState, setActionState] = useState({ busyAction: null, error: "", message: "" });

  useEffect(() => {
    let alive = true;
    if (initialDiffReview) {
      setDiffReview(initialDiffReview);
      setLoading(false);
      setError("");
      return () => {
        alive = false;
      };
    }
    setLoading(true);
    setError("");
    Promise.resolve(fetchDiff({ sessionId, baseRev }))
      .then((nextReview) => {
        if (!alive) return;
        setDiffReview(nextReview);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || "diff request failed");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, baseRev, initialDiffReview, fetchDiff]);

  return html`
    <${DiffPanelView}
      diffReview=${diffReview}
      activeTab=${activeTab}
      loading=${loading}
      error=${error}
      onSelectTab=${setActiveTab}
      actionState=${actionState}
      trustedLocalMode=${trustedLocalMode}
      onSpawnReviewer=${() => runPanelAction({
        action: "spawnReviewer",
        setActionState,
        run: () => spawnReviewer({ diffReview, fetchImpl, trustedLocalMode }),
        successMessage: (result) => result?.mode === "provider_review"
          ? "Provider review started"
          : `Reviewer ${(result?.draft?.id || "draft")} created`,
      })}
      onRunVerify=${() => runPanelAction({
        action: "runVerify",
        setActionState,
        run: () => runVerify({ diffReview, fetchImpl, trustedLocalMode }),
        successMessage: (result) => `${arrayOrEmpty(result?.results).length} verify item${arrayOrEmpty(result?.results).length === 1 ? "" : "s"} run`,
      })}
      onMarkCloseoutPending=${() => runPanelAction({
        action: "markCloseoutPending",
        setActionState,
        run: () => markCloseoutPending({ diffReview, fetchImpl }),
        successMessage: () => "Closeout marked pending",
      })}
    />
  `;
}

export function DiffPanelView({
  diffReview,
  activeTab = DIFF_PANEL_TABS[0].id,
  loading = false,
  error = "",
  onSelectTab,
  actionState = {},
  onSpawnReviewer,
  onRunVerify,
  onMarkCloseoutPending,
  trustedLocalMode = {},
} = {}) {
  const selectedTab = normalizeDiffPanelTab(activeTab);
  const counts = diffPanelTabCounts(diffReview);
  const canRunActions = !!nonEmptyText(diffReview?.jobId);
  const canRunVerify = verifyRunAllowedFromUi(trustedLocalMode);
  const busyAction = nonEmptyText(actionState.busyAction);
  return html`
    <section class="diff-panel" role="region" aria-label="Diff review">
      <header class="diff-panel__head">
        <div class="diff-panel__identity">
          <strong class="diff-panel__title">Diff review</strong>
          <span class="diff-panel__meta">${diffPanelMeta(diffReview)}</span>
        </div>
        <div class="diff-panel__head-side">
          ${canRunActions
            ? html`
                <div class="diff-panel__actions" aria-label="Diff actions">
                  ${actionButton("Reviewer", "spawnReviewer", busyAction, loading, onSpawnReviewer)}
                  ${actionButton("Verify", "runVerify", busyAction, loading, onRunVerify, {
                    disabled: !canRunVerify,
                    title: canRunVerify ? "" : "Verify command run from UI is disabled",
                  })}
                  ${actionButton("Closeout", "markCloseoutPending", busyAction, loading, onMarkCloseoutPending)}
                </div>
              `
            : null}
          ${loading ? html`<span class="diff-panel__state" role="status">loading</span>` : null}
          ${error ? html`<span class="diff-panel__error" role="status">${error}</span>` : null}
          ${actionState?.error ? html`<span class="diff-panel__error" role="status">${actionState.error}</span>` : null}
          ${actionState?.message ? html`<span class="diff-panel__state" role="status">${actionState.message}</span>` : null}
        </div>
      </header>

      <div class="diff-panel__tabs" role="tablist" aria-label="Diff review tabs">
        ${DIFF_PANEL_TABS.map((tab) => html`
          <button
            key=${tab.id}
            class=${`diff-panel__tab ${selectedTab === tab.id ? "diff-panel__tab--active" : ""}`}
            type="button"
            role="tab"
            aria-selected=${selectedTab === tab.id ? "true" : "false"}
            onClick=${() => {
              if (typeof onSelectTab === "function") onSelectTab(tab.id);
            }}
          >
            <span>${tab.label}</span>
            <span class="diff-panel__tab-count">${counts[tab.id] || 0}</span>
          </button>
        `)}
      </div>

      <div class="diff-panel__body" role="tabpanel">
        ${renderTabPanel(selectedTab, diffReview)}
      </div>
    </section>
  `;
}

function renderTabPanel(tabId, diffReview) {
  if (!diffReview) return emptyBlock("No diff review loaded");
  const tabs = diffReview.tabs || {};
  if (tabId === "changedSince") return renderChangedSince(tabs.changedSince);
  if (tabId === "providerProposals") return renderProviderProposals(tabs.providerProposals);
  if (tabId === "gitDiff") return renderGitDiff(tabs.gitDiff, diffReview.files);
  if (tabId === "allowedPaths") return renderAllowedPaths(tabs.allowedPaths);
  if (tabId === "conflicts") return renderConflicts(tabs.conflicts);
  return renderReviewerNotes(tabs.reviewerNotes);
}

function actionButton(label, actionId, busyAction, loading, handler, options = {}) {
  const busy = busyAction === actionId;
  const disabled = loading || !!busyAction || options.disabled === true || typeof handler !== "function";
  return html`
    <button
      class="diff-panel__action"
      type="button"
      disabled=${disabled}
      aria-busy=${busy ? "true" : "false"}
      title=${text(options.title)}
      onClick=${disabled ? undefined : handler}
    >
      ${busy ? "Running" : label}
    </button>
  `;
}

async function runPanelAction({ action, setActionState, run, successMessage }) {
  if (typeof run !== "function") return;
  setActionState({ busyAction: action, error: "", message: "" });
  try {
    const result = await run();
    const message = typeof successMessage === "function" ? successMessage(result) : "";
    setActionState({ busyAction: null, error: "", message });
  } catch (err) {
    setActionState({ busyAction: null, error: err?.message || "diff action failed", message: "" });
  }
}

function renderChangedSince(tab) {
  const events = arrayOrEmpty(tab?.since?.events || tab?.events);
  const changed = arrayOrEmpty(tab?.changed?.changed || tab?.changed);
  if (!events.length && !changed.length) return emptyBlock("No tracker changes");
  return html`
    <ul class="diff-panel__rows" aria-label="Changed tracker events">
      ${changed.map((item, index) => html`
        <li key=${text(item.id) || index} class="diff-panel__row">
          <span class="diff-panel__chip">${text(item.id) || "task"}</span>
          <span class="diff-panel__row-main">${text(item.title) || text(item.status) || "tracker task"}</span>
          <span class="diff-panel__muted">${changedKeysLabel(item)}</span>
        </li>
      `)}
      ${events.map((event, index) => html`
        <li key=${`rev:${event.rev || index}`} class="diff-panel__row">
          <span class="diff-panel__chip">rev ${event.rev || "?"}</span>
          <span class="diff-panel__row-main">${eventSummary(event)}</span>
        </li>
      `)}
    </ul>
  `;
}

function renderProviderProposals(tab = {}) {
  const items = [...arrayOrEmpty(tab.items), ...arrayOrEmpty(tab.unmatchedItems)];
  if (!items.length) return emptyBlock("No provider file proposals");
  return html`
    <ul class="diff-panel__rows" aria-label="Provider proposals">
      ${items.map((item, index) => html`
        <li key=${text(item.evidenceRef) || text(item.proposalId) || index} class="diff-panel__row">
          <span class="diff-panel__chip">${text(item.providerId) || "provider"}</span>
          <span class="diff-panel__row-main">${text(item.path) || text(item.file) || text(item.proposalId) || "proposal"}</span>
          ${text(item.evidenceRef) ? evidenceLink(item.evidenceRef) : null}
        </li>
      `)}
    </ul>
  `;
}

function renderGitDiff(tab = {}, files = []) {
  const diffFiles = arrayOrEmpty(files).length ? files : arrayOrEmpty(tab.files);
  const patch = text(tab.patch) || text(tab.commands?.patch?.stdout);
  if (!diffFiles.length && !patch) return emptyBlock("No git diff files");
  return html`
    <div class="diff-panel__stack">
      ${diffFiles.length
        ? html`
            <ul class="diff-panel__rows" aria-label="Git diff files">
              ${diffFiles.map((file, index) => html`
                <li key=${text(file.path) || index} class="diff-panel__row">
                  <span class="diff-panel__chip">${text(file.status) || text(file.changeKind) || "changed"}</span>
                  <span class="diff-panel__row-main">${text(file.path) || text(file.filePath) || "file"}</span>
                  ${file.additions !== undefined || file.deletions !== undefined
                    ? html`<span class="diff-panel__muted">+${file.additions || 0} -${file.deletions || 0}</span>`
                    : null}
                </li>
              `)}
            </ul>
          `
        : null}
      ${patch
        ? html`
            <pre class="diff-panel__patch">${patch}</pre>
            ${tab.commands?.patch?.stdoutTruncated
              ? html`<span class="diff-panel__muted">patch output truncated</span>`
              : null}
          `
        : null}
    </div>
  `;
}

function renderAllowedPaths(tab = {}) {
  const details = [...arrayOrEmpty(tab.details), ...arrayOrEmpty(tab.warnings)];
  if (!details.length) return emptyBlock("No allowed-path warnings");
  return html`
    <ul class="diff-panel__rows" aria-label="Allowed path warnings">
      ${details.map((detail, index) => html`
        <li key=${text(detail.id) || text(detail.path) || index} class="diff-panel__row diff-panel__row--warning">
          <span class="diff-panel__chip">outside</span>
          <span class="diff-panel__row-main">${text(detail.path) || text(detail.filePath) || text(detail) || "path"}</span>
          ${text(detail.reason) ? html`<span class="diff-panel__muted">${detail.reason}</span>` : null}
        </li>
      `)}
    </ul>
  `;
}

function renderConflicts(tab = {}) {
  const details = arrayOrEmpty(tab.details);
  const ids = arrayOrEmpty(tab.conflictIds);
  if (!details.length && !ids.length) return emptyBlock("No conflicts");
  return html`
    <ul class="diff-panel__rows" aria-label="Diff conflicts">
      ${(details.length ? details : ids).map((item, index) => {
        const id = text(item.conflictId) || text(item.id) || text(item);
        return html`
          <li key=${id || index} class="diff-panel__row diff-panel__row--danger">
            <span class="diff-panel__chip">${id || "conflict"}</span>
            <span class="diff-panel__row-main">${text(item.path) || text(item.filePath) || text(item.summary) || "active conflict"}</span>
            ${text(item.evidenceRef) ? evidenceLink(item.evidenceRef) : null}
          </li>
        `;
      })}
    </ul>
  `;
}

function renderReviewerNotes(tab = {}) {
  const notes = arrayOrEmpty(tab.notes);
  if (!notes.length) return emptyBlock(text(tab.status) || "open");
  return html`
    <ul class="diff-panel__rows" aria-label="Reviewer notes">
      ${notes.map((note, index) => html`
        <li key=${text(note.id) || index} class="diff-panel__row">
          <span class="diff-panel__chip">${text(note.author) || text(note.status) || "note"}</span>
          <span class="diff-panel__row-main">${text(note.body) || text(note.text) || text(note)}</span>
        </li>
      `)}
    </ul>
  `;
}

function emptyBlock(message) {
  return html`<p class="diff-panel__empty">${message}</p>`;
}

function evidenceLink(evidenceRef) {
  return html`
    <a
      class="diff-panel__evidence"
      href=${`#runtime-event-${encodeURIComponent(evidenceRef)}`}
      data-evidence-ref=${evidenceRef}
    >
      ${evidenceRef}
    </a>
  `;
}

function diffPanelMeta(diffReview) {
  if (!diffReview) return "not loaded";
  const parts = [
    text(diffReview.projectSlug),
    text(diffReview.taskId),
    text(diffReview.jobId),
    Number.isInteger(diffReview.baseRev) ? `base ${diffReview.baseRev}` : "",
    Number.isInteger(diffReview.currentRev) ? `current ${diffReview.currentRev}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "diff";
}

function countChangedSince(tab) {
  const events = arrayOrEmpty(tab?.since?.events || tab?.events);
  if (events.length) return events.length;
  const changedTasks = tab?.changed?.changed || tab?.changed || tab?.tasksChanged || tab?.changedTasks || tab?.summary;
  return Array.isArray(changedTasks) ? changedTasks.length : 0;
}

function changedKeysLabel(item) {
  const keys = arrayOrEmpty(item.changedKeys).join(", ");
  const rev = Number.isInteger(item.lastChangedRev) ? `rev ${item.lastChangedRev}` : "";
  return [keys, rev].filter(Boolean).join(" · ") || "changed";
}

function eventSummary(event) {
  if (Array.isArray(event.summary)) {
    return event.summary
      .map((item) => text(item.id) || text(item.key) || text(item.kind))
      .filter(Boolean)
      .join(", ") || "tracker change";
  }
  return text(event.summary) || text(event.message) || "tracker change";
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, { method: "GET" });
  return parseJsonResponse(response);
}

async function postJson(url, body, fetchImpl, { expectedOk = 200 } = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await parseJsonResponse(response);
  if (Number.isInteger(expectedOk) && response?.status !== expectedOk) {
    throw new Error(apiErrorMessage(payload, response));
  }
  return payload;
}

async function parseJsonResponse(response) {
  const payload = typeof response?.json === "function" ? await response.json().catch(() => ({})) : {};
  if (!response?.ok) throw new Error(apiErrorMessage(payload, response));
  return payload;
}

function apiErrorMessage(payload, response) {
  return payload?.error?.message || payload?.error || response?.statusText || "request failed";
}

function verifyRunAllowedFromUi(trustedLocalMode) {
  return trustedLocalMode?.allowVerifyCommandRunFromUI === true ||
    trustedLocalMode?.allowVerifyCommandRunOnUserAction === true;
}

function providerReviewAllowedFromUi(trustedLocalMode) {
  return trustedLocalMode?.allowProviderReviewFromUI === true;
}

function nativeProviderReviewAvailable(diffReview, trustedLocalMode) {
  if (!providerReviewAllowedFromUi(trustedLocalMode)) return false;
  if (!nonEmptyText(diffReview?.sessionId)) return false;
  if (!providerReviewThreadId(diffReview)) return false;
  if (diffReview?.providerReview?.available === true) return true;
  return providerReviewCapabilities(diffReview).providerReview === true;
}

function providerReviewCapabilities(diffReview) {
  if (diffReview?.providerCapabilities && typeof diffReview.providerCapabilities === "object") {
    return diffReview.providerCapabilities;
  }
  if (diffReview?.capabilities && typeof diffReview.capabilities === "object") {
    return diffReview.capabilities;
  }
  return {};
}

function providerReviewThreadId(diffReview) {
  return nonEmptyText(diffReview?.providerThreadId) ||
    nonEmptyText(diffReview?.threadId) ||
    nonEmptyText(diffReview?.threadRef?.threadId) ||
    nonEmptyText(diffReview?.threadRef?.id) ||
    nonEmptyText(diffReview?.sessionThreadId);
}

function providerReviewPrompt(diffReview) {
  const parts = [
    "Review the changed-since diff for this tracked session.",
    `Project: ${nonEmptyText(diffReview?.projectSlug) || "unknown"}.`,
    `Task: ${nonEmptyText(diffReview?.taskId) || "unknown"}.`,
    `Session: ${nonEmptyText(diffReview?.sessionId) || "unknown"}.`,
  ];
  const jobId = nonEmptyText(diffReview?.jobId);
  if (jobId) parts.push(`Job: ${jobId}.`);
  if (Number.isInteger(diffReview?.baseRev) || Number.isInteger(diffReview?.currentRev)) {
    parts.push(`Tracker revisions: ${integerOrNull(diffReview?.baseRev) ?? "unknown"} to ${integerOrNull(diffReview?.currentRev) ?? "unknown"}.`);
  }
  return parts.join(" ");
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function nonEmptyText(value) {
  const out = text(value);
  return out || null;
}
