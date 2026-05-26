// hub/sessions/auth/mcp-token.js — SH-6-06
//
// Shared MCP-side token helpers. HTTP validation lives in
// hub/api/middleware/session-token.js; these helpers make SDK tool schemas and
// handlers require the matching `sessionToken` argument before they call the
// hub mutation endpoints.

export const MCP_SESSION_TOKEN_HEADER = "X-LT-Session-Token";

export const mcpSessionTokenProperty = Object.freeze({
  type: "string",
  description: "Session-scoped token. MCP clients pass this as `sessionToken`; the hub receives it as X-LT-Session-Token."
});

export function mcpSessionTokenHeaders(sessionToken) {
  const token = nonEmptyString(sessionToken);
  return token ? { [MCP_SESSION_TOKEN_HEADER]: token } : undefined;
}

export function requireMcpSessionToken(args, toolName) {
  const sessionToken = nonEmptyString(args?.sessionToken);
  if (!sessionToken) return { error: `${toolName} requires sessionToken.` };
  return { sessionToken };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
