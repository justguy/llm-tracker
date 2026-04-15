export function parseLimit(value, { fallback = 5, min = 1, max = 5 } = {}) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

export function ensureHubResponse(status, body, label) {
  if (status === 0) {
    console.error("Hub not reachable. Start it with 'llm-tracker' or 'llm-tracker --daemon'.");
    process.exit(1);
  }
  if (status >= 400) {
    console.error(`${label} failed (${status}): ${body.error || body.raw}`);
    process.exit(1);
  }
}
