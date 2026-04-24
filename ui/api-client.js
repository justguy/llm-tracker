export function projectApiUrl(slug, suffix = "") {
  const base = `/api/projects/${encodeURIComponent(slug)}`;
  return suffix ? `${base}/${suffix}` : base;
}

export function fuzzySearchUrl(slug, query, limit = 12) {
  return `${projectApiUrl(slug, "fuzzy-search")}?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`;
}

export async function parseJsonBody(response) {
  return response.json().catch(() => ({}));
}

export async function postProjectJson(slug, suffix, body) {
  const options = { method: "POST" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(projectApiUrl(slug, suffix), options);
  return { response, body: await parseJsonBody(response) };
}

export async function patchProject(slug, body) {
  return postProjectJson(slug, "patch", body);
}

export async function deleteProject(slug) {
  const response = await fetch(projectApiUrl(slug), { method: "DELETE" });
  return { response, body: await parseJsonBody(response) };
}

export async function deleteTask(url) {
  const response = await fetch(url, { method: "DELETE" });
  return { response, body: await parseJsonBody(response) };
}

export async function fetchFuzzySearch(slug, query, { signal, limit = 12 } = {}) {
  const response = await fetch(fuzzySearchUrl(slug, query, limit), { signal });
  const body = await parseJsonBody(response);
  if (!response.ok) throw new Error(body.error || response.statusText || "request failed");
  return body;
}

export async function fetchWorkspace() {
  const response = await fetch("/api/workspace");
  return response.json();
}
