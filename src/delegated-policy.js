// src/delegated-policy.js
//
// Deterministic delegated preapproval policy model for the future Guardrail
// MCP server. This module defines the contract shape only; it does not execute
// commands and does not grant sandbox privileges.

import { createHash } from "node:crypto";

export const DELEGATED_GRANT_SCHEMA_VERSION = 1;

export const DELEGATED_TOOL_NAMES = Object.freeze([
  "guardrail.recipe.run",
  "guardrail.service.status",
  "guardrail.service.start",
  "guardrail.service.stop",
  "guardrail.http.loopback",
  "guardrail.git.status",
  "guardrail.git.diff",
  "guardrail.git.log",
  "guardrail.git.push",
]);

export const HUMAN_APPROVAL_REQUIRED_FOR = Object.freeze([
  "remote_egress",
  "destructive_filesystem",
  "dependency_install",
  "raw_git_guardrail_change",
  "secret_material_access",
  "grant_widening",
  "policy_file_write",
  "unbounded_shell",
]);

export const DELEGATED_GRANT_SCHEMA = deepFreeze({
  $id: "https://llm-tracker.local/schemas/delegated-grant.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "grantId",
    "subject",
    "scope",
    "toolGrants",
    "expiresAt",
    "audit",
    "threatBoundary",
  ],
  properties: {
    schemaVersion: { const: DELEGATED_GRANT_SCHEMA_VERSION },
    grantId: { type: "string", pattern: "^grant_[a-z0-9][a-z0-9._-]{2,127}$" },
    subject: {
      type: "object",
      additionalProperties: false,
      required: ["agentKind", "agentId"],
      properties: {
        agentKind: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
      },
    },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["repoRoots"],
      properties: {
        repoRoots: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        worktreeRoots: { type: "array", items: { type: "string", minLength: 1 } },
        projectSlugs: { type: "array", items: { type: "string", minLength: 1 } },
        branchPatterns: { type: "array", items: { type: "string", minLength: 1 } },
        cwdAllowlist: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    toolGrants: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toolName", "parameterSchema"],
        properties: {
          toolName: { enum: DELEGATED_TOOL_NAMES },
          parameterSchema: { type: "object" },
          maxCalls: { type: "integer", minimum: 1 },
          requiresDryRun: { type: "boolean" },
          network: { enum: ["none", "loopback"] },
        },
      },
    },
    expiresAt: { type: "string", format: "date-time" },
    audit: {
      type: "object",
      additionalProperties: false,
      required: ["approvedBy", "approvedAt", "evidenceRef", "logLevel"],
      properties: {
        approvedBy: { type: "string", minLength: 1 },
        approvedAt: { type: "string", format: "date-time" },
        evidenceRef: { type: "string", minLength: 1 },
        logLevel: { enum: ["decision", "call", "call_and_payload_hash"] },
        requireRawCommand: { type: "boolean" },
        requireResultDigest: { type: "boolean" },
      },
    },
    threatBoundary: {
      type: "object",
      additionalProperties: false,
      required: ["enforcement", "sandboxGuarantee", "mustStopFor"],
      properties: {
        enforcement: { const: "contract_only" },
        sandboxGuarantee: { const: false },
        mustStopFor: { type: "array", items: { enum: HUMAN_APPROVAL_REQUIRED_FOR } },
      },
    },
  },
});

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function hashDelegatedGrant(grant) {
  return createHash("sha256").update(canonicalJson(grant)).digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortValue(value[key]);
  }
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}
