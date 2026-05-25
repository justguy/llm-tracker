import assert from "node:assert/strict";

function cliOutput(result) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || `exit status ${result.status}`;
}

async function waitForOk(url, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
      lastError = new Error(`${url} returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastError?.message ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for ${url}${detail}`);
}

export async function waitForProject(port, slug, options = {}) {
  return waitForOk(`http://127.0.0.1:${port}/api/projects/${slug}`, options);
}

export async function waitForHelp(port, options = {}) {
  return waitForOk(`http://127.0.0.1:${port}/help`, options);
}

export async function startDaemonAndWait(
  runCli,
  { workspace, port, projectSlug, options, timeoutMs = 5000, intervalMs = 100 } = {}
) {
  const started = runCli(["--path", workspace, "--port", String(port), "--daemon"], options);
  let readinessError = null;

  try {
    if (projectSlug) {
      await waitForProject(port, projectSlug, { timeoutMs, intervalMs });
    } else {
      await waitForHelp(port, { timeoutMs, intervalMs });
    }
  } catch (err) {
    readinessError = err;
  }

  if (started.status !== 0 && readinessError) {
    assert.equal(started.status, 0, `${cliOutput(started)}\n${readinessError.message}`);
  }
  if (readinessError) throw readinessError;

  return started;
}
