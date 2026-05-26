import { runHubMutation, nonEmptyString, makeTextResult } from "./mcp-utils.js";
import {
  mcpSessionTokenHeaders,
  mcpSessionTokenProperty,
  requireMcpSessionToken
} from "../hub/sessions/auth/mcp-token.js";

const JOB_ID_RE = /^job_[0-9a-hjkmnp-tv-z]{26}$/;
const SESSION_ID_RE = /^ses_[0-9a-hjkmnp-tv-z]{26}$/;

const JOB_STATUSES = new Set(["queued", "starting", "running", "blocked", "verifying"]);
const JOB_KINDS = new Set(["code", "prd", "review", "planning", "closeout", "custom"]);
const CONTEXT_PACK_KINDS = new Set(["start", "resume", "rollover", "verify", "handoff"]);
const UI_COMPLETE_MODES = new Set(["block_required_missing", "allow_optional_missing"]);
const VERIFY_RESOLVE_STATUSES = new Set(["satisfied", "failed"]);

function optionalStringProperty(description) {
  return { type: "string", description };
}

function requireJobId(args, toolName) {
  const jobId = nonEmptyString(args.jobId);
  if (!jobId) return { error: `${toolName} requires jobId.` };
  if (!JOB_ID_RE.test(jobId)) return { error: `${toolName} requires a canonical job_ id.` };
  return { jobId };
}

function requireSessionId(args, toolName) {
  const sessionId = nonEmptyString(args.sessionId);
  if (!sessionId) return { error: `${toolName} requires sessionId.` };
  if (!SESSION_ID_RE.test(sessionId)) return { error: `${toolName} requires a canonical ses_ session id.` };
  return { sessionId };
}

function encodePathPart(value) {
  return encodeURIComponent(value);
}

function createJobTool(definition) {
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

function addOptionalString(body, args, key) {
  const value = nonEmptyString(args[key]);
  if (value) body[key] = value;
}

function requireVerifyItemId(args, toolName) {
  const itemId = nonEmptyString(args.itemId);
  if (!itemId) return { error: `${toolName} requires itemId.` };
  return { itemId };
}

function prepareJobMutation(args, toolName, bodyFields) {
  const id = requireJobId(args, toolName);
  if (id.error) return id;
  const token = requireMcpSessionToken(args, toolName);
  if (token.error) return token;

  const body = {};
  for (const field of bodyFields) addOptionalString(body, args, field);
  return {
    jobId: id.jobId,
    body,
    headers: mcpSessionTokenHeaders(token.sessionToken)
  };
}

export function createJobTools(workspace, portFlag) {
  return [
    createJobTool({
      name: "tracker_job_start",
      description: "Start a JobRecord for a project task through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          projectSlug: { type: "string", description: "Project slug" },
          taskId: { type: "string", description: "Tracker task id" },
          sessionId: { type: "string", description: "Runtime session id" },
          sessionToken: mcpSessionTokenProperty,
          profileId: { type: "string", description: "Job profile id" },
          kind: { type: "string", enum: [...JOB_KINDS], description: "Job kind" },
          predecessorJobId: optionalStringProperty("Optional predecessor job id"),
          idempotencyKey: optionalStringProperty("Optional idempotency key")
        },
        required: ["projectSlug", "taskId", "sessionId", "sessionToken", "profileId", "kind"]
      },
      prepareRequest(args = {}) {
        const projectSlug = nonEmptyString(args.projectSlug);
        const taskId = nonEmptyString(args.taskId);
        const session = requireSessionId(args, "tracker_job_start");
        if (session.error) return session;
        const token = requireMcpSessionToken(args, "tracker_job_start");
        if (token.error) return token;
        const profileId = nonEmptyString(args.profileId);
        const kind = nonEmptyString(args.kind);
        if (!projectSlug) return { error: "tracker_job_start requires projectSlug." };
        if (!taskId) return { error: "tracker_job_start requires taskId." };
        if (!profileId) return { error: "tracker_job_start requires profileId." };
        if (!kind || !JOB_KINDS.has(kind)) {
          return { error: `tracker_job_start requires kind to be one of: ${[...JOB_KINDS].join(", ")}.` };
        }
        const body = { sessionId: session.sessionId, profileId, kind };
        const predecessorJobId = nonEmptyString(args.predecessorJobId);
        if (predecessorJobId) {
          if (!JOB_ID_RE.test(predecessorJobId)) {
            return { error: "tracker_job_start requires predecessorJobId to be a canonical job_ id." };
          }
          body.predecessorJobId = predecessorJobId;
        }
        addOptionalString(body, args, "idempotencyKey");
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/projects/${encodePathPart(projectSlug)}/tasks/${encodePathPart(taskId)}/jobs`,
          label: "tracker_job_start",
          body,
          headers: mcpSessionTokenHeaders(token.sessionToken),
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createJobTool({
      name: "tracker_job_status",
      description: "Fetch a JobRecord from the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" }
        },
        required: ["jobId"]
      },
      prepareRequest(args = {}) {
        const id = requireJobId(args, "tracker_job_status");
        if (id.error) return id;
        return {
          workspace,
          portFlag,
          method: "GET",
          path: `/api/jobs/${id.jobId}`,
          label: "tracker_job_status"
        };
      }
    }),
    createJobTool({
      name: "tracker_job_checkpoint",
      description: "Record a non-terminal job checkpoint through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          sessionToken: mcpSessionTokenProperty,
          status: { type: "string", enum: [...JOB_STATUSES], description: "Optional non-terminal job status" },
          summary: optionalStringProperty("Optional checkpoint summary"),
          idempotencyKey: optionalStringProperty("Optional idempotency key")
        },
        required: ["jobId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const prepared = prepareJobMutation(args, "tracker_job_checkpoint", ["summary", "idempotencyKey"]);
        if (prepared.error) return prepared;
        const status = nonEmptyString(args.status);
        if (status) {
          if (!JOB_STATUSES.has(status)) {
            return { error: `tracker_job_checkpoint requires status to be one of: ${[...JOB_STATUSES].join(", ")}.` };
          }
          prepared.body.status = status;
        }
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/jobs/${prepared.jobId}/checkpoint`,
          label: "tracker_job_checkpoint",
          body: prepared.body,
          headers: prepared.headers,
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createJobTool({
      name: "tracker_job_complete",
      description: "Complete a job through the gate-aware running hub endpoint. Missing required gates return the normal gates_pending union.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          sessionToken: mcpSessionTokenProperty,
          summary: optionalStringProperty("Optional completion summary"),
          idempotencyKey: optionalStringProperty("Optional idempotency key"),
          uiCompleteMode: {
            type: "string",
            enum: [...UI_COMPLETE_MODES],
            description: "Optional UI completion mode"
          }
        },
        required: ["jobId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const prepared = prepareJobMutation(args, "tracker_job_complete", ["summary", "idempotencyKey"]);
        if (prepared.error) return prepared;
        const uiCompleteMode = nonEmptyString(args.uiCompleteMode);
        if (uiCompleteMode) {
          if (!UI_COMPLETE_MODES.has(uiCompleteMode)) {
            return { error: `tracker_job_complete requires uiCompleteMode to be one of: ${[...UI_COMPLETE_MODES].join(", ")}.` };
          }
          prepared.body.uiCompleteMode = uiCompleteMode;
        }
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/jobs/${prepared.jobId}/complete`,
          label: "tracker_job_complete",
          body: prepared.body,
          headers: prepared.headers,
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createJobTool({
      name: "tracker_job_rollover",
      description: "Request job rollover through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          sessionToken: mcpSessionTokenProperty,
          reason: optionalStringProperty("Optional rollover reason"),
          idempotencyKey: optionalStringProperty("Optional idempotency key")
        },
        required: ["jobId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const prepared = prepareJobMutation(args, "tracker_job_rollover", ["reason", "idempotencyKey"]);
        if (prepared.error) return prepared;
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/jobs/${prepared.jobId}/rollover`,
          label: "tracker_job_rollover",
          body: prepared.body,
          headers: prepared.headers,
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createJobTool({
      name: "tracker_job_unblock",
      description: "Unblock a blocked job through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          sessionToken: mcpSessionTokenProperty,
          reason: optionalStringProperty("Optional unblock reason"),
          idempotencyKey: optionalStringProperty("Optional idempotency key")
        },
        required: ["jobId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const prepared = prepareJobMutation(args, "tracker_job_unblock", ["reason", "idempotencyKey"]);
        if (prepared.error) return prepared;
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/jobs/${prepared.jobId}/unblock`,
          label: "tracker_job_unblock",
          body: prepared.body,
          headers: prepared.headers,
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createJobTool({
      name: "tracker_job_context_pack",
      description: "Fetch a job context-pack from the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          kind: { type: "string", enum: [...CONTEXT_PACK_KINDS], description: "Optional context-pack kind" }
        },
        required: ["jobId"]
      },
      prepareRequest(args = {}) {
        const id = requireJobId(args, "tracker_job_context_pack");
        if (id.error) return id;
        const kind = nonEmptyString(args.kind);
        if (kind && !CONTEXT_PACK_KINDS.has(kind)) {
          return { error: `tracker_job_context_pack requires kind to be one of: ${[...CONTEXT_PACK_KINDS].join(", ")}.` };
        }
        const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
        return {
          workspace,
          portFlag,
          method: "GET",
          path: `/api/jobs/${id.jobId}/context-pack${query}`,
          label: "tracker_job_context_pack"
        };
      }
    }),
    createJobTool({
      name: "tracker_job_skill_plan",
      description: "Fetch a job skill plan from the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" }
        },
        required: ["jobId"]
      },
      prepareRequest(args = {}) {
        const id = requireJobId(args, "tracker_job_skill_plan");
        if (id.error) return id;
        return {
          workspace,
          portFlag,
          method: "GET",
          path: `/api/jobs/${id.jobId}/skill-plan`,
          label: "tracker_job_skill_plan"
        };
      }
    }),
    createJobTool({
      name: "tracker_job_verify_pack",
      description: "Fetch a job verify pack and gate-enriched verify items from the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" }
        },
        required: ["jobId"]
      },
      prepareRequest(args = {}) {
        const id = requireJobId(args, "tracker_job_verify_pack");
        if (id.error) return id;
        return {
          workspace,
          portFlag,
          method: "GET",
          path: `/api/jobs/${id.jobId}/verify-pack`,
          label: "tracker_job_verify_pack"
        };
      }
    }),
    createJobTool({
      name: "tracker_job_verify_run",
      description: "Run a command verify item through the running hub and emit verify.command.* evidence.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          itemId: { type: "string", description: "Verify item id" },
          sessionToken: mcpSessionTokenProperty,
          idempotencyKey: optionalStringProperty("Optional idempotency key")
        },
        required: ["jobId", "itemId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const id = requireJobId(args, "tracker_job_verify_run");
        if (id.error) return id;
        const item = requireVerifyItemId(args, "tracker_job_verify_run");
        if (item.error) return item;
        const token = requireMcpSessionToken(args, "tracker_job_verify_run");
        if (token.error) return token;
        const body = { source: "mcp" };
        addOptionalString(body, args, "idempotencyKey");
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/jobs/${id.jobId}/verify-pack/items/${encodePathPart(item.itemId)}/run`,
          label: "tracker_job_verify_run",
          body,
          headers: mcpSessionTokenHeaders(token.sessionToken),
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createJobTool({
      name: "tracker_job_verify_resolve",
      description: "Resolve a human_approval or dod_check verify item through the running hub.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          itemId: { type: "string", description: "Verify item id" },
          sessionToken: mcpSessionTokenProperty,
          status: {
            type: "string",
            enum: [...VERIFY_RESOLVE_STATUSES],
            description: "Optional explicit verify status"
          },
          approved: { type: "boolean", description: "Human approval boolean" },
          satisfied: { type: "boolean", description: "DoD check boolean" },
          reason: optionalStringProperty("Optional resolve reason"),
          summary: optionalStringProperty("Optional resolve summary"),
          user: optionalStringProperty("Optional resolving user"),
          idempotencyKey: optionalStringProperty("Optional idempotency key")
        },
        required: ["jobId", "itemId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const id = requireJobId(args, "tracker_job_verify_resolve");
        if (id.error) return id;
        const item = requireVerifyItemId(args, "tracker_job_verify_resolve");
        if (item.error) return item;
        const token = requireMcpSessionToken(args, "tracker_job_verify_resolve");
        if (token.error) return token;
        const body = { source: "mcp" };
        const status = nonEmptyString(args.status);
        if (status) {
          if (!VERIFY_RESOLVE_STATUSES.has(status)) {
            return { error: `tracker_job_verify_resolve requires status to be one of: ${[...VERIFY_RESOLVE_STATUSES].join(", ")}.` };
          }
          body.status = status;
        }
        if (args.approved !== undefined) {
          if (typeof args.approved !== "boolean") return { error: "tracker_job_verify_resolve requires approved to be boolean when present." };
          body.approved = args.approved;
        }
        if (args.satisfied !== undefined) {
          if (typeof args.satisfied !== "boolean") return { error: "tracker_job_verify_resolve requires satisfied to be boolean when present." };
          body.satisfied = args.satisfied;
        }
        for (const field of ["reason", "summary", "user", "idempotencyKey"]) addOptionalString(body, args, field);
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/jobs/${id.jobId}/verify-pack/items/${encodePathPart(item.itemId)}/resolve`,
          label: "tracker_job_verify_resolve",
          body,
          headers: mcpSessionTokenHeaders(token.sessionToken),
          jsonRpcErrorOnFailure: true
        };
      }
    })
  ];
}
