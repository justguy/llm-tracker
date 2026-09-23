import { pathToFileURL } from "node:url";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

export function renderMcpSessionContract({ sessionId, jobId } = {}) {
  const sid = nonEmpty(sessionId);
  const jid = nonEmpty(jobId);
  const attachedLine = jid
    ? `You are attached to llm-tracker session ${sid} and job ${jid}.`
    : `You are attached to llm-tracker session ${sid}.`;
  return [
    attachedLine,
    "Use these tools:",
    "- tracker_session_heartbeat every 5 minutes",
    "- tracker_job_checkpoint after meaningful progress",
    "- tracker_session_blocked when blocked",
    "- tracker_session_context_usage if your runtime can measure context",
    "- tracker_skill_run_complete when a required skill is complete",
    "- tracker_session_handoff before stopping or rolling over",
    "",
    "Do not mark complete until verify gates are satisfied.",
  ].join("\n");
}

export function runSessionContractCommand({ argv = process.argv.slice(2), stdout = process.stdout } = {}) {
  const flags = parseFlags(argv);
  stdout.write(renderMcpSessionContract({
    sessionId: flags.sessionId,
    jobId: flags.jobId,
  }) + "\n");
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--session-id") {
      flags.sessionId = argv[++i] || "";
    } else if (arg === "--job-id") {
      flags.jobId = argv[++i] || "";
    }
  }
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSessionContractCommand();
}
