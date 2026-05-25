import { httpRequest } from "./workspace-client.js";
import { loadProjectEntry } from "../hub/project-loader.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export function clampInt(value, { fallback, min, max }) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function makeTextResult(text, { isError = false } = {}) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    isError
  };
}

export function makeJsonResult(value, { isError = false } = {}) {
  return makeTextResult(JSON.stringify(value, null, 2), { isError });
}

export function loadReadableEntry(workspace, slug) {
  const entry = loadProjectEntry(workspace, slug);
  if (!entry.ok) {
    return {
      ok: false,
      result: makeTextResult(
        `Failed to load project "${slug}" from ${entry.path}: ${entry.message}`,
        { isError: true }
      )
    };
  }
  return { ok: true, entry };
}

export async function readToolPayload(getter, workspace, slug, extra = {}) {
  const loaded = loadReadableEntry(workspace, slug);
  if (!loaded.ok) return loaded.result;

  const payload = await getter({
    workspace,
    slug,
    entry: loaded.entry,
    ...extra
  });

  if (payload?.ok === false) {
    return makeTextResult(payload.message || `${slug}: request failed`, { isError: true });
  }
  if (!payload) {
    return makeTextResult(`Project "${slug}" is not available.`, { isError: true });
  }

  return makeJsonResult(payload.payload || payload);
}

export async function runHubMutation({
  workspace,
  portFlag,
  method,
  path,
  label,
  body,
  headers,
  jsonRpcErrorOnFailure = false
}) {
  const response = await httpRequest(workspace, portFlag, method, path, body, { headers });
  if (response.status === 0) {
    if (jsonRpcErrorOnFailure) {
      throw new McpError(
        ErrorCode.InternalError,
        `Hub not reachable at ${response.url}. Start the hub or daemon before calling ${label}.`,
        { status: response.status, url: response.url, body: response.body }
      );
    }
    return makeTextResult(
      `Hub not reachable at ${response.url}. Start the hub or daemon before calling ${label}.`,
      { isError: true }
    );
  }
  if (response.status >= 400) {
    if (jsonRpcErrorOnFailure) {
      throw new McpError(
        response.status === 401 ? ErrorCode.InvalidParams : ErrorCode.InternalError,
        `${label} failed (${response.status}): ${formatHubError(response.body)}`,
        { status: response.status, body: response.body }
      );
    }
    return makeTextResult(
      `${label} failed (${response.status}): ${formatHubError(response.body)}`,
      { isError: true }
    );
  }
  return makeJsonResult(response.body);
}

function formatHubError(body) {
  if (!body || typeof body !== "object") return String(body);
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object") {
    const code = typeof body.error.code === "string" ? `${body.error.code}: ` : "";
    const message =
      typeof body.error.message === "string"
        ? body.error.message
        : JSON.stringify(body.error);
    return `${code}${message}`;
  }
  if (typeof body.raw === "string") return body.raw;
  return JSON.stringify(body);
}
