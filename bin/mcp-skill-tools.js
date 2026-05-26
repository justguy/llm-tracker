import { runHubMutation, nonEmptyString, makeTextResult } from "./mcp-utils.js";
import {
  mcpSessionTokenHeaders,
  mcpSessionTokenProperty,
  requireMcpSessionToken
} from "../hub/sessions/auth/mcp-token.js";

const JOB_ID_RE = /^job_[0-9a-hjkmnp-tv-z]{26}$/;
const SKILL_RUN_ID_RE = /^skr_[0-9a-hjkmnp-tv-z]{26}$/;
const FINISH_STATUSES = new Set(["succeeded", "failed", "skipped"]);

function optionalStringProperty(description) {
  return { type: "string", description };
}

function requireJobId(args, toolName) {
  const jobId = nonEmptyString(args.jobId);
  if (!jobId) return { error: `${toolName} requires jobId.` };
  if (!JOB_ID_RE.test(jobId)) return { error: `${toolName} requires a canonical job_ id.` };
  return { jobId };
}

function requireSkillRunId(args, toolName) {
  const skillRunId = nonEmptyString(args.skillRunId);
  if (!skillRunId) return { error: `${toolName} requires skillRunId.` };
  if (!SKILL_RUN_ID_RE.test(skillRunId)) return { error: `${toolName} requires a canonical skr_ skill run id.` };
  return { skillRunId };
}

function createSkillTool(definition) {
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

function addEvidence(body, args) {
  if (Array.isArray(args.evidence)) body.evidence = args.evidence;
}

function prepareSkillRunFinish(args, toolName, status) {
  const job = requireJobId(args, toolName);
  if (job.error) return job;
  const run = requireSkillRunId(args, toolName);
  if (run.error) return run;
  const token = requireMcpSessionToken(args, toolName);
  if (token.error) return token;
  if (!FINISH_STATUSES.has(status)) return { error: `${toolName} has invalid fixed status ${status}.` };

  const body = { status, source: "mcp" };
  addOptionalString(body, args, "skillId");
  addOptionalString(body, args, "sessionId");
  addOptionalString(body, args, "summary");
  addEvidence(body, args);
  return {
    jobId: job.jobId,
    skillRunId: run.skillRunId,
    body,
    headers: mcpSessionTokenHeaders(token.sessionToken)
  };
}

export function createSkillTools(workspace, portFlag) {
  return [
    createSkillTool({
      name: "tracker_skills_list",
      description: "List registered Session Hub workflow skills from the running hub.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      prepareRequest() {
        return {
          workspace,
          portFlag,
          method: "GET",
          path: "/api/skills",
          label: "tracker_skills_list"
        };
      }
    }),
    createSkillTool({
      name: "tracker_job_profiles",
      description: "List built-in Session Hub job profiles from the running hub.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      prepareRequest() {
        return {
          workspace,
          portFlag,
          method: "GET",
          path: "/api/job-profiles",
          label: "tracker_job_profiles"
        };
      }
    }),
    createSkillTool({
      name: "tracker_skill_run_start",
      description: "Start a structured skill run for a job. Raw stdio text cannot start or satisfy a skill run.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          sessionToken: mcpSessionTokenProperty,
          skillId: { type: "string", description: "Registered skill id" },
          sessionId: optionalStringProperty("Optional session id; must match the job session when supplied"),
          summary: optionalStringProperty("Optional start summary"),
          evidence: { type: "array", description: "Optional structured evidence refs", items: { type: "object" } }
        },
        required: ["jobId", "sessionToken", "skillId"]
      },
      prepareRequest(args = {}) {
        const job = requireJobId(args, "tracker_skill_run_start");
        if (job.error) return job;
        const token = requireMcpSessionToken(args, "tracker_skill_run_start");
        if (token.error) return token;
        const skillId = nonEmptyString(args.skillId);
        if (!skillId) return { error: "tracker_skill_run_start requires skillId." };
        const body = { skillId, source: "mcp" };
        addOptionalString(body, args, "sessionId");
        addOptionalString(body, args, "summary");
        addEvidence(body, args);
        return {
          workspace,
          portFlag,
          method: "POST",
          path: `/api/jobs/${job.jobId}/skill-runs`,
          label: "tracker_skill_run_start",
          body,
          headers: mcpSessionTokenHeaders(token.sessionToken),
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createSkillTool({
      name: "tracker_skill_run_complete",
      description: "Finish a structured skill run as succeeded. This emits skill.run.finished evidence; raw stdio text is ignored.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          skillRunId: { type: "string", description: "Runtime skill run id" },
          sessionToken: mcpSessionTokenProperty,
          skillId: optionalStringProperty("Optional skill id when the run was not previously started"),
          sessionId: optionalStringProperty("Optional session id; must match the job session when supplied"),
          summary: optionalStringProperty("Completion summary"),
          evidence: { type: "array", description: "Optional structured evidence refs", items: { type: "object" } }
        },
        required: ["jobId", "skillRunId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const prepared = prepareSkillRunFinish(args, "tracker_skill_run_complete", "succeeded");
        if (prepared.error) return prepared;
        return {
          workspace,
          portFlag,
          method: "PATCH",
          path: `/api/jobs/${prepared.jobId}/skill-runs/${prepared.skillRunId}`,
          label: "tracker_skill_run_complete",
          body: prepared.body,
          headers: prepared.headers,
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createSkillTool({
      name: "tracker_skill_run_skip",
      description: "Finish a structured skill run as skipped. Skipping a required skill does not satisfy its gate.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          skillRunId: { type: "string", description: "Runtime skill run id" },
          sessionToken: mcpSessionTokenProperty,
          skillId: optionalStringProperty("Optional skill id when the run was not previously started"),
          sessionId: optionalStringProperty("Optional session id; must match the job session when supplied"),
          summary: optionalStringProperty("Skip summary"),
          evidence: { type: "array", description: "Optional structured evidence refs", items: { type: "object" } }
        },
        required: ["jobId", "skillRunId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const prepared = prepareSkillRunFinish(args, "tracker_skill_run_skip", "skipped");
        if (prepared.error) return prepared;
        return {
          workspace,
          portFlag,
          method: "PATCH",
          path: `/api/jobs/${prepared.jobId}/skill-runs/${prepared.skillRunId}`,
          label: "tracker_skill_run_skip",
          body: prepared.body,
          headers: prepared.headers,
          jsonRpcErrorOnFailure: true
        };
      }
    }),
    createSkillTool({
      name: "tracker_skill_run_fail",
      description: "Finish a structured skill run as failed.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Runtime job id" },
          skillRunId: { type: "string", description: "Runtime skill run id" },
          sessionToken: mcpSessionTokenProperty,
          skillId: optionalStringProperty("Optional skill id when the run was not previously started"),
          sessionId: optionalStringProperty("Optional session id; must match the job session when supplied"),
          summary: optionalStringProperty("Failure summary"),
          evidence: { type: "array", description: "Optional structured evidence refs", items: { type: "object" } }
        },
        required: ["jobId", "skillRunId", "sessionToken"]
      },
      prepareRequest(args = {}) {
        const prepared = prepareSkillRunFinish(args, "tracker_skill_run_fail", "failed");
        if (prepared.error) return prepared;
        return {
          workspace,
          portFlag,
          method: "PATCH",
          path: `/api/jobs/${prepared.jobId}/skill-runs/${prepared.skillRunId}`,
          label: "tracker_skill_run_fail",
          body: prepared.body,
          headers: prepared.headers,
          jsonRpcErrorOnFailure: true
        };
      }
    })
  ];
}
