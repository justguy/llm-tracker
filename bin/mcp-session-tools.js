import { runHubMutation, nonEmptyString, makeTextResult } from "./mcp-utils.js";
import {
  mcpSessionTokenHeaders,
  mcpSessionTokenProperty,
  requireMcpSessionToken
} from "../hub/sessions/auth/mcp-token.js";

const SESSION_ID_RE = /^ses_[0-9a-hjkmnp-tv-z]{26}$/;
const SESSION_STATUSES = new Set([
  "starting",
  "active",
  "quiet",
  "idle",
  "waiting_for_human",
  "waiting_for_approval",
  "blocked",
  "context_high",
  "done",
  "stopping",
  "stopped",
  "resuming",
  "rolled_over",
  "archived",
  "unknown"
]);
const ATTACH_CLAIM_MODES = new Set(["fail_if_active", "join", "force"]);

function sessionIdProperty(description = "Runtime session id") {
  return { type: "string", description };
}

function optionalStringProperty(description) {
  return { type: "string", description };
}

function requireSessionId(args, toolName, key = "sessionId") {
  const sessionId = nonEmptyString(args[key]);
  if (!sessionId) return { error: `${toolName} requires ${key}.` };
  if (!SESSION_ID_RE.test(sessionId)) {
    return { error: `${toolName} requires a canonical ses_ session id.` };
  }
  return { sessionId };
}

function compactText(parts) {
  return parts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" | ");
}

function progressText(progress) {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return "";
  const bits = [];
  if (typeof progress.phase === "string" && progress.phase.length > 0) bits.push(`phase=${progress.phase}`);
  if (Number.isFinite(progress.percent)) bits.push(`percent=${progress.percent}`);
  if (typeof progress.source === "string" && progress.source.length > 0) bits.push(`source=${progress.source}`);
  return bits.length ? `progress: ${bits.join(", ")}` : "";
}

function contextUsageText(args) {
  const bits = [];
  if (Number.isFinite(args.percent)) bits.push(`percent=${args.percent}`);
  if (Number.isFinite(args.used)) bits.push(`used=${args.used}`);
  if (Number.isFinite(args.limit)) bits.push(`limit=${args.limit}`);
  bits.push("source=mcp");
  return bits.length ? `context_usage: ${bits.join(", ")}` : "context_usage reported";
}

function addOptionalString(body, args, field) {
  const value = nonEmptyString(args[field]);
  if (value) body[field] = value;
}

function addOptionalNumber(body, args, field, toolName) {
  if (args[field] === undefined) return null;
  if (!Number.isFinite(args[field])) return { error: `${toolName} requires ${field} to be a number when present.` };
  body[field] = args[field];
  return null;
}

function createSessionTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    handler: async (args = {}) => {
      const prepared = definition.prepareRequest(args);
      if (prepared?.error) return makeTextResult(prepared.error, { isError: true });
      return runHubMutation(prepared);
    }
  };
}

function createStatusMutation(
  workspace,
  portFlag,
  name,
  description,
  statusFactory,
  commentFactory,
  extraProperties = {},
  bodyFactory = null
) {
  return createSessionTool({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        sessionId: sessionIdProperty(),
        sessionToken: mcpSessionTokenProperty,
        ...extraProperties
      },
      required: ["sessionId", "sessionToken"]
    },
    prepareRequest(args = {}) {
      const id = requireSessionId(args, name);
      if (id.error) return id;
      const token = requireMcpSessionToken(args, name);
      if (token.error) return token;
      const status = statusFactory(args);
      if (!SESSION_STATUSES.has(status)) {
        return { error: `${name} requires status to be one of: ${[...SESSION_STATUSES].join(", ")}.` };
      }
      const comment = commentFactory ? nonEmptyString(commentFactory(args)) : null;
      return {
        workspace,
        portFlag,
        method: "PATCH",
        path: `/api/sessions/${id.sessionId}`,
        label: name,
        body: {
          status,
          ...(comment ? { comment } : {}),
          ...(typeof bodyFactory === "function" ? bodyFactory(args) : {})
        },
        headers: mcpSessionTokenHeaders(token.sessionToken),
        jsonRpcErrorOnFailure: true
      };
    }
  });
}

export function createSessionTools(workspace, portFlag) {
  return [
    createSessionTool({
      name: "tracker_session_start",
      description: "Create a runtime session through the running hub. This is the bootstrap call that returns the cleartext session token once; later mutating MCP calls must pass that token as sessionToken.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Session display name" },
          tier: {
            type: "string",
            enum: ["dumb_terminal", "mcp_tracked", "codex_app_server", "hybrid", "manual"],
            description: "Session capability tier"
          },
          projectSlug: optionalStringProperty("Optional project slug"),
          taskId: optionalStringProperty("Optional tracker task id"),
          agent: optionalStringProperty("Optional agent id"),
          provider: optionalStringProperty("Optional provider id"),
          model: optionalStringProperty("Optional model name"),
          cwd: optionalStringProperty("Optional working directory"),
          repoRoot: optionalStringProperty("Optional repository root"),
          worktreePath: optionalStringProperty("Optional worktree path"),
          branch: optionalStringProperty("Optional branch name")
        },
        required: ["name", "tier"]
      },
      prepareRequest(args = {}) {
        const name = nonEmptyString(args.name);
        const tier = nonEmptyString(args.tier);
        if (!name) return { error: "tracker_session_start requires name." };
        if (!tier) return { error: "tracker_session_start requires tier." };
        const body = { name, tier };
        for (const field of ["projectSlug", "taskId", "agent", "provider", "model", "cwd", "repoRoot", "worktreePath", "branch"]) {
          const value = nonEmptyString(args[field]);
          if (value) body[field] = value;
        }
        return {
          workspace,
          portFlag,
          method: "POST",
          path: "/api/sessions",
          label: "tracker_session_start",
          body
        };
      }
    }),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_heartbeat",
      "Report an MCP session heartbeat through the running hub.",
      (args) => nonEmptyString(args.status) || "active",
      (args) => compactText([nonEmptyString(args.note), progressText(args.progress)]),
      {
        status: { type: "string", enum: [...SESSION_STATUSES], description: "Optional activity state; defaults to active" },
        note: optionalStringProperty("Optional heartbeat note"),
        jobId: optionalStringProperty("Optional active job id"),
        progress: { type: "object", description: "Optional progress summary", additionalProperties: true }
      }
    ),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_status",
      "Set a runtime session ActivityState through the running hub.",
      (args) => nonEmptyString(args.status),
      (args) => nonEmptyString(args.note) || nonEmptyString(args.comment),
      {
        status: { type: "string", enum: [...SESSION_STATUSES], description: "ActivityState" },
        note: optionalStringProperty("Optional status note"),
        comment: optionalStringProperty("Optional status comment")
      }
    ),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_note",
      "Attach a note to the session runtime log while keeping the session active.",
      () => "active",
      (args) => nonEmptyString(args.note),
      {
        note: optionalStringProperty("Session note")
      }
    ),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_blocked",
      "Report a blocked session state.",
      () => "blocked",
      (args) => nonEmptyString(args.reason) || nonEmptyString(args.note),
      {
        reason: optionalStringProperty("Blocker reason"),
        note: optionalStringProperty("Optional blocker note")
      }
    ),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_unblocked",
      "Report a previously blocked session as active again.",
      () => "active",
      (args) => nonEmptyString(args.reason) || nonEmptyString(args.note),
      {
        reason: optionalStringProperty("Unblock reason"),
        note: optionalStringProperty("Optional unblock note")
      }
    ),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_handoff",
      "Record a final handoff note for a session before stopping or rollover.",
      () => "stopping",
      (args) => compactText([
        nonEmptyString(args.summary),
        nonEmptyString(args.facts),
        nonEmptyString(args.evidence),
        nonEmptyString(args.risks),
        nonEmptyString(args.nextAsk)
      ]),
      {
        summary: optionalStringProperty("Handoff summary"),
        facts: optionalStringProperty("Facts to carry forward"),
        evidence: optionalStringProperty("Verification or evidence summary"),
        risks: optionalStringProperty("Known risks"),
        nextAsk: optionalStringProperty("Recommended next action")
      }
    ),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_context_usage",
      "Report structured context usage for a session.",
      () => "active",
      contextUsageText,
      {
        percent: { type: "number", description: "Context usage percent" },
        used: { type: "number", description: "Optional used context units" },
        limit: { type: "number", description: "Optional maximum context units" },
        source: optionalStringProperty("Optional legacy field; recorded source is always mcp")
      },
      (args = {}) => {
        const contextUsage = {};
        if (Number.isFinite(args.percent)) contextUsage.percent = args.percent;
        if (Number.isFinite(args.used)) contextUsage.used = args.used;
        if (Number.isFinite(args.limit)) contextUsage.limit = args.limit;
        contextUsage.source = "mcp";
        return { contextUsage };
      }
    ),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_complete",
      "Mark a session done through the running hub.",
      () => "done",
      (args) => nonEmptyString(args.summary) || nonEmptyString(args.note),
      {
        summary: optionalStringProperty("Completion summary"),
        note: optionalStringProperty("Optional completion note")
      }
    ),
    createSessionTool({
      name: "tracker_session_list",
      description: "List runtime sessions from the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          sessionToken: mcpSessionTokenProperty
        }
      },
      prepareRequest(args = {}) {
        return {
          workspace,
          portFlag,
          method: "GET",
          path: "/api/sessions",
          label: "tracker_session_list",
          headers: mcpSessionTokenHeaders(args.sessionToken)
        };
      }
    }),
    createSessionTool({
      name: "tracker_session_context",
      description: "Fetch one runtime session context record from the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          sessionToken: mcpSessionTokenProperty
        },
        required: ["sessionId"]
      },
      prepareRequest(args = {}) {
        const id = requireSessionId(args, "tracker_session_context");
        if (id.error) return id;
        return {
          workspace,
          portFlag,
          method: "GET",
          path: `/api/sessions/${id.sessionId}`,
          label: "tracker_session_context",
          headers: mcpSessionTokenHeaders(args.sessionToken)
        };
      }
    }),
    createStatusMutation(
      workspace,
      portFlag,
      "tracker_session_broadcast",
      "Record a broadcast-style session update through the running hub.",
      () => "active",
      (args) => nonEmptyString(args.message),
      {
        message: optionalStringProperty("Broadcast message")
      }
    ),
    createSessionTool({
      name: "tracker_session_attach_task",
      description: "Attach or queue a tracker task on a runtime session through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty(),
          sessionToken: mcpSessionTokenProperty,
          taskId: { type: "string", description: "Tracker task id to attach" },
          projectSlug: optionalStringProperty("Optional project slug"),
          profileId: optionalStringProperty("Optional job profile id"),
          estBriefTokens: { type: "number", description: "Optional estimated brief token count" },
          contextBriefTokens: { type: "number", description: "Optional context brief token count" },
          contextBudget: {
            type: "object",
            description: "Optional context budget used by attach preflight",
            additionalProperties: true
          },
          claimMode: {
            type: "string",
            enum: [...ATTACH_CLAIM_MODES],
            description: "Optional claim behavior"
          },
          force: { type: "boolean", description: "Optional force flag" },
          idempotencyKey: optionalStringProperty("Optional retry idempotency key")
        },
        required: ["sessionId", "sessionToken", "taskId"]
      },
      prepareRequest(args = {}) {
        const id = requireSessionId(args, "tracker_session_attach_task");
        if (id.error) return id;
        const token = requireMcpSessionToken(args, "tracker_session_attach_task");
        if (token.error) return token;
        const taskId = nonEmptyString(args.taskId);
        if (!taskId) return { error: "tracker_session_attach_task requires taskId." };

        const body = { taskId };
        for (const field of ["projectSlug", "profileId", "idempotencyKey"]) {
          addOptionalString(body, args, field);
        }
        for (const field of ["estBriefTokens", "contextBriefTokens"]) {
          const numberError = addOptionalNumber(body, args, field, "tracker_session_attach_task");
          if (numberError) return numberError;
        }
        if (args.contextBudget !== undefined) {
          if (!args.contextBudget || typeof args.contextBudget !== "object" || Array.isArray(args.contextBudget)) {
            return { error: "tracker_session_attach_task requires contextBudget to be a JSON object when present." };
          }
          body.contextBudget = args.contextBudget;
        }
        const claimMode = nonEmptyString(args.claimMode);
        if (claimMode) {
          if (!ATTACH_CLAIM_MODES.has(claimMode)) {
            return { error: `tracker_session_attach_task requires claimMode to be one of: ${[...ATTACH_CLAIM_MODES].join(", ")}.` };
          }
          body.claimMode = claimMode;
        }
        if (args.force !== undefined) {
          if (typeof args.force !== "boolean") {
            return { error: "tracker_session_attach_task requires force to be a boolean when present." };
          }
          body.force = args.force;
        }

        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/sessions/${id.sessionId}/attach-task`,
          label: "tracker_session_attach_task",
          body,
          headers: mcpSessionTokenHeaders(token.sessionToken),
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createSessionTool({
      name: "tracker_session_ask",
      description: "Ask another runtime session a targeted question through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: sessionIdProperty("Sender runtime session id"),
          sessionToken: mcpSessionTokenProperty,
          targetSessionId: sessionIdProperty("Target runtime session id"),
          prompt: { type: "string", description: "Question or prompt for the target session" },
          idempotencyKey: optionalStringProperty("Optional retry idempotency key")
        },
        required: ["sessionId", "sessionToken", "targetSessionId", "prompt"]
      },
      prepareRequest(args = {}) {
        const sender = requireSessionId(args, "tracker_session_ask", "sessionId");
        if (sender.error) return sender;
        const target = requireSessionId(args, "tracker_session_ask", "targetSessionId");
        if (target.error) return target;
        const token = requireMcpSessionToken(args, "tracker_session_ask");
        if (token.error) return token;
        const prompt = nonEmptyString(args.prompt);
        if (!prompt) return { error: "tracker_session_ask requires prompt." };
        const idempotencyKey = nonEmptyString(args.idempotencyKey);
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/sessions/${sender.sessionId}/ask`,
          label: "tracker_session_ask",
          body: {
            targetSessionId: target.sessionId,
            prompt,
            ...(idempotencyKey ? { idempotencyKey } : {})
          },
          headers: mcpSessionTokenHeaders(token.sessionToken),
          jsonRpcErrorOnFailure: true
        };
      }
    })
  ];
}
