import { httpRequest } from "./workspace-client.js";
import { loadProjectEntry } from "../hub/project-loader.js";

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

export async function runHubMutation({ workspace, portFlag, method, path, label, body }) {
  const response = await httpRequest(workspace, portFlag, method, path, body);
  if (response.status === 0) {
    return makeTextResult(
      `Hub not reachable at ${response.url}. Start the hub or daemon before calling ${label}.`,
      { isError: true }
    );
  }
  if (response.status >= 400) {
    return makeTextResult(
      `${label} failed (${response.status}): ${response.body.error || response.body.raw}`,
      { isError: true }
    );
  }
  return makeJsonResult(response.body);
}
