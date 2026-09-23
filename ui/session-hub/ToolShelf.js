import { html } from "htm/preact";

export const TOOL_SHELF_GROUPS = Object.freeze([
  {
    id: "task",
    label: "Task tools",
    actions: [
      ["read", "READ"],
      ["why", "WHY"],
      ["exec", "EXEC"],
      ["verify", "VERIFY"],
      ["handoff", "HANDOFF"],
      ["run", "RUN"],
    ],
  },
  {
    id: "session",
    label: "Session tools",
    actions: [
      ["chat", "CHAT"],
      ["stdio", "STDIO"],
      ["ping", "PING"],
      ["stop", "STOP"],
      ["resume", "RESUME"],
      ["rollover", "ROLLOVER"],
      ["archive", "ARCHIVE"],
    ],
  },
  {
    id: "job",
    label: "Job tools",
    actions: [
      ["context", "CONTEXT"],
      ["skills", "SKILLS"],
      ["checkpoint", "CHECKPOINT"],
      ["blocked", "BLOCKED"],
      ["verify", "VERIFY"],
      ["closeout", "CLOSEOUT"],
      ["complete", "COMPLETE"],
    ],
  },
  {
    id: "repo",
    label: "Repo tools",
    actions: [
      ["diff", "DIFF"],
      ["status", "STATUS"],
      ["files", "FILES"],
      ["worktree", "WORKTREE"],
      ["conflicts", "CONFLICTS"],
    ],
  },
  {
    id: "review",
    label: "Review tools",
    actions: [
      ["spawn_reviewer", "SPAWN REVIEWER"],
      ["changed_since", "CHANGED SINCE"],
      ["closeout", "CLOSEOUT"],
    ],
  },
]);

const LOW_CAPABILITY_TIERS = new Set(["dumb_terminal", "manual", "mcp_tracked"]);
const RAW_STDIO_TIERS = new Set(["dumb_terminal", "hybrid"]);
const UNWIRED_ACTIONS = new Set([
  "task:handoff",
  "session:ping",
  "session:stop",
  "session:resume",
  "session:rollover",
  "session:archive",
  "job:checkpoint",
  "job:blocked",
  "job:verify",
  "job:closeout",
  "repo:status",
  "repo:files",
  "repo:conflicts",
  "review:changed_since",
  "review:closeout",
]);

function hasText(value) {
  return typeof value === "string" && value.length > 0;
}

function truthyCapability(capabilities, key, fallback = false) {
  if (!capabilities || typeof capabilities !== "object") return fallback;
  return capabilities[key] === undefined ? fallback : capabilities[key] === true;
}

function hasCapability(capabilities, key) {
  return truthyCapability(capabilities, key, false);
}

function combinedCapabilities(session, capabilities) {
  return {
    ...(session?.providerCapabilities && typeof session.providerCapabilities === "object" ? session.providerCapabilities : {}),
    ...(session?.capabilities && typeof session.capabilities === "object" ? session.capabilities : {}),
    ...(capabilities && typeof capabilities === "object" ? capabilities : {}),
  };
}

function providerIdForSession(session) {
  if (!session || typeof session !== "object") return "";
  if (typeof session.providerId === "string" && session.providerId.length > 0) return session.providerId;
  if (typeof session.provider === "string" && session.provider.length > 0) return session.provider;
  if (
    session.threadRef &&
    typeof session.threadRef === "object" &&
    !Array.isArray(session.threadRef) &&
    typeof session.threadRef.providerId === "string" &&
    session.threadRef.providerId.length > 0
  ) {
    return session.threadRef.providerId;
  }
  if (
    session.providerThread &&
    typeof session.providerThread === "object" &&
    !Array.isArray(session.providerThread) &&
    typeof session.providerThread.providerId === "string" &&
    session.providerThread.providerId.length > 0
  ) {
    return session.providerThread.providerId;
  }
  return "";
}

function threadRefForSession(session) {
  if (!session || typeof session !== "object") return null;
  const rawRef =
    session.threadRef && typeof session.threadRef === "object" && !Array.isArray(session.threadRef)
      ? session.threadRef
      : session.providerThread && typeof session.providerThread === "object" && !Array.isArray(session.providerThread)
        ? session.providerThread
        : {};
  const threadId =
    (typeof rawRef.threadId === "string" && rawRef.threadId.length > 0 ? rawRef.threadId : "") ||
    (typeof rawRef.id === "string" && rawRef.id.length > 0 ? rawRef.id : "") ||
    (typeof session.threadId === "string" && session.threadId.length > 0 ? session.threadId : "") ||
    (typeof session.providerThreadId === "string" && session.providerThreadId.length > 0 ? session.providerThreadId : "");
  return threadId ? { ...rawRef, threadId } : null;
}

function readRawStdioCapability(session, capabilities) {
  const candidates = [
    capabilities,
    session?.capabilities,
    session?.providerCapabilities,
    session?.provider?.capabilities,
    session?.stdio,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && typeof candidate.rawStdio === "boolean") {
      return candidate.rawStdio;
    }
  }
  return null;
}

function hasRawStdio(session, capabilities) {
  const explicit = readRawStdioCapability(session, capabilities);
  if (explicit !== null) return explicit;
  if (session?.stdioAvailable === true) return true;
  return RAW_STDIO_TIERS.has(session?.tier);
}

function isLowCapabilitySession(session, capabilities) {
  if (!session || typeof session !== "object") return false;
  if (capabilities?.structured === false) return true;
  return LOW_CAPABILITY_TIERS.has(session.tier);
}

function disabledReason(groupId, actionId, context) {
  const { task, session, job, repo } = context;
  const capabilities = combinedCapabilities(session, context.capabilities);
  if (UNWIRED_ACTIONS.has(`${groupId}:${actionId}`)) return "not wired in live UI";
  if (groupId === "task" && !hasText(task?.id)) return "select a task";
  if (groupId === "session" && !hasText(session?.id)) return "select a session";
  if (groupId === "job" && !hasText(job?.id) && !hasText(session?.activeJobId)) return "select a job";
  if (groupId === "repo" && !hasText(repo?.root) && !hasText(session?.repoRoot)) return "repo unknown";
  if (groupId === "review" && !hasCapability(capabilities, "review")) return "missing review capability";
  if (
    groupId === "session" &&
    actionId === "chat" &&
    !hasCapability(capabilities, "structuredChat") &&
    !hasCapability(capabilities, "turnSteer") &&
    !hasCapability(capabilities, "stdinWrite")
  ) {
    return "missing chat capability";
  }
  if (groupId === "session" && actionId === "chat" && !providerIdForSession(session)) {
    return "provider id required for chat";
  }
  if (groupId === "session" && actionId === "chat" && !threadRefForSession(session)) {
    return "provider thread required for chat";
  }
  if (
    groupId === "session" &&
    actionId === "stdio" &&
    (session?.stdioAvailable === false || !hasRawStdio(session, capabilities))
  ) {
    return "missing raw stdio capability";
  }
  if (groupId === "repo" && actionId === "worktree" && !hasCapability(capabilities, "worktree")) {
    return "missing worktree capability";
  }
  return "";
}

function isCapabilityDisabledReason(reason) {
  return reason.startsWith("missing ") && reason.endsWith(" capability");
}

function makeAction(group, action, context) {
  const [id, label] = action;
  const reason = disabledReason(group.id, id, context);
  return {
    id,
    label,
    groupId: group.id,
    disabled: reason.length > 0,
    reason,
    capabilityDegraded: isCapabilityDisabledReason(reason),
  };
}

export function toolShelfModel(context = {}) {
  const capabilities = combinedCapabilities(context.session, context.capabilities);
  const normalizedContext = { ...context, capabilities };
  const groups = TOOL_SHELF_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    actions: group.actions.map((action) => makeAction(group, action, normalizedContext)),
  }));

  const capabilityDegraded = groups.some((group) =>
    group.actions.some((action) => action.capabilityDegraded)
  );
  if (isLowCapabilitySession(context.session, capabilities) || capabilityDegraded) {
    const sessionGroup = groups.find((group) => group.id === "session");
    sessionGroup.actions.push({
      id: "mcp_contract",
      label: "MCP CONTRACT",
      groupId: "session",
      disabled: false,
      reason: "MCP contract fallback",
      fallback: true,
    });
  }

  return groups;
}

export function ToolShelf({
  task = null,
  session = null,
  job = null,
  repo = null,
  capabilities = {},
  onAction,
} = {}) {
  const groups = toolShelfModel({ task, session, job, repo, capabilities });
  const handleClick = (group, action) => {
    if (action.disabled || typeof onAction !== "function") return;
    onAction({ groupId: group.id, actionId: action.id, task, session, job, repo });
  };

  return html`
    <section class="tool-shelf" role="region" aria-label="Tool shelf">
      ${groups.map((group) => html`
        <div key=${group.id} class="tool-shelf__group" data-tool-group=${group.id}>
          <h3 class="tool-shelf__group-title">${group.label}</h3>
          <div class="tool-shelf__actions">
            ${group.actions.map((action) => html`
              <button
                key=${action.id}
                class=${`tool-shelf__action${action.fallback ? " tool-shelf__action--fallback" : ""}`}
                type="button"
                disabled=${action.disabled}
                title=${action.reason || action.label}
                aria-label=${action.reason ? `${action.label}: ${action.reason}` : action.label}
                data-action=${action.id}
                data-disabled-reason=${action.reason}
                onClick=${() => handleClick(group, action)}
              >
                <span class="tool-shelf__action-label">${action.label}</span>
                ${action.disabled && action.reason
                  ? html`<span class="tool-shelf__action-reason">${action.reason}</span>`
                  : null}
              </button>
            `)}
          </div>
        </div>
      `)}
    </section>
  `;
}
